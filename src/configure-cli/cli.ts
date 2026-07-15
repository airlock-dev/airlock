import { parseArgs } from 'util';
import { writeFileSync, copyFileSync, readFileSync, openSync } from 'fs';
import { ReadStream } from 'tty';
import { execSync } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { discoverCliCommands } from '../discover/index.js';
import { createCompletionSession } from '../discover/strategies/completion.js';
import type { CliCommandConfig } from '../config/schema.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CommandEntry {
  name: string;
  config: CliCommandConfig;
  enabled: boolean;
}

interface CommandGroup {
  name: string;
  path: string[];
  entries: CommandEntry[];
  loaded: boolean;
  loading: boolean;
  pendingEnabled: boolean;
  error?: string;
}

type ViewLevel = 'groups' | 'commands';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;

function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function terminalRows(line: string, termCols: number): number {
  const len = visibleLength(line);
  if (len === 0) return 1;
  return Math.ceil(len / termCols);
}

// ── Global flag detection ────────────────────────────────────────────────────

/** Flags that are noise for AI agents — always stripped. */
const NOISE_FLAGS = new Set(['help', 'version']);

interface GlobalFlagInfo {
  /** Flags present in every single command */
  universal: Set<string>;
  /** Flags that are noise (help, version) */
  noise: Set<string>;
}

function detectGlobalFlags(commands: Record<string, CliCommandConfig>): GlobalFlagInfo {
  const commandNames = Object.keys(commands);
  if (commandNames.length === 0) return { universal: new Set(), noise: new Set() };

  // Count how many commands each param appears in
  const paramCounts = new Map<string, number>();
  for (const cmd of Object.values(commands)) {
    for (const paramName of Object.keys(cmd.params ?? {})) {
      paramCounts.set(paramName, (paramCounts.get(paramName) ?? 0) + 1);
    }
  }

  const total = commandNames.length;
  const universal = new Set<string>();
  for (const [param, count] of paramCounts) {
    if (count === total) universal.add(param);
  }

  return { universal, noise: NOISE_FLAGS };
}

function collectCommands(groups: CommandGroup[]): Record<string, CliCommandConfig> {
  const commands: Record<string, CliCommandConfig> = {};
  for (const group of groups) {
    for (const entry of group.entries) {
      commands[entry.name] = entry.config;
    }
  }
  return commands;
}

function detectGlobalFlagsFromGroups(groups: CommandGroup[]): GlobalFlagInfo {
  return detectGlobalFlags(collectCommands(groups));
}

// ── Command grouping ─────────────────────────────────────────────────────────

function groupCommands(commands: Record<string, CliCommandConfig>, tool: string): CommandGroup[] {
  const groups = new Map<string, CommandEntry[]>();

  // Group by the first subcommand from the exec field.
  // e.g. exec "gog gmail send" → group "gmail", exec "gog ls" → group "(root)"
  for (const [name, config] of Object.entries(commands)) {
    const execParts = (config.exec ?? name).split(/\s+/);
    // Strip the tool name prefix to get subcommand parts
    // exec: "gog gmail send" → ["gog", "gmail", "send"] → subcommand parts: ["gmail", "send"]
    const subParts = execParts.slice(1); // remove tool name

    let groupName: string;
    if (subParts.length > 1) {
      // Has at least one level of nesting — group by first subcommand
      groupName = subParts[0];
    } else {
      groupName = '(root)';
    }

    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push({ name, config, enabled: true });
  }

  // Move (root) entries that match a group name into that group.
  // e.g. if "gmail" is in (root) and a "gmail" group exists, move it there.
  const rootEntries = groups.get('(root)');
  if (rootEntries) {
    const toMove: CommandEntry[] = [];
    for (const entry of rootEntries) {
      if (entry.name !== tool && groups.has(entry.name) && entry.name !== '(root)') {
        toMove.push(entry);
      }
    }
    for (const entry of toMove) {
      rootEntries.splice(rootEntries.indexOf(entry), 1);
      groups.get(entry.name)!.unshift(entry); // put parent first in the group
    }
    if (rootEntries.length === 0) groups.delete('(root)');
  }

  // Sort: (root) first, then alphabetical
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a === '(root)') return -1;
    if (b === '(root)') return 1;
    return a.localeCompare(b);
  });

  return sorted.map(([name, entries]) => ({
    name,
    path: name === '(root)' ? [] : [name],
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    loaded: true,
    loading: false,
    pendingEnabled: true,
  }));
}

