#!/usr/bin/env tsx
/**
 * configure-agent — interactive TUI to build allow/ask/deny lists from live MCP tools.
 *
 * Usage:
 *   tsx scripts/configure-agent.ts --config ./airlock.yaml [--agent myagent]
 *
 * Connects to every provider in the config, lists their tools, and lets you
 * assign allow / ask / deny to each one. Defaults:
 *   - readOnlyHint: true  → allow
 *   - destructiveHint or openWorldHint: true → ask
 *   - no annotations → allow
 *
 * Press:
 *   j / ↓   next row (tools and provider headers)
 *   k / ↑   prev row
 *   a        allow  (on tool: that tool; on header: all tools in provider)
 *   s        ask    (same)
 *   d        deny   (same)
 *   enter    confirm & print YAML
 *   q        quit without output
 */

import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ClientPool } from '../src/pool/pool.js';
import { getMcpConfigs } from '../src/config/schema.js';
import type { GatewayConfig } from '../src/config/schema.js';

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c', default: './airlock.yaml' },
    agent: { type: 'string', short: 'a', default: 'agent' },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
configure-agent — build allow/ask/deny lists from live MCP tools

Usage:
  tsx scripts/configure-agent.ts [options]

Options:
  -c, --config <path>   Airlock config file (default: ./airlock.yaml)
  -a, --agent  <name>   Agent name to use in output (default: agent)
  -v, --verbose         Show MCP server output (default: suppressed)
  -h, --help            Show this help
`);
  process.exit(0);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Decision = 'allow' | 'ask' | 'deny';

interface ToolEntry {
  namespacedName: string;
  description: string;
  annotations: NonNullable<Tool['annotations']>;
  decision: Decision;
}

interface ServerInfo {
  name: string;
  version: string;
}

// ── Annotation helpers ────────────────────────────────────────────────────────

function defaultDecision(annotations: NonNullable<Tool['annotations']>): Decision {
  if (annotations.destructiveHint || annotations.openWorldHint) return 'ask';
  return 'allow';
}

function annotationBadges(a: NonNullable<Tool['annotations']>): string {
  const tags: string[] = [];
  if (a.readOnlyHint) tags.push('readonly');
  if (a.destructiveHint) tags.push('destructive');
  if (a.idempotentHint) tags.push('idempotent');
  if (a.openWorldHint) tags.push('open-world');
  return tags.length ? `[${tags.join(', ')}]` : '';
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;
const BLUE = `${ESC}34m`;

function decisionColor(d: Decision): string {
  if (d === 'allow') return GREEN;
  if (d === 'ask') return YELLOW;
  return RED;
}

function decisionLabel(d: Decision): string {
  if (d === 'allow') return 'allow';
  if (d === 'ask') return 'ask  ';
  return 'deny ';
}

// ── YAML output ───────────────────────────────────────────────────────────────

function renderYaml(agentName: string, entries: ToolEntry[]): string {
  const lines: string[] = [`agents:`, `  ${agentName}:`];

  const renderList = (key: string, decision: Decision) => {
    const matching = entries.filter((e) => e.decision === decision);
    if (matching.length === 0) {
      lines.push(`    ${key}: []`);
      return;
    }
    lines.push(`    ${key}:`);
    let lastProvider = '';
    for (const e of matching) {
      const p = e.namespacedName.split('/')[0]!;
      if (p !== lastProvider) {
        lines.push(`      # ${p}`);
        lastProvider = p;
      }
      lines.push(`      - "${e.namespacedName}"`);
    }
  };

  renderList('allow', 'allow');
  renderList('ask', 'ask');
  renderList('deny', 'deny');

  return lines.join('\n');
}

// ── TUI row model ─────────────────────────────────────────────────────────────

type Row =
  | {
      type: 'header';
      provider: string;
      serverInfo?: ServerInfo;
      total: number;
      allow: number;
      ask: number;
      deny: number;
    }
  | { type: 'entry'; entry: ToolEntry; entryIdx: number };

function buildRows(entries: ToolEntry[], serverInfoMap: Map<string, ServerInfo>): Row[] {
  const rows: Row[] = [];
  const providerOrder: string[] = [];
  const groups = new Map<string, number[]>();

  for (let i = 0; i < entries.length; i++) {
    const p = entries[i]!.namespacedName.split('/')[0]!;
    if (!groups.has(p)) {
      groups.set(p, []);
      providerOrder.push(p);
    }
    groups.get(p)!.push(i);
  }

  for (const p of providerOrder) {
    const indices = groups.get(p)!;
    const counts = { allow: 0, ask: 0, deny: 0 };
    for (const i of indices) counts[entries[i]!.decision]++;
    rows.push({
      type: 'header',
      provider: p,
      serverInfo: serverInfoMap.get(p),
      total: indices.length,
      ...counts,
    });
    for (const i of indices) rows.push({ type: 'entry', entry: entries[i]!, entryIdx: i });
  }

  return rows;
}

