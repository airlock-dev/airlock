import { parseArgs } from 'util';
import { readFileSync, writeFileSync, copyFileSync, openSync } from 'fs';
import { ReadStream } from 'tty';
import { execSync } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ClientPool } from '../pool/pool.js';
import { getMcpConfigs, GatewayConfig } from '../config/schema.js';
import { checkSuspiciousPatterns, SUSPICIOUS_PATTERNS } from '../registry/sanitizer.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Decision = 'allow' | 'ask' | 'deny';

interface ToolEntry {
  namespacedName: string;
  description: string;
  annotations: NonNullable<Tool['annotations']>;
  decision: Decision;
  suspiciousPatterns: string[];
}

interface ServerInfo {
  name: string;
  version: string;
}

// ── Annotation helpers ────────────────────────────────────────────────────────

function defaultDecision(
  annotations: NonNullable<Tool['annotations']>,
  suspiciousPatterns?: string[]
): Decision {
  if (suspiciousPatterns && suspiciousPatterns.length > 0) return 'deny';
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
      const p = e.namespacedName.split('/')[0];
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

// ── Terminal measurement ──────────────────────────────────────────────────────

/** Strip ANSI escape sequences to get the visible character length. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** How many terminal rows a line occupies (accounts for wrapping). */
function terminalRows(line: string, termCols: number): number {
  const len = visibleLength(line);
  if (len === 0) return 1;
  return Math.ceil(len / termCols);
}

// ── Word wrap helper ──────────────────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(' ', width);
      if (breakAt <= 0) breakAt = width;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines;
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
    const p = entries[i].namespacedName.split('/')[0];
    if (!groups.has(p)) {
      groups.set(p, []);
      providerOrder.push(p);
    }
    groups.get(p)!.push(i);
  }

  for (const p of providerOrder) {
    const indices = groups.get(p)!;
    const counts = { allow: 0, ask: 0, deny: 0 };
    for (const i of indices) counts[entries[i].decision]++;
    rows.push({
      type: 'header',
      provider: p,
      serverInfo: serverInfoMap.get(p),
      total: indices.length,
      ...counts,
    });
    for (const i of indices) rows.push({ type: 'entry', entry: entries[i], entryIdx: i });
  }

  return rows;
}

// ── TUI ───────────────────────────────────────────────────────────────────────

function renderInspect(entry: ToolEntry, inspectScroll: number): void {
  const out = process.stdout;
  out.write(`${ESC}H${ESC}2J`);

  const dColor = decisionColor(entry.decision);
  out.write(`\n${BOLD}${CYAN}  Inspect: ${entry.namespacedName}${RESET}\n`);
  out.write(`${DIM}  ${'─'.repeat(70)}${RESET}\n`);
  out.write(`${DIM}  [j/k] scroll  [i/esc] back  [a] allow  [s] ask  [d] deny${RESET}\n`);
  out.write(`${DIM}  ${'─'.repeat(70)}${RESET}\n\n`);

  // Status line
  const badge = annotationBadges(entry.annotations);
  out.write(
    `  ${dColor}${BOLD}${decisionLabel(entry.decision).trim()}${RESET}  ${badge ? `${DIM}${badge}${RESET}  ` : ''}`
  );
  if (entry.suspiciousPatterns.length > 0) {
    out.write(`${RED}⚠ injection${RESET}`);
  }
  out.write('\n\n');

  // Build wrapped + highlighted lines
  const wrapped = wordWrap(entry.description || '(no description)', 72);
  const lines: string[] = [];
  for (const line of wrapped) {
    let highlighted = line;
    for (const pattern of SUSPICIOUS_PATTERNS) {
      highlighted = highlighted.replace(pattern, (match) => `${RED}${BOLD}${match}${RESET}${DIM}`);
    }
    lines.push(highlighted);
  }

  // Scrollable viewport — reserve lines for header (7) and footer (3)
  const termRows = process.stdout.rows || 40;
  const viewportHeight = termRows - 10;
  const maxScroll = Math.max(0, lines.length - viewportHeight);
  const scroll = Math.min(inspectScroll, maxScroll);
  const visible = lines.slice(scroll, scroll + viewportHeight);

  for (const line of visible) {
    out.write(`  ${DIM}${line}${RESET}\n`);
  }

  // Scroll indicator
  if (lines.length > viewportHeight) {
    const parts: string[] = [];
    if (scroll > 0) parts.push(`↑ ${scroll} above`);
    const below = lines.length - scroll - viewportHeight;
    if (below > 0) parts.push(`↓ ${below} below`);
    out.write(`\n${DIM}  ${parts.join('  ')}${RESET}\n`);
  }
}