function createLazyGroups(
  tool: string,
  topLevelSubcommands: string[],
  rootCommand?: CliCommandConfig | null
): CommandGroup[] {
  const groups: CommandGroup[] = [];

  if (rootCommand) {
    groups.push({
      name: '(root)',
      path: [],
      entries: [{ name: tool, config: rootCommand, enabled: true }],
      loaded: true,
      loading: false,
      pendingEnabled: true,
    });
  }

  for (const name of [...topLevelSubcommands].sort((a, b) => a.localeCompare(b))) {
    groups.push({
      name,
      path: [name],
      entries: [],
      loaded: false,
      loading: false,
      pendingEnabled: true,
    });
  }

  return groups;
}

// ── Compact YAML output ──────────────────────────────────────────────────────

function buildCompactConfig(
  tool: string,
  groups: CommandGroup[],
  globalFlags: GlobalFlagInfo,
  stripGlobal: boolean
): Record<string, unknown> {
  const commands: Record<string, unknown> = {};

  for (const group of groups) {
    for (const entry of group.entries) {
      if (!entry.enabled) continue;

      const cmd: Record<string, unknown> = {
        exec: entry.config.exec,
      };

      if (entry.config.description) {
        cmd.description = entry.config.description;
      }

      // Build compact params — strip globals and noise, omit defaults
      const params: Record<string, unknown> = {};
      for (const [paramName, paramConfig] of Object.entries(entry.config.params ?? {})) {
        if (globalFlags.noise.has(paramName)) continue;
        if (stripGlobal && globalFlags.universal.has(paramName)) continue;

        const compact: Record<string, unknown> = { type: paramConfig.type };
        if (paramConfig.flag) compact.flag = paramConfig.flag;
        if (paramConfig.positional) compact.positional = true;
        if (paramConfig.required) compact.required = true;
        if (paramConfig.description) compact.description = paramConfig.description;
        // Omit default, positional: false, required: false — they're defaults

        params[paramName] = compact;
      }

      if (Object.keys(params).length > 0) cmd.params = params;
      cmd.timeout = entry.config.timeout ?? 30;

      commands[entry.name] = cmd;
    }
  }

  return {
    clis: {
      [tool]: { commands },
    },
  };
}

function serializeCompact(data: Record<string, unknown>, tool: string, strategy: string): string {
  const header = [
    '# Auto-discovered by Airlock (interactive)',
    `# Tool: ${tool}`,
    `# Strategy: ${strategy}`,
    `# Generated: ${new Date().toISOString()}`,
    '#',
    '# Only selected commands are included. Global/noise flags stripped.',
    '',
  ].join('\n');

  return header + stringifyYaml(data, { lineWidth: 120 });
}

// ── TUI row model ────────────────────────────────────────────────────────────

type Row =
  | { type: 'group-header'; group: CommandGroup; groupIdx: number }
  | { type: 'command'; entry: CommandEntry; groupIdx: number; entryIdx: number };