// ── TUI ───────────────────────────────────────────────────────────────────────

function render(
  entries: ToolEntry[],
  serverInfoMap: Map<string, ServerInfo>,
  rowIdx: number,
  agentName: string
): void {
  const out = process.stdout;
  out.write(`${ESC}H${ESC}2J`); // cursor home, then clear screen

  out.write(`\n${BOLD}${CYAN}  Airlock — Configure Agent: ${agentName}${RESET}\n`);
  out.write(`${DIM}  ${'─'.repeat(70)}${RESET}\n`);
  out.write(
    `${DIM}  [a] allow  [s] ask  [d] deny  [j/k] navigate  [enter] confirm  [q] quit${RESET}\n`
  );
  out.write(`${DIM}  on a provider header, a/s/d applies to all tools in that provider${RESET}\n`);
  out.write(`${DIM}  ${'─'.repeat(70)}${RESET}\n\n`);

  const rows = buildRows(entries, serverInfoMap);

  const visible = 28;
  const start = Math.max(0, Math.min(rowIdx - Math.floor(visible / 2), rows.length - visible));
  const slice = rows.slice(start, start + visible);

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i]!;
    const absIdx = start + i;
    const isSel = absIdx === rowIdx;

    if (row.type === 'header') {
      const summary = `${GREEN}${row.allow}✓${RESET} ${YELLOW}${row.ask}?${RESET} ${RED}${row.deny}✗${RESET}`;
      const selMark = isSel ? `${BOLD}${YELLOW}▸ ` : `  `;
      const nameStr = `${BOLD}${BLUE}${row.provider}${RESET}`;
      const serverStr = row.serverInfo
        ? `${DIM}${row.serverInfo.name} v${row.serverInfo.version}${RESET}`
        : '';
      out.write(
        `\n ${selMark}${nameStr}  ${DIM}(${row.total} tools)${RESET}  ${summary}${serverStr ? `  ${serverStr}` : ''}\n`
      );
      if (isSel) {
        out.write(
          `   ${DIM}↳ press a/s/d to set all ${row.total} tools in this provider${RESET}\n`
        );
      }
      out.write(`   ${DIM}${'╌'.repeat(55)}${RESET}\n`);
    } else {
      const { entry, entryIdx } = row;
      const isCurEntry = isSel;
      const dColor = decisionColor(entry.decision);
      const prefix = isCurEntry ? `${BOLD}${YELLOW} ▸ ` : `   `;
      const toolName = entry.namespacedName.split('/').slice(1).join('/');
      const namePart = `${isCurEntry ? BOLD : ''}${toolName}${RESET}`;
      const badge = annotationBadges(entry.annotations);
      const badgeColor = entry.annotations.destructiveHint
        ? RED
        : entry.annotations.openWorldHint
          ? YELLOW
          : entry.annotations.readOnlyHint
            ? GREEN
            : DIM;

      out.write(
        `${prefix}${dColor}[${decisionLabel(entry.decision)}]${RESET}  ${namePart}  ${badge ? `${badgeColor}${badge}${RESET}` : ''}\n`
      );

      if (isCurEntry && entry.description) {
        const desc =
          entry.description.length > 110
            ? entry.description.slice(0, 110) + '…'
            : entry.description;
        out.write(`       ${DIM}${desc}${RESET}\n`);
      }
      // suppress unused var warning
      void entryIdx;
    }
  }

  if (rows.length > visible) {
    const above = start;
    const below = rows.length - (start + visible);
    const parts: string[] = [];
    if (above > 0) parts.push(`↑ ${above} above`);
    if (below > 0) parts.push(`↓ ${below} below`);
    out.write(`\n${DIM}  ${parts.join('  ')}${RESET}\n`);
  }

  out.write(
    `\n${DIM}  ${entries.filter((e) => e.decision === 'allow').length} allow  ` +
      `${entries.filter((e) => e.decision === 'ask').length} ask  ` +
      `${entries.filter((e) => e.decision === 'deny').length} deny  ` +
      `/ ${entries.length} total${RESET}\n`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load config
  const raw = readFileSync(values.config!, 'utf8');
  const parsed = parseYaml(raw) as GatewayConfig;
  const providers = parsed.providers ?? {};
  const mcpConfigs = getMcpConfigs(providers);

  if (Object.keys(mcpConfigs).length === 0) {
    console.error('No MCP providers found in config.');
    process.exit(1);
  }

  process.stdout.write(`\nConnecting to ${Object.keys(mcpConfigs).length} provider(s)…\n`);

  const pool = new ClientPool(mcpConfigs, { stdioStderr: values.verbose ? 'inherit' : 'ignore' });
  const connectPromise = pool.initialize();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  await Promise.race([connectPromise, timeout]);

  const entries: ToolEntry[] = [];
  const serverInfoMap = new Map<string, ServerInfo>();

  for (const mcpId of Object.keys(mcpConfigs)) {
    process.stdout.write(`  ${mcpId}: `);
    try {
      const tools = await Promise.race([
        pool.listTools(mcpId),
        new Promise<Tool[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      const info = pool.getServerInfo(mcpId);
      if (info) serverInfoMap.set(mcpId, info);
      const infoStr = info ? `${DIM}${info.name} v${info.version}${RESET}  ` : '';
      process.stdout.write(`${infoStr}${GREEN}${tools.length} tools${RESET}\n`);
      for (const tool of tools) {
        const annotations = tool.annotations ?? {};
        entries.push({
          namespacedName: `${mcpId}/${tool.name}`,
          description: tool.description ?? '',
          annotations,
          decision: defaultDecision(annotations),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`${RED}failed (${msg})${RESET}\n`);
    }
  }

  if (entries.length === 0) {
    console.error('\nNo tools found. Check that your providers are reachable.');
    await pool.stop();
    process.exit(1);
  }

  process.stdout.write(`\n${BOLD}Found ${entries.length} tools.${RESET} Press any key to start…`);

  const { openSync } = await import('fs');
  const { ReadStream } = await import('tty');
  const ttyFd = openSync('/dev/tty', 'r+');
  const tty = new ReadStream(ttyFd);
  tty.setEncoding('utf8');

  await new Promise<void>((resolve) => {
    tty.setRawMode(true);
    tty.once('data', () => resolve());
    tty.resume();
  });

  // Enter alternate screen buffer (no scrollback pollution)
  process.stdout.write('\x1b[?1049h');

  // rowIdx is an index into buildRows(entries) — navigates both headers and entries
  let rowIdx = 0;
  let done = false;
  let quit = false;

  // Helper: get provider for a given row index
  function providerOfRow(rows: Row[], idx: number): string | undefined {
    const row = rows[idx];
    if (!row) return undefined;
    if (row.type === 'header') return row.provider;
    return row.entry.namespacedName.split('/')[0];
  }

  // Helper: apply decision to all entries in a provider
  function bulkSetProvider(provider: string, decision: Decision): void {
    for (const e of entries) {
      if (e.namespacedName.split('/')[0] === provider) e.decision = decision;
    }
  }

  render(entries, serverInfoMap, rowIdx, values.agent!);

  await new Promise<void>((resolve) => {
    tty.on('data', (key: string) => {
      if (done) return;

      if (key === '\x03' || key === 'q') {
        quit = true;
        done = true;
        process.stdout.write('\x1b[?1049l'); // exit alternate screen
        tty.setRawMode(false);
        tty.destroy();
        resolve();
        return;
      }

      if (key === '\r' || key === '\n') {
        done = true;
        process.stdout.write('\x1b[?1049l'); // exit alternate screen
        tty.setRawMode(false);
        tty.destroy();
        resolve();
        return;
      }

      const rows = buildRows(entries, serverInfoMap);
      const maxIdx = rows.length - 1;

      if (key === 'j' || key === `${ESC}B`) rowIdx = Math.min(rowIdx + 1, maxIdx);
      if (key === 'k' || key === `${ESC}A`) rowIdx = Math.max(rowIdx - 1, 0);

      const currentRow = rows[rowIdx];
      if (currentRow?.type === 'header') {
        // Bulk apply to entire provider
        if (key === 'a') bulkSetProvider(currentRow.provider, 'allow');
        if (key === 's') bulkSetProvider(currentRow.provider, 'ask');
        if (key === 'd') bulkSetProvider(currentRow.provider, 'deny');
      } else if (currentRow?.type === 'entry') {
        // Apply to single tool
        if (key === 'a') currentRow.entry.decision = 'allow';
        if (key === 's') currentRow.entry.decision = 'ask';
        if (key === 'd') currentRow.entry.decision = 'deny';
      }

      // Resolve rowIdx against the potentially stale provider for rebuildRows
      const provider = providerOfRow(rows, rowIdx);
      void provider; // used above

      render(entries, serverInfoMap, rowIdx, values.agent!);
    });
  });

  await pool.stop();

  if (quit) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log(`\n${BOLD}${CYAN}# Paste into your airlock.yaml:${RESET}\n`);
  console.log(renderYaml(values.agent!, entries));
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
