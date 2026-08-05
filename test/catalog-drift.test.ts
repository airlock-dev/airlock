/**
 * Tests for tool-catalog drift detection: the per-provider contract fingerprint and the two
 * catalog-aware lint rules.
 *
 * The incident these exist for: a sidecar image sat 9 days behind its source. Config was valid, the
 * provider was healthy, mcpHealth was green — and agents were being served a tool whose parameters
 * had silently vanished, plus a tool in source that nothing exposed. Drift lives in the gap between
 * what a provider offers and what policy names, and nothing was looking at that gap.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../src/registry/registry.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import { lintCatalog, type LiveCatalog } from '../src/introspect/cli.js';
import { GatewayConfig } from '../src/config/schema.js';
import type { BackendAdapter } from '../src/backend/types.js';

function tool(name: string, description = 'does a thing', schema: unknown = {}): Tool {
  return { name, description, inputSchema: schema as Tool['inputSchema'] };
}

/** A minimal adapter that just serves a fixed tool list under `mcp:<provider>`. */
function adapter(providerId: string, tools: Tool[]): BackendAdapter {
  return {
    id: `mcp:${providerId}`,
    listTools: async () => tools,
    callTool: async () => ({ content: [] }),
  } as unknown as BackendAdapter;
}

async function fingerprintFor(providerId: string, tools: Tool[]): Promise<string> {
  const registry = new ToolRegistry([adapter(providerId, tools)], new AllowlistEngine({}), {});
  await registry.refresh();
  return registry.getCatalogSummary()[providerId].fingerprint;
}

describe('provider catalog fingerprint', () => {
  it('reports a count and a sha256 fingerprint per provider', async () => {
    const registry = new ToolRegistry(
      [adapter('clique', [tool('clique/a'), tool('clique/b')]), adapter('linear', [tool('linear/x')])],
      new AllowlistEngine({}),
      {}
    );
    await registry.refresh();

    const summary = registry.getCatalogSummary();
    expect(summary.clique.count).toBe(2);
    expect(summary.linear.count).toBe(1);
    expect(summary.clique.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(summary.clique.fingerprint).not.toBe(summary.linear.fingerprint);
  });

  it('is stable across refreshes when nothing changed', async () => {
    const tools = [tool('clique/a'), tool('clique/b')];
    expect(await fingerprintFor('clique', tools)).toBe(await fingerprintFor('clique', tools));
  });

  it('ignores the order a provider happens to list tools in', async () => {
    // Otherwise a reconnect could look like drift, and the signal would be worthless.
    const forward = await fingerprintFor('clique', [tool('clique/a'), tool('clique/b')]);
    const reversed = await fingerprintFor('clique', [tool('clique/b'), tool('clique/a')]);
    expect(forward).toBe(reversed);
  });

  it('ignores JSON key order inside an input schema', async () => {
    const a = await fingerprintFor('clique', [
      tool('clique/a', 'd', { type: 'object', properties: { x: { type: 'string' } } }),
    ]);
    const b = await fingerprintFor('clique', [
      tool('clique/a', 'd', { properties: { x: { type: 'string' } }, type: 'object' }),
    ]);
    expect(a).toBe(b);
  });

  it('changes when a description changes but names do not', async () => {
    // The case that actually bit us: same tool list, different instructions to the agent.
    const before = await fingerprintFor('clique', [tool('clique/a', 'old guidance')]);
    const after = await fingerprintFor('clique', [tool('clique/a', 'new guidance')]);
    expect(after).not.toBe(before);
  });

  it('changes when a parameter disappears', async () => {
    const before = await fingerprintFor('clique', [
      tool('clique/add', 'd', { type: 'object', properties: { a: {}, since: {} } }),
    ]);
    const after = await fingerprintFor('clique', [
      tool('clique/add', 'd', { type: 'object', properties: { a: {} } }),
    ]);
    expect(after).not.toBe(before);
  });

  it('changes when a tool appears', async () => {
    const before = await fingerprintFor('clique', [tool('clique/a')]);
    const after = await fingerprintFor('clique', [tool('clique/a'), tool('clique/set_attribute')]);
    expect(after).not.toBe(before);
  });

  it('is empty before the first refresh rather than throwing', () => {
    const registry = new ToolRegistry([], new AllowlistEngine({}), {});
    expect(registry.getCatalogSummary()).toEqual({});
  });
});

function configWith(agents: Record<string, { allow?: string[]; ask?: string[] }>) {
  return GatewayConfig.parse({
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, perms]) => [name, { token: 't', ...perms }])
    ),
  });
}