function matchesSearch(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

function buildVisibleRows(
  groups: CommandGroup[],
  viewLevel: ViewLevel,
  activeGroupIdx: number,
  searchTerm: string
): Row[] {
  const query = searchTerm.trim();
  const rows =
    viewLevel === 'groups'
      ? buildGroupRows(groups)
      : buildCommandRows(groups[activeGroupIdx], activeGroupIdx);

  if (!query) return rows;

  return rows.filter((row) => {
    if (row.type === 'group-header') {
      return matchesSearch(row.group.name, query);
    }

    const haystack = [row.entry.name, row.entry.config.exec, row.entry.config.description ?? '']
      .join(' ')
      .trim();
    return matchesSearch(haystack, query);
  });
}

function buildGroupRows(groups: CommandGroup[]): Row[] {
  return groups.map((group, i) => ({
    type: 'group-header' as const,
    group,
    groupIdx: i,
  }));
}

function buildCommandRows(group: CommandGroup, groupIdx: number): Row[] {
  return group.entries.map((entry, i) => ({
    type: 'command' as const,
    entry,
    groupIdx,
    entryIdx: i,
  }));
}

// ── TUI rendering ────────────────────────────────────────────────────────────

function renderGroupRow(row: Row & { type: 'group-header' }, isSel: boolean): string[] {
  const { group } = row;
  const enabled = group.entries.filter((e) => e.enabled).length;
  const total = group.entries.length;
  const allOn = group.loaded ? enabled === total : group.pendingEnabled;
  const allOff = group.loaded ? enabled === 0 : !group.pendingEnabled;

  const check = allOn
    ? `${GREEN}[✓]${RESET}`
    : allOff
      ? `${DIM}[ ]${RESET}`
      : `${YELLOW}[~]${RESET}`;
  const selMark = isSel ? `${BOLD}${YELLOW}▸ ` : `  `;
  const nameStr = `${isSel ? BOLD : ''}${group.name}${RESET}`;
  const countStr = group.loaded
    ? `${DIM}(${enabled}/${total} commands)${RESET}`
    : group.loading
      ? `${YELLOW}(loading...)${RESET}`
      : `${DIM}(not loaded yet)${RESET}`;

  const lines: string[] = [];
  lines.push(` ${selMark}${check}  ${nameStr}  ${countStr}`);

  if (isSel) {
    const hint = group.loaded
      ? `${DIM}   ↳ [space] toggle all  [enter] drill down  [a] all on  [n] all off${RESET}`
      : `${DIM}   ↳ [enter] load group  [space] queue selection before load${RESET}`;
    lines.push(hint);
    if (group.error) lines.push(`   ${RED}${group.error}${RESET}`);
  }

  return lines;
}

function renderCommandRow(
  row: Row & { type: 'command' },
  isSel: boolean,
  globalFlags: GlobalFlagInfo,
  stripGlobal: boolean
): string[] {
  const { entry } = row;
  const check = entry.enabled ? `${GREEN}[✓]${RESET}` : `${DIM}[ ]${RESET}`;
  const selMark = isSel ? `${BOLD}${YELLOW} ▸ ` : `   `;
  const nameStr = `${isSel ? BOLD : ''}${entry.name}${RESET}`;

  // Count non-global params
  const totalParams = Object.keys(entry.config.params ?? {}).length;
  const globalCount = Object.keys(entry.config.params ?? {}).filter(
    (p) => globalFlags.noise.has(p) || (stripGlobal && globalFlags.universal.has(p))
  ).length;
  const effectiveParams = totalParams - globalCount;
  const paramStr = effectiveParams > 0 ? `${DIM}(${effectiveParams} params)${RESET}` : '';

  const lines: string[] = [];
  lines.push(`${selMark}${check}  ${nameStr}  ${paramStr}`);

  if (isSel) {
    const desc = entry.config.description ?? '';
    if (desc) {
      const termCols = process.stdout.columns || 80;
      const maxDesc = Math.max(20, termCols - 10);
      const flat = desc.replace(/\s*\n\s*/g, ' ');
      const truncated = flat.length > maxDesc ? flat.slice(0, maxDesc) + '…' : flat;
      lines.push(`       ${DIM}${truncated}${RESET}`);
    }
    lines.push(`       ${DIM}exec: ${entry.config.exec}${RESET}`);
  }

  return lines;
}

function render(
  groups: CommandGroup[],
  viewLevel: ViewLevel,
  activeGroupIdx: number,
  rowIdx: number,
  tool: string,
  globalFlags: GlobalFlagInfo,
  stripGlobal: boolean,
  searchTerm = '',
  searchMode = false
): void {
  const out = process.stdout;
  const termHeight = process.stdout.rows || 40;
  const termCols = process.stdout.columns || 80;
  out.write(`${ESC}H${ESC}2J`);

  // Summary counts
  const totalCommands = groups.reduce((s, g) => s + g.entries.length, 0);
  const enabledCommands = groups.reduce((s, g) => s + g.entries.filter((e) => e.enabled).length, 0);
  const loadedGroups = groups.filter((group) => group.loaded).length;

  // Build header
  const breadcrumb = viewLevel === 'commands' ? ` > ${groups[activeGroupIdx].name}` : '';

  const headerLines = [
    '',
    `${BOLD}${CYAN}  Airlock — Configure CLI: ${tool}${breadcrumb}${RESET}`,
    `${DIM}  ${'─'.repeat(Math.min(70, termCols - 4))}${RESET}`,
  ];

  if (viewLevel === 'groups') {
    headerLines.push(
      `${DIM}  [space] toggle  [l/enter] drill down  [/] search  [a] all on  [n] all off  [g] global flags  [w] done  [q] quit${RESET}`
    );
    headerLines.push(
      `${DIM}  global flags: ${stripGlobal ? `${GREEN}stripped${RESET}` : `${YELLOW}included${RESET}`}${DIM}  (${globalFlags.universal.size} detected across loaded commands)${RESET}`
    );
  } else {
    headerLines.push(
      `${DIM}  [space] toggle  [l] inspect  [h/esc] back  [/] search  [a] all on  [n] all off  [q] quit${RESET}`
    );
  }

  const searchLabel = searchMode
    ? `${YELLOW}/${searchTerm}${RESET}`
    : searchTerm
      ? `${CYAN}/${searchTerm}${RESET}`
      : `${DIM}/ search${RESET}`;
  headerLines.push(`${DIM}  filter: ${RESET}${searchLabel}`);

  headerLines.push(`${DIM}  ${'─'.repeat(Math.min(70, termCols - 4))}${RESET}`);

  // Build rows
  const rows = buildVisibleRows(groups, viewLevel, activeGroupIdx, searchTerm);

  // Render all rows
  const allRendered: { lines: string[]; screenRows: number[] }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isSel = i === rowIdx;
    let lines: string[];
    if (row.type === 'group-header') {
      lines = renderGroupRow(row, isSel);
    } else {
      lines = renderCommandRow(row, isSel, globalFlags, stripGlobal);
    }
    const screenRows = lines.map((l) => terminalRows(l, termCols));
    allRendered.push({ lines, screenRows });
  }

  // Flatten for viewport calculation
  const flatLines: { line: string; cost: number }[] = [];
  for (const rendered of allRendered) {
    for (let j = 0; j < rendered.lines.length; j++) {
      flatLines.push({ line: rendered.lines[j], cost: rendered.screenRows[j] });
    }
  }

  const headerScreenRows = headerLines.reduce((sum, l) => sum + terminalRows(l, termCols), 0);
  const footerScreenRows = 2;
  const contentHeight = termHeight - headerScreenRows - footerScreenRows;
  const totalScreenRows = flatLines.reduce((sum, f) => sum + f.cost, 0);

  // Find selected row's midpoint for centering
  let selectedStart = 0;
  for (let i = 0; i < rowIdx && i < allRendered.length; i++) {
    selectedStart += allRendered[i].screenRows.reduce((a, b) => a + b, 0);
  }
  const selectedCost =
    rowIdx < allRendered.length ? allRendered[rowIdx].screenRows.reduce((a, b) => a + b, 0) : 0;
  const selectedMid = selectedStart + Math.floor(selectedCost / 2);

  let scrollCost = Math.max(0, selectedMid - Math.floor(contentHeight / 2));
  scrollCost = Math.max(0, Math.min(scrollCost, totalScreenRows - contentHeight));

  // Collect viewport lines
  const viewportLines: string[] = [];
  let consumed = 0;
  let usedScreenRows = 0;
  let linesAbove = 0;
  let linesBelow = 0;
  for (const flat of flatLines) {
    if (consumed + flat.cost <= scrollCost) {
      consumed += flat.cost;
      linesAbove++;
    } else if (usedScreenRows + flat.cost <= contentHeight) {
      viewportLines.push(flat.line);
      usedScreenRows += flat.cost;
      consumed += flat.cost;
    } else {
      linesBelow++;
    }
  }

  // Scroll indicator
  const scrollParts: string[] = [];
  if (linesAbove > 0) scrollParts.push(`↑ ${linesAbove} above`);
  if (linesBelow > 0) scrollParts.push(`↓ ${linesBelow} below`);
  const scrollLine = scrollParts.length ? `${DIM}  ${scrollParts.join('  ')}${RESET}` : '';

  // Pad viewport
  while (usedScreenRows < contentHeight) {
    viewportLines.push('');
    usedScreenRows++;
  }

  // Summary line
  const summaryLine = `${DIM}  ${enabledCommands}/${totalCommands} loaded commands selected  |  ${loadedGroups}/${groups.length} groups loaded  |  ${rows.length} visible${RESET}`;

  // Write
  for (const line of headerLines) out.write(line + '\n');
  for (const line of viewportLines) out.write(line + '\n');
  out.write(scrollLine + '\n');
  out.write(summaryLine);
}

