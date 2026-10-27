import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import type { BackendAdapter } from '../src/backend/types.js';
import type { AgentConfig } from '../src/config/schema.js';
import { ToolRegistry } from '../src/registry/registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tool(name: string): Tool {
  return { name, description: 'Read-only test tool', inputSchema: { type: 'object' } };
}

function adapter(id: string): BackendAdapter {
  return {
    id: `mcp:${id}`,
    listTools: vi.fn().mockResolvedValue([tool(`${id}/read`)]),
    instructions: vi.fn().mockReturnValue('Current provider instructions'),
    call: vi.fn(),
    stop: vi.fn(),
  };
}

function registryFor(adapters: BackendAdapter[]): ToolRegistry {
  const agents: Record<string, AgentConfig> = {
    reader: {
      allow: ['*'],
      ask: [],
      deny: [],
      tool_overrides: {},
      exec: { allow: [], ask: [], deny: [], env: {}, default_timeout_ms: 30000 },
      http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
    },
  };
  return new ToolRegistry(adapters, new AllowlistEngine(agents), agents);
}

describe('overlapping registry refreshes', () => {
  it('keeps a recovered provider when an older refresh finishes without it', async () => {
    const kb = adapter('knowledgebase');
    vi.mocked(kb.listTools).mockRejectedValueOnce(new Error('Session not found'));
    vi.mocked(kb.instructions!).mockReturnValueOnce('Stale provider instructions');
    const slow = adapter('slow');
    const reachedSlow = deferred<void>();
    const releaseOld = deferred<Tool[]>();
    vi.mocked(slow.listTools).mockImplementationOnce(() => {
      reachedSlow.resolve();
      return releaseOld.promise;
    });
    const registry = registryFor([kb, slow]);

    const older = registry.refresh();
    await reachedSlow.promise;
    await registry.refresh();
    const recoveredCatalog = registry.getCatalogSummary();
    const recoveredInstructions = registry.getInstructionsFor('reader');
    expect(recoveredCatalog.knowledgebase.count).toBe(1);
    expect(recoveredInstructions).toContain('Current provider instructions');
    expect(recoveredInstructions).not.toContain('Stale provider instructions');

    releaseOld.resolve([tool('slow/obsolete')]);
    await older;

    expect(registry.getAllTools().map((entry) => entry.name)).toEqual([
      'knowledgebase/read',
      'slow/read',
    ]);
    expect(registry.getCatalogSummary()).toEqual(recoveredCatalog);
    expect(registry.getInstructionsFor('reader')).toBe(recoveredInstructions);
  });

  it('does not resurrect tools when the newest refresh finds a provider unavailable', async () => {
    const kb = adapter('knowledgebase');
    const releaseOld = deferred<Tool[]>();
    vi.mocked(kb.listTools)
      .mockImplementationOnce(() => releaseOld.promise)
      .mockRejectedValueOnce(new Error('Provider disconnected'));
    const registry = registryFor([kb]);

    const older = registry.refresh();
    await registry.refresh();
    expect(registry.getAllTools()).toEqual([]);

    releaseOld.resolve([tool('knowledgebase/read')]);
    await older;

    expect(registry.getAllTools()).toEqual([]);
    expect(registry.getCatalogSummary()).toEqual({});
    expect(registry.getInstructionsFor('reader')).toBeUndefined();
  });

  it('keeps the replacement adapter catalog when a pre-reload refresh finishes later', async () => {
    const removed = adapter('removed');
    const releaseOld = deferred<Tool[]>();
    vi.mocked(removed.listTools).mockImplementationOnce(() => releaseOld.promise);
    const registry = registryFor([removed]);

    const older = registry.refresh();
    registry.setAdapters([adapter('replacement')]);
    await registry.refresh();
    const replacementCatalog = registry.getCatalogSummary();

    releaseOld.resolve([tool('removed/read')]);
    await older;

    expect(registry.getAllTools().map((entry) => entry.name)).toEqual(['replacement/read']);
    expect(registry.getCatalogSummary()).toEqual(replacementCatalog);
    expect(registry.getInstructionsFor('reader')).not.toContain('## removed');
  });
});