function catalogOf(entries: Record<string, string[]>): LiveCatalog {
  return new Map(Object.entries(entries).map(([provider, names]) => [provider, new Set(names)]));
}

describe('lintCatalog', () => {
  it('flags a served tool no agent can reach', () => {
    const findings = lintCatalog(
      configWith({ helena: { allow: ['clique/find_person'] } }),
      catalogOf({ clique: ['clique/find_person', 'clique/set_attribute'] })
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('unallocated-tool');
    expect(findings[0].message).toContain('clique/set_attribute');
  });

  it('counts an ask grant as reachable', () => {
    const findings = lintCatalog(
      configWith({ helena: { ask: ['clique/set_attribute'] } }),
      catalogOf({ clique: ['clique/set_attribute'] })
    );
    expect(findings).toHaveLength(0);
  });

  it('counts a wildcard grant as reachable', () => {
    const findings = lintCatalog(
      configWith({ helena: { allow: ['clique/*'] } }),
      catalogOf({ clique: ['clique/a', 'clique/b'] })
    );
    expect(findings).toHaveLength(0);
  });

  it('flags a grant naming a tool the provider does not serve', () => {
    const findings = lintCatalog(
      configWith({ helena: { allow: ['clique/find_person', 'clique/renamed_away'] } }),
      catalogOf({ clique: ['clique/find_person'] })
    );

    const dead = findings.filter((f) => f.rule === 'dead-allow');
    expect(dead).toHaveLength(1);
    expect(dead[0].agent).toBe('helena');
    expect(dead[0].message).toContain('clique/renamed_away');
  });

  it('says nothing about a provider missing from the catalog', () => {
    // A provider that failed to connect must not have its whole grant surface reported as dead —
    // that false alarm is exactly what trains people to ignore a linter.
    const findings = lintCatalog(
      configWith({ helena: { allow: ['clique/find_person', 'linear/get_issue'] } }),
      catalogOf({ clique: ['clique/find_person'] })
    );
    expect(findings.filter((f) => f.rule === 'dead-allow')).toHaveLength(0);
  });

  it('does not call a wildcard dead', () => {
    // A pattern matching nothing today may match tomorrow's tool; that is what wildcards are for.
    const findings = lintCatalog(
      configWith({ helena: { allow: ['clique/nonexistent_*'] } }),
      catalogOf({ clique: ['clique/find_person'] })
    );
    expect(findings.filter((f) => f.rule === 'dead-allow')).toHaveLength(0);
  });

  it('reports a dead grant once per agent, not once per occurrence', () => {
    const findings = lintCatalog(
      configWith({
        helena: { allow: ['clique/gone'], ask: ['clique/gone'] },
        selene: { allow: ['clique/gone'] },
      }),
      catalogOf({ clique: ['clique/find_person'] })
    );

    const dead = findings.filter((f) => f.rule === 'dead-allow');
    expect(dead).toHaveLength(2);
    expect(dead.map((f) => f.agent).sort()).toEqual(['helena', 'selene']);
  });

  it('finds both drift directions at once', () => {
    const findings = lintCatalog(
      configWith({ helena: { allow: ['clique/gone'] } }),
      catalogOf({ clique: ['clique/arrived'] })
    );
    expect(findings.map((f) => f.rule).sort()).toEqual(['dead-allow', 'unallocated-tool']);
  });

  it('is silent on an empty catalog', () => {
    const findings = lintCatalog(configWith({ helena: { allow: ['clique/a'] } }), catalogOf({}));
    expect(findings).toEqual([]);
  });
});