// ── Inspect mode ─────────────────────────────────────────────────────────────

function renderInspect(
  entry: CommandEntry,
  globalFlags: GlobalFlagInfo,
  stripGlobal: boolean,
  inspectScroll: number
): void {
  const out = process.stdout;
  out.write(`${ESC}H${ESC}2J`);

  const check = entry.enabled ? `${GREEN}enabled${RESET}` : `${RED}disabled${RESET}`;
  out.write(`\n${BOLD}${CYAN}  Inspect: ${entry.name}${RESET}  ${check}\n`);
  out.write(`${DIM}  ${'─'.repeat(70)}${RESET}\n`);
  out.write(`${DIM}  [j/k] scroll  [h/esc] back  [space] toggle${RESET}\n`);
  out.write(`${DIM}  ${'─'.repeat(70)}${RESET}\n\n`);

  const lines: string[] = [];
  lines.push(`  ${BOLD}exec:${RESET} ${entry.config.exec}`);
  if (entry.config.description) {
    lines.push(`  ${BOLD}description:${RESET} ${entry.config.description}`);
  }
  lines.push('');
  lines.push(`  ${BOLD}Parameters:${RESET}`);

  for (const [paramName, param] of Object.entries(entry.config.params ?? {})) {
    const isGlobal = globalFlags.universal.has(paramName);
    const isNoise = globalFlags.noise.has(paramName);
    const stripped = isNoise || (stripGlobal && isGlobal);

    const tag = stripped ? `${DIM}[stripped]${RESET}` : isGlobal ? `${YELLOW}[global]${RESET}` : '';

    lines.push(
      `    ${stripped ? DIM : ''}${paramName}${RESET}  ${param.type}  ${param.flag ?? ''}  ${tag}`
    );
    if (param.description) {
      lines.push(`      ${DIM}${param.description}${RESET}`);
    }
  }

  // Scrollable viewport
  const termRows = process.stdout.rows || 40;
  const viewportHeight = termRows - 10;
  const maxScroll = Math.max(0, lines.length - viewportHeight);
  const scroll = Math.min(inspectScroll, maxScroll);
  const visible = lines.slice(scroll, scroll + viewportHeight);

  for (const line of visible) {
    out.write(`${line}\n`);
  }

  if (lines.length > viewportHeight) {
    const parts: string[] = [];
    if (scroll > 0) parts.push(`↑ ${scroll} above`);
    const below = lines.length - scroll - viewportHeight;
    if (below > 0) parts.push(`↓ ${below} below`);
    out.write(`\n${DIM}  ${parts.join('  ')}${RESET}\n`);
  }
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP = `
airlock configure-cli — interactively select and configure CLI tool commands

Usage:
  airlock configure-cli <tool> [options]

Options:
  --fig                  Try Fig autocomplete specs first
  --max-depth <n>        Max subcommand recursion depth (default: 2)
  --output, -o <path>    Write YAML to file instead of action picker
  -h, --help             Show this help

Examples:
  airlock configure-cli gog
  airlock configure-cli docker --fig
  airlock configure-cli git --max-depth 3 -o git-commands.yaml
`;

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runConfigureCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      fig: { type: 'boolean', default: false },
      'max-depth': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  const tool = positionals[0];
  const maxDepth = values['max-depth'] ? parseInt(values['max-depth'], 10) : undefined;

  // ── Discovery phase ──────────────────────────────────────────────────────
  process.stdout.write(
    `\n${BOLD}Discovering commands for ${CYAN}${tool}${RESET}${BOLD}…${RESET}\n`
  );

  let strategy: string;
  const completionSession = !values.fig ? createCompletionSession(tool) : null;
  let groups: CommandGroup[];

  if (values.output || !completionSession) {
    const discovery = await discoverCliCommands({
      tool,
      fromFig: values.fig,
      maxDepth,
    });
    const commands = discovery.commands;
    strategy = discovery.strategy;

    if (strategy.startsWith('completion:')) {
      process.stdout.write(
        `${DIM}  detected ${strategy.replace('completion:', '')} completion support${RESET}\n`
      );
    } else if (strategy === 'help-text') {
      process.stdout.write(`${DIM}  falling back to --help parsing${RESET}\n`);
    }

    const commandCount = Object.keys(commands).length;
    if (commandCount === 0) {
      console.error(`No commands discovered for "${tool}".`);
      process.exit(1);
    }

    groups = groupCommands(commands, tool);
    const globalFlags = detectGlobalFlagsFromGroups(groups);
    const stripGlobal = true;

    process.stdout.write(
      `${GREEN}Found ${commandCount} commands${RESET}` +
        `  ${DIM}(${globalFlags.universal.size} global flags detected: ${[...globalFlags.universal].join(', ')})${RESET}\n`
    );
    process.stdout.write(`${DIM}Grouped into ${groups.length} sections.${RESET}\n\n`);

    if (values.output) {
      const data = buildCompactConfig(tool, groups, globalFlags, stripGlobal);
      const yaml = serializeCompact(data, tool, strategy);
      writeFileSync(values.output, yaml);
      console.log(`Written to ${values.output}`);
      process.exit(0);
    }

    await runInteractiveConfigurator(tool, strategy, groups, stripGlobal, undefined, maxDepth);
    return;
  }

  strategy = `completion:${completionSession.adapterId}`;
  process.stdout.write(
    `${DIM}  detected ${strategy.replace('completion:', '')} completion support${RESET}\n`
  );

  const rootCommand = completionSession.loadCommand([], tool);
  const topLevelSubcommands = completionSession.listTopLevelSubcommands();
  groups = createLazyGroups(tool, topLevelSubcommands, rootCommand);

  if (groups.length === 0) {
    console.error(`No commands discovered for "${tool}".`);
    process.exit(1);
  }

  const initialGlobalFlags = detectGlobalFlagsFromGroups(groups);
  process.stdout.write(
    `${GREEN}Loaded ${groups.filter((group) => group.loaded).length} section(s) immediately${RESET}` +
      `  ${DIM}(${topLevelSubcommands.length} more available to load on demand)${RESET}\n`
  );
  process.stdout.write(
    `${DIM}Global flags currently based on loaded commands: ${[...initialGlobalFlags.universal].join(', ') || 'none'}${RESET}\n\n`
  );

  await runInteractiveConfigurator(tool, strategy, groups, true, completionSession, maxDepth);
  return;
}