/** Render a row into output lines (no trailing \n). */
function renderRow(row: Row, isSel: boolean): string[] {
  const lines: string[] = [];

  if (row.type === 'header') {
    const summary = `${GREEN}${row.allow}✓${RESET} ${YELLOW}${row.ask}?${RESET} ${RED}${row.deny}✗${RESET}`;
    const selMark = isSel ? `${BOLD}${YELLOW}▸ ` : `  `;
    const nameStr = `${BOLD}${BLUE}${row.provider}${RESET}`;
    const serverStr = row.serverInfo
      ? `${DIM}${row.serverInfo.name} v${row.serverInfo.version}${RESET}`
      : '';
    lines.push(''); // blank line before header
    lines.push(
      ` ${selMark}${nameStr}  ${DIM}(${row.total} tools)${RESET}  ${summary}${serverStr ? `  ${serverStr}` : ''}`
    );
    if (isSel) {
      lines.push(`   ${DIM}↳ press a/s/d to set all ${row.total} tools in this provider${RESET}`);
    }
    lines.push(`   ${DIM}${'╌'.repeat(55)}${RESET}`);
  } else {
    const { entry } = row;
    const dColor = decisionColor(entry.decision);
    const prefix = isSel ? `${BOLD}${YELLOW} ▸ ` : `   `;
    const toolName = entry.namespacedName.split('/').slice(1).join('/');
    const namePart = `${isSel ? BOLD : ''}${toolName}${RESET}`;
    const badge = annotationBadges(entry.annotations);
    const badgeColor = entry.annotations.destructiveHint
      ? RED
      : entry.annotations.openWorldHint
        ? YELLOW
        : entry.annotations.readOnlyHint
          ? GREEN
          : DIM;
    const injectionBadge = entry.suspiciousPatterns.length > 0 ? `  ${RED}⚠ injection${RESET}` : '';

    lines.push(
      `${prefix}${dColor}[${decisionLabel(entry.decision)}]${RESET}  ${namePart}  ${badge ? `${badgeColor}${badge}${RESET}` : ''}${injectionBadge}`
    );

    if (isSel && entry.description) {
      const descIndent = 7; // "       "
      const termCols = process.stdout.columns || 80;
      const maxDesc = Math.max(20, termCols - descIndent - 1);
      // Collapse newlines so the description stays on one terminal line
      const flat = entry.description.replace(/\s*\n\s*/g, ' ');
      const desc = flat.length > maxDesc ? flat.slice(0, maxDesc) + '…' : flat;
      lines.push(`       ${DIM}${desc}${RESET}`);
      if (entry.suspiciousPatterns.length > 0) {
        lines.push(`       ${RED}⚠ suspicious patterns — press [i] to inspect${RESET}`);
      }
    }
  }

  return lines;
}

function render(
  entries: ToolEntry[],
  serverInfoMap: Map<string, ServerInfo>,
  rowIdx: number,
  agentName: string
): void {
  const out = process.stdout;
  const termHeight = process.stdout.rows || 40;
  const termCols = process.stdout.columns || 80;
  out.write(`${ESC}H${ESC}2J`);

  // Check if current row has suspicious patterns for highlighting the [i] hint
  const rows = buildRows(entries, serverInfoMap);
  const currentRow = rows[rowIdx];
  const currentHasSuspicious =
    currentRow?.type === 'entry' && currentRow.entry.suspiciousPatterns.length > 0;
  const inspectHint = currentHasSuspicious
    ? `${RED}${BOLD}[i] inspect${RESET}`
    : `${DIM}[i] inspect${RESET}`;

  // Header (6 lines: blank, title, rule, keys, hint, rule+blank)
  const headerLines = [
    '',
    `${BOLD}${CYAN}  Airlock — Configure Agent: ${agentName}${RESET}`,
    `${DIM}  ${'─'.repeat(70)}${RESET}`,
    `${DIM}  [a] allow  [s] ask  [d] deny  [j/k] move  [{/}] section  ${inspectHint}${DIM}  [enter] confirm  [q] quit${RESET}`,
    `${DIM}  on a provider header, a/s/d applies to all tools in that provider${RESET}`,
    `${DIM}  ${'─'.repeat(70)}${RESET}`,
  ];

  // Footer (3 lines: blank, scroll indicator, summary)
  const footerScrollParts: string[] = [];
  const summaryLine =
    `${DIM}  ${entries.filter((e) => e.decision === 'allow').length} allow  ` +
    `${entries.filter((e) => e.decision === 'ask').length} ask  ` +
    `${entries.filter((e) => e.decision === 'deny').length} deny  ` +
    `/ ${entries.length} total${RESET}`;

  const headerScreenRows = headerLines.reduce((sum, l) => sum + terminalRows(l, termCols), 0);
  const footerScreenRows = 2; // scroll + summary
  const contentHeight = termHeight - headerScreenRows - footerScreenRows;

  // Pre-render all rows, track screen rows each line takes
  const allRendered: { rowIndex: number; lines: string[]; screenRows: number[] }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const lines = renderRow(rows[i], i === rowIdx);
    const screenRows = lines.map((l) => terminalRows(l, termCols));
    allRendered.push({ rowIndex: i, lines, screenRows });
  }

  // Flatten to line-level with screen-row costs
  const flatLines: { line: string; cost: number }[] = [];
  for (const rendered of allRendered) {
    for (let j = 0; j < rendered.lines.length; j++) {
      flatLines.push({ line: rendered.lines[j], cost: rendered.screenRows[j] });
    }
  }
  const totalScreenRows = flatLines.reduce((sum, f) => sum + f.cost, 0);

  // Find the screen-row offset of the selected row's midpoint
  let selectedStart = 0;
  for (let i = 0; i < rowIdx; i++) {
    const r = allRendered[i];
    selectedStart += r.screenRows.reduce((a, b) => a + b, 0);
  }
  const selectedCost = allRendered[rowIdx].screenRows.reduce((a, b) => a + b, 0);
  const selectedMid = selectedStart + Math.floor(selectedCost / 2);

  // Scroll so the selected row is roughly centered
  let scrollCost = Math.max(0, selectedMid - Math.floor(contentHeight / 2));
  scrollCost = Math.max(0, Math.min(scrollCost, totalScreenRows - contentHeight));

  // Collect lines that fit in the viewport by screen-row budget
  const viewportLines: string[] = [];
  let consumed = 0;
  let usedScreenRows = 0;
  let linesAbove = 0;
  let linesBelow = 0;
  for (const flat of flatLines) {
    if (consumed + flat.cost <= scrollCost) {
      // Before viewport
      consumed += flat.cost;
      linesAbove++;
    } else if (usedScreenRows + flat.cost <= contentHeight) {
      // Inside viewport
      viewportLines.push(flat.line);
      usedScreenRows += flat.cost;
      consumed += flat.cost;
    } else {
      // After viewport
      linesBelow++;
    }
  }

  // Build scroll indicator
  if (linesAbove > 0) footerScrollParts.push(`↑ ${linesAbove} above`);
  if (linesBelow > 0) footerScrollParts.push(`↓ ${linesBelow} below`);
  const scrollLine = footerScrollParts.length
    ? `${DIM}  ${footerScrollParts.join('  ')}${RESET}`
    : '';

  // Pad viewport to fill remaining screen rows
  while (usedScreenRows < contentHeight) {
    viewportLines.push('');
    usedScreenRows++;
  }

  // Write everything
  for (const line of headerLines) out.write(line + '\n');
  for (const line of viewportLines) out.write(line + '\n');
  out.write(scrollLine + '\n');
  out.write(summaryLine);
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP = `
airlock configure-agent — build allow/ask/deny lists from live MCP tools

Usage:
  airlock configure-agent [options]

Options:
  -c, --config <path>   Airlock config file (default: ./airlock.yaml)
  -a, --agent  <name>   Agent name to use in output (default: agent)
  -v, --verbose         Show MCP server output (default: suppressed)
  -h, --help            Show this help
`;