async function runInteractiveConfigurator(
  tool: string,
  strategy: string,
  groups: CommandGroup[],
  initialStripGlobal: boolean,
  completionSession?: ReturnType<typeof createCompletionSession>,
  maxDepth?: number
): Promise<void> {
  process.stdout.write(`${BOLD}Press any key to start the configurator…${RESET}`);

  const ttyFd = openSync('/dev/tty', 'r+');
  const tty = new ReadStream(ttyFd);
  tty.setEncoding('utf8');

  await new Promise<void>((resolve) => {
    tty.setRawMode(true);
    tty.once('data', () => resolve());
    tty.resume();
  });

  process.stdout.write('\x1b[?1049h');

  let viewLevel: ViewLevel = 'groups';
  let activeGroupIdx = 0;
  let rowIdx = 0;
  let done = false;
  let quit = false;
  let inspectMode = false;
  let inspectScroll = 0;
  let stripGlobal = initialStripGlobal;
  let searchTerm = '';
  let searchMode = false;

  function currentGlobalFlags(): GlobalFlagInfo {
    return detectGlobalFlagsFromGroups(groups);
  }

  function getMaxIdx(): number {
    return Math.max(0, buildVisibleRows(groups, viewLevel, activeGroupIdx, searchTerm).length - 1);
  }

  function getVisibleRows(): Row[] {
    return buildVisibleRows(groups, viewLevel, activeGroupIdx, searchTerm);
  }

  function getSelectedEntry(): CommandEntry | null {
    const row = getVisibleRows()[rowIdx];
    return row?.type === 'command' ? row.entry : null;
  }

  function renderCurrent(): void {
    const visibleRows = getVisibleRows();
    if (rowIdx > Math.max(0, visibleRows.length - 1)) rowIdx = Math.max(0, visibleRows.length - 1);
    render(
      groups,
      viewLevel,
      activeGroupIdx,
      rowIdx,
      tool,
      currentGlobalFlags(),
      stripGlobal,
      searchTerm,
      searchMode
    );
  }

  function ensureGroupLoaded(group: CommandGroup, renderWhileLoading = true): void {
    if (group.loaded || group.loading || !completionSession || group.path.length === 0) return;

    group.loading = true;
    group.error = undefined;
    if (renderWhileLoading) renderCurrent();

    try {
      const remainingDepth = Math.max(0, (maxDepth ?? 2) - group.path.length);
      const discovered = completionSession.loadPath(group.path, { maxDepth: remainingDepth });
      group.entries = Object.entries(discovered)
        .map(([name, config]) => ({ name, config, enabled: group.pendingEnabled }))
        .sort((a, b) => a.name.localeCompare(b.name));
      group.loaded = true;
    } catch (error) {
      group.error = error instanceof Error ? error.message : 'Failed to load group';
      group.entries = [];
    } finally {
      group.loading = false;
    }
  }

  function ensureSelectedGroupsLoadedForOutput(): void {
    if (!completionSession) return;
    process.stdout.write('\x1b[?1049l');
    process.stdout.write(`\n${DIM}Loading selected groups…${RESET}\n`);
    for (const group of groups) {
      if (!group.loaded && group.pendingEnabled) {
        ensureGroupLoaded(group, false);
      }
    }
  }

  renderCurrent();

  await new Promise<void>((resolve) => {
    tty.on('data', (key: string) => {
      if (done) return;

      if (inspectMode) {
        const entry = getSelectedEntry();
        if (!entry) {
          inspectMode = false;
          renderCurrent();
          return;
        }

        if (key === 'i' || key === 'h' || key === '\x1b' || key === '\x03') {
          inspectMode = false;
          renderCurrent();
          return;
        }
        if (key === 'j' || key === `${ESC}B`) inspectScroll++;
        if (key === 'k' || key === `${ESC}A`) inspectScroll = Math.max(0, inspectScroll - 1);
        if (key === ' ') entry.enabled = !entry.enabled;

        renderInspect(entry, currentGlobalFlags(), stripGlobal, inspectScroll);
        return;
      }

      if (searchMode) {
        if (key === '\r' || key === '\n' || key === '\x1b') {
          searchMode = false;
          rowIdx = 0;
          renderCurrent();
          return;
        }
        if (key === '\x7f') {
          searchTerm = searchTerm.slice(0, -1);
          rowIdx = 0;
          renderCurrent();
          return;
        }
        if (key >= ' ' && key <= '~') {
          searchTerm += key;
          rowIdx = 0;
          renderCurrent();
          return;
        }
        return;
      }

      if (key === '\x03' || key === 'q') {
        quit = true;
        done = true;
        process.stdout.write('\x1b[?1049l');
        tty.setRawMode(false);
        tty.destroy();
        resolve();
        return;
      }

      if (viewLevel === 'groups' && (key === 'l' || key === '\r' || key === '\n')) {
        const row = getVisibleRows()[rowIdx];
        if (row?.type === 'group-header') {
          const group = row.group;
          ensureGroupLoaded(group);
          activeGroupIdx = row.groupIdx;
          viewLevel = 'commands';
          rowIdx = 0;
          renderCurrent();
          return;
        }
      }

      if (viewLevel === 'commands' && key === 'l') {
        const entry = getSelectedEntry();
        if (entry) {
          inspectMode = true;
          inspectScroll = 0;
          renderInspect(entry, currentGlobalFlags(), stripGlobal, inspectScroll);
          return;
        }
      }

      if (viewLevel === 'groups' && key === 'w') {
        done = true;
        process.stdout.write('\x1b[?1049l');
        tty.setRawMode(false);
        tty.destroy();
        resolve();
        return;
      }

      if (
        viewLevel === 'commands' &&
        (key === 'h' || key === '\x1b' || key === '\r' || key === '\n')
      ) {
        viewLevel = 'groups';
        rowIdx = Math.max(
          0,
          getVisibleRows().findIndex(
            (row) => row.type === 'group-header' && row.groupIdx === activeGroupIdx
          )
        );
        renderCurrent();
        return;
      }

      if (key === '/') {
        searchMode = true;
        searchTerm = '';
        rowIdx = 0;
        renderCurrent();
        return;
      }

      const maxIdx = getMaxIdx();
      if (key === 'j' || key === `${ESC}B`) rowIdx = Math.min(rowIdx + 1, maxIdx);
      if (key === 'k' || key === `${ESC}A`) rowIdx = Math.max(rowIdx - 1, 0);

      if (key === ' ') {
        if (viewLevel === 'groups') {
          const row = getVisibleRows()[rowIdx];
          if (row?.type !== 'group-header') {
            renderCurrent();
            return;
          }
          const group = row.group;
          if (!group.loaded) {
            group.pendingEnabled = !group.pendingEnabled;
          } else {
            const allEnabled = group.entries.every((entry) => entry.enabled);
            for (const entry of group.entries) entry.enabled = !allEnabled;
            group.pendingEnabled = !allEnabled;
          }
        } else {
          const row = getVisibleRows()[rowIdx];
          const entry = row?.type === 'command' ? row.entry : null;
          if (entry) entry.enabled = !entry.enabled;
        }
      }

      if (key === 'a') {
        if (viewLevel === 'groups') {
          for (const group of groups) {
            group.pendingEnabled = true;
            for (const entry of group.entries) entry.enabled = true;
          }
        } else {
          const group = groups[activeGroupIdx];
          group.pendingEnabled = true;
          for (const entry of group.entries) entry.enabled = true;
        }
      }
      if (key === 'n') {
        if (viewLevel === 'groups') {
          for (const group of groups) {
            group.pendingEnabled = false;
            for (const entry of group.entries) entry.enabled = false;
          }
        } else {
          const group = groups[activeGroupIdx];
          group.pendingEnabled = false;
          for (const entry of group.entries) entry.enabled = false;
        }
      }

      if (key === 'g' && viewLevel === 'groups') {
        stripGlobal = !stripGlobal;
      }

      if (key === 'i' && viewLevel === 'commands') {
        const entry = getSelectedEntry();
        if (entry) {
          inspectMode = true;
          inspectScroll = 0;
          renderInspect(entry, currentGlobalFlags(), stripGlobal, inspectScroll);
          return;
        }
      }

      renderCurrent();
    });
  });

  if (quit) {
    console.log('Aborted.');
    process.exit(0);
  }

  ensureSelectedGroupsLoadedForOutput();

  const globalFlags = currentGlobalFlags();
  const enabledCount = groups.reduce(
    (sum, group) => sum + group.entries.filter((entry) => entry.enabled).length,
    0
  );

  if (enabledCount === 0) {
    console.log('No commands selected. Nothing to output.');
    process.exit(0);
  }

  const data = buildCompactConfig(tool, groups, globalFlags, stripGlobal);
  const yaml = serializeCompact(data, tool, strategy);

  process.stdout.write(
    `\n${BOLD}${CYAN}${enabledCount} commands selected.${RESET} What would you like to do?\n`
  );
  process.stdout.write(
    `  ${BOLD}[e]${RESET} edit airlock.yaml directly  ${DIM}(backs up original to .bak)${RESET}\n`
  );
  process.stdout.write(`  ${BOLD}[c]${RESET} copy to clipboard\n`);
  process.stdout.write(`  ${BOLD}[p]${RESET} print to stdout\n`);
  process.stdout.write(`  ${BOLD}[o]${RESET} write to file\n`);
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

  if (action === 'o') {
    const outputPath = `${tool}-commands.yaml`;
    writeFileSync(outputPath, yaml);
    console.log(`${GREEN}✓ Written to ${outputPath}${RESET}`);
    process.exit(0);
  }

  if (action === 'e') {
    const configPath = './airlock.yaml';
    try {
      const raw = readFileSync(configPath, 'utf8');
      const backupPath = configPath.replace(/\.ya?ml$/i, '') + '.bak';
      copyFileSync(configPath, backupPath);

      const doc = parseYaml(raw) as Record<string, unknown>;
      const existingClis = (doc.clis ?? {}) as Record<string, unknown>;
      const newClis = data.clis as Record<string, unknown>;
      doc.clis = { ...existingClis, ...newClis };
      writeFileSync(configPath, stringifyYaml(doc));

      console.log(`${GREEN}✓ Updated ${configPath}${RESET}`);
      console.log(`${DIM}  Original backed up to ${backupPath}${RESET}`);
    } catch {
      console.error(`Could not find ${configPath}. Printing YAML instead:\n`);
      console.log(yaml);
    }
    process.exit(0);
  }

  console.log(`\n${BOLD}${CYAN}# Paste into your airlock.yaml:${RESET}\n`);
  console.log(yaml);
  console.log();
}