// ── Connection helpers ────────────────────────────────────────────────────

/** Poll a provider until it connects or the deadline expires. Returns tools or null. */
async function waitForProvider(
  pool: ClientPool,
  mcpId: string,
  deadlineMs: number
): Promise<Tool[] | null> {
  const start = Date.now();
  const interval = 1_000;
  while (Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      return await Promise.race([
        pool.listTools(mcpId),
        new Promise<Tool[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
      ]);
    } catch {
      // Still not ready — keep waiting
    }
  }
  return null;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runConfigureAgent(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      agent: { type: 'string', short: 'a', default: 'agent' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Load config
  const raw = readFileSync(values.config, 'utf8');
  const parsedYaml: unknown = parseYaml(raw);
  const parsed = GatewayConfig.parse(parsedYaml);
  const providers = parsed.providers ?? {};
  const mcpConfigs = getMcpConfigs(providers);

  if (Object.keys(mcpConfigs).length === 0) {
    console.error('No MCP providers found in config.');
    process.exit(1);
  }

  const mcpIds = Object.keys(mcpConfigs);
  process.stdout.write(`\nConnecting to ${mcpIds.length} provider(s)…\n`);

  const pool = new ClientPool(mcpConfigs, {
    stdioStderr: values.verbose ? 'inherit' : 'ignore',
  });

  // Start all connections, give them an initial 15s window
  const connectPromise = pool.initialize();
  const initTimeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  await Promise.race([connectPromise, initTimeout]);

  const entries: ToolEntry[] = [];
  const serverInfoMap = new Map<string, ServerInfo>();

  // Discover tools from each provider, with per-provider retry for slow ones
  for (const mcpId of mcpIds) {
    process.stdout.write(`  ${mcpId}: `);

    // First attempt — instant if already connected, fails fast if not
    let ready = true;
    let tools: Tool[] | null = null;
    try {
      tools = await Promise.race([
        pool.listTools(mcpId),
        new Promise<Tool[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
      ]);
    } catch {
      ready = false;
    }
    if (!ready) {
      // Not ready yet — wait with visible status
      process.stdout.write(`${YELLOW}connecting…${RESET}`);
      tools = await waitForProvider(pool, mcpId, 30_000);
    }

    if (!tools) {
      process.stdout.write(`\r  ${mcpId}: ${RED}timed out (not connected after 30s)${RESET}\n`);
      continue;
    }

    const info = pool.getServerInfo(mcpId);
    if (info) serverInfoMap.set(mcpId, info);
    const infoStr = info ? `${DIM}${info.name} v${info.version}${RESET}  ` : '';
    // Clear the "connecting…" text if present
    process.stdout.write(`\r  ${mcpId}: ${infoStr}${GREEN}${tools.length} tools${RESET}\n`);
    for (const tool of tools) {
      const annotations = tool.annotations ?? {};
      const suspicious = tool.description ? checkSuspiciousPatterns(tool.description) : [];
      entries.push({
        namespacedName: `${mcpId}/${tool.name}`,
        description: tool.description ?? '',
        annotations,
        decision: defaultDecision(annotations, suspicious),
        suspiciousPatterns: suspicious,
      });
    }
  }

  if (entries.length === 0) {
    console.error('\nNo tools found. Check that your providers are reachable.');
    await pool.stop();
    process.exit(1);
  }

  // Pre-populate decisions from existing agent config
  const agentName = values.agent;
  const existingAgent = parsed.agents[agentName];
  if (existingAgent) {
    const allowSet = new Set(existingAgent.allow);
    const askSet = new Set(existingAgent.ask);
    const denySet = new Set(existingAgent.deny);
    for (const entry of entries) {
      if (allowSet.has(entry.namespacedName)) {
        entry.decision = 'allow';
      } else if (askSet.has(entry.namespacedName)) {
        entry.decision = 'ask';
      } else if (denySet.has(entry.namespacedName)) {
        entry.decision = 'deny';
      }
    }
  }

  process.stdout.write(`\n${BOLD}Found ${entries.length} tools.${RESET} Press any key to start…`);

  const ttyFd = openSync('/dev/tty', 'r+');
  const tty = new ReadStream(ttyFd);
  tty.setEncoding('utf8');

  await new Promise<void>((resolve) => {
    tty.setRawMode(true);
    tty.once('data', () => resolve());
    tty.resume();
  });

  process.stdout.write('\x1b[?1049h');

  let rowIdx = 0;
  let done = false;
  let quit = false;
  let inspectMode = false;
  let inspectScroll = 0;

  function bulkSetProvider(provider: string, decision: Decision): void {
    for (const e of entries) {
      if (e.namespacedName.split('/')[0] === provider) e.decision = decision;
    }
  }

  function getSelectedEntry(): ToolEntry | null {
    const rows = buildRows(entries, serverInfoMap);
    const row = rows[rowIdx];
    return row?.type === 'entry' ? row.entry : null;
  }

  render(entries, serverInfoMap, rowIdx, values.agent);

  await new Promise<void>((resolve) => {
    tty.on('data', (key: string) => {
      if (done) return;

      // ── Inspect mode ──────────────────────────────────────────────
      if (inspectMode) {
        const entry = getSelectedEntry();
        if (!entry) {
          inspectMode = false;
          render(entries, serverInfoMap, rowIdx, values.agent);
          return;
        }

        if (key === 'i' || key === '\x1b' || key === '\x03') {
          inspectMode = false;
          render(entries, serverInfoMap, rowIdx, values.agent);
          return;
        }
        if (key === 'j' || key === `${ESC}B`) inspectScroll++;
        if (key === 'k' || key === `${ESC}A`) inspectScroll = Math.max(0, inspectScroll - 1);
        if (key === 'a') entry.decision = 'allow';
        if (key === 's') entry.decision = 'ask';
        if (key === 'd') entry.decision = 'deny';

        renderInspect(entry, inspectScroll);
        return;
      }

      // ── Normal mode ───────────────────────────────────────────────
      if (key === '\x03' || key === 'q') {
        quit = true;
        done = true;
        process.stdout.write('\x1b[?1049l');
        tty.setRawMode(false);
        tty.destroy();
        resolve();
        return;
      }

      if (key === '\r' || key === '\n') {
        done = true;
        process.stdout.write('\x1b[?1049l');
        tty.setRawMode(false);
        tty.destroy();
        resolve();
        return;
      }

      const rows = buildRows(entries, serverInfoMap);
      const maxIdx = rows.length - 1;

      if (key === 'j' || key === `${ESC}B`) rowIdx = Math.min(rowIdx + 1, maxIdx);
      if (key === 'k' || key === `${ESC}A`) rowIdx = Math.max(rowIdx - 1, 0);

      // Section navigation: { / } jump to prev/next provider header
      if (key === '}') {
        for (let ri = rowIdx + 1; ri <= maxIdx; ri++) {
          if (rows[ri].type === 'header') {
            rowIdx = ri;
            break;
          }
        }
      }
      if (key === '{') {
        for (let ri = rowIdx - 1; ri >= 0; ri--) {
          if (rows[ri].type === 'header') {
            rowIdx = ri;
            break;
          }
        }
      }
      if (key === 'i' && getSelectedEntry()) {
        inspectMode = true;
        inspectScroll = 0;
        const entry = getSelectedEntry()!;
        renderInspect(entry, inspectScroll);
        return;
      }

      const currentRow = rows[rowIdx];
      if (currentRow?.type === 'header') {
        if (key === 'a') bulkSetProvider(currentRow.provider, 'allow');
        if (key === 's') bulkSetProvider(currentRow.provider, 'ask');
        if (key === 'd') bulkSetProvider(currentRow.provider, 'deny');
      } else if (currentRow?.type === 'entry') {
        if (key === 'a') currentRow.entry.decision = 'allow';
        if (key === 's') currentRow.entry.decision = 'ask';
        if (key === 'd') currentRow.entry.decision = 'deny';
      }

      render(entries, serverInfoMap, rowIdx, values.agent);
    });
  });

  await pool.stop();

  if (quit) {
    console.log('Aborted.');
    process.exit(0);
  }

  const yaml = renderYaml(values.agent, entries);

  // ── Action picker ───────────────────────────────────────────────────────────
  process.stdout.write(`\n${BOLD}${CYAN}What would you like to do?${RESET}\n`);
  process.stdout.write(
    `  ${BOLD}[e]${RESET} edit config directly  ${DIM}(backs up original to .bak)${RESET}\n`
  );
  process.stdout.write(`  ${BOLD}[c]${RESET} copy to clipboard\n`);
  process.stdout.write(`  ${BOLD}[p]${RESET} print to stdout\n`);
  process.stdout.write(`  ${BOLD}[q]${RESET} abort\n\n`);
  process.stdout.write(`> `);

  const ttyFd2 = openSync('/dev/tty', 'r+');
  const tty2 = new ReadStream(ttyFd2);
  tty2.setEncoding('utf8');

  const action = await new Promise<string>((resolve) => {
    tty2.setRawMode(true);
    tty2.resume();
    tty2.once('data', (key: string) => {
      tty2.setRawMode(false);
      tty2.destroy();
      resolve(key);
    });
  });

  process.stdout.write('\n');

  if (action === 'q' || action === '\x03') {
    console.log('Aborted.');
    process.exit(0);
  }

  if (action === 'p') {
    console.log(`\n${BOLD}${CYAN}# Paste into your airlock.yaml:${RESET}\n`);
    console.log(yaml);
    console.log();
    process.exit(0);
  }

  if (action === 'c') {
    const clipCmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
    try {
      execSync(clipCmd, { input: yaml });
      console.log(`${GREEN}✓ Copied to clipboard.${RESET}`);
    } catch {
      console.error(`Could not copy to clipboard. Here is the YAML:\n`);
      console.log(yaml);
    }
    process.exit(0);
  }

  if (action === 'e') {
    const configPath = values.config;
    const backupPath = configPath.replace(/\.ya?ml$/i, '') + '.bak';
    copyFileSync(configPath, backupPath);

    const doc = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agents = (doc.agents ?? {}) as Record<string, Record<string, unknown>>;
    const existing = agents[values.agent] ?? {};
    agents[values.agent] = {
      ...existing,
      allow: entries.filter((e) => e.decision === 'allow').map((e) => e.namespacedName),
      ask: entries.filter((e) => e.decision === 'ask').map((e) => e.namespacedName),
      deny: entries.filter((e) => e.decision === 'deny').map((e) => e.namespacedName),
    };
    doc.agents = agents;
    writeFileSync(configPath, stringifyYaml(doc));

    console.log(`${GREEN}✓ Updated ${configPath}${RESET}`);
    console.log(`${DIM}  Original backed up to ${backupPath}${RESET}`);
    process.exit(0);
  }

  // fallback
  console.log(`\n${BOLD}${CYAN}# Paste into your airlock.yaml:${RESET}\n`);
  console.log(yaml);
  console.log();
}
