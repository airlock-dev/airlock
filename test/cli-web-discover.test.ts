import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { figSpecToCommands } from '../src/discover/strategies/fig.js';
import { discoverCli } from '../src/discover/strategies/help-parser.js';

const spec = {
  name: 'docker',
  subcommands: [
    {
      name: 'container',
      subcommands: [
        { name: 'ls', subcommands: [{ name: 'deep' }] },
        { name: 'rm', options: [{ name: '--force' }] },
      ],
    },
    { name: 'image', subcommands: [{ name: 'ls' }] },
    { name: 'version' },
  ],
};

describe('figSpecToCommands() filters', () => {
  it('stops at --max-depth (default 2)', () => {
    expect(Object.keys(figSpecToCommands(spec)).sort()).toEqual([
      'container',
      'container_ls',
      'container_rm',
      'image',
      'image_ls',
      'version',
    ]);
    expect(Object.keys(figSpecToCommands(spec, { maxDepth: 1 })).sort()).toEqual([
      'container',
      'image',
      'version',
    ]);
    expect(figSpecToCommands(spec, { maxDepth: 3 })).toHaveProperty('container_ls_deep');
  });

  it('registers only --include commands but still walks to them', () => {
    expect(Object.keys(figSpecToCommands(spec, { include: ['container_rm', 'image_ls'] }))).toEqual(
      ['container_rm', 'image_ls']
    );
  });

  it('drops an --exclude command and everything beneath it', () => {
    const commands = figSpecToCommands(spec, { exclude: ['container'] });
    expect(Object.keys(commands).sort()).toEqual(['image', 'image_ls', 'version']);
  });
});

describe('discoverCli() --exclude', () => {
  it('drops an excluded group without flags and everything beneath it, like the fig strategy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-help-'));
    const tool = join(dir, 'faketool');
    writeFileSync(
      tool,
      [
        '#!/bin/sh',
        'case "$*" in',
        `  "--help") printf 'Usage\\n\\nCommands:\\n  remote   Manage remotes\\n  version  Show version\\n' ;;`,
        `  "remote --help") printf 'Manage remotes\\n\\nCommands:\\n  branch  Branches\\n  add     Add\\n' ;;`,
        `  "remote branch --help") printf 'Branches\\n\\nCommands:\\n  list  List\\n' ;;`,
        `  "remote branch list --help") printf 'List\\n\\n  --all  Show all\\n' ;;`,
        `  "remote add --help") printf 'Add\\n\\n  --name <n>  Remote name\\n' ;;`,
        `  "version --help") printf 'Version\\n' ;;`,
        'esac',
      ].join('\n')
    );
    chmodSync(tool, 0o755);
    try {
      const all = Object.keys(discoverCli(tool, { maxDepth: 3 })).sort();
      expect(all).toEqual(['remote_add', 'remote_branch_list', 'version']);

      const excluded = Object.keys(discoverCli(tool, { maxDepth: 3, exclude: ['remote_branch'] }));
      expect(excluded.sort()).toEqual(['remote_add', 'version']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('discoverCliCommands() completion detection', () => {
  afterEach(() => {
    vi.doUnmock('../src/discover/strategies/fig.js');
    vi.doUnmock('../src/discover/strategies/completion.js');
    vi.doUnmock('../src/discover/strategies/help-parser.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('passes filters to Fig and never runs a separate detection pass', async () => {
    const figSpecToCommandsMock = vi.fn(() => ({}));
    const detect = vi.fn(() => 'click');
    vi.doMock('../src/discover/strategies/fig.js', () => ({
      fetchFigSpec: vi.fn(async () => ({ name: 'tool', subcommands: [] })),
      figSpecToCommands: figSpecToCommandsMock,
    }));
    vi.doMock('../src/discover/strategies/completion.js', () => ({
      detectCompletionSupport: detect,
      discoverViaCompletion: vi.fn(() => ({ adapterId: 'click', commands: {} })),
      deduplicateAliases: vi.fn((commands) => commands),
    }));
    vi.doMock('../src/discover/strategies/help-parser.js', () => ({ discoverCli: vi.fn() }));

    const { discoverCliCommands } = await import('../src/discover/index.js');
    await discoverCliCommands({ tool: 'tool', fromFig: true, maxDepth: 1, include: ['a'] });
    expect(figSpecToCommandsMock).toHaveBeenCalledWith(expect.anything(), {
      maxDepth: 1,
      include: ['a'],
      exclude: undefined,
    });

    const result = await discoverCliCommands({ tool: 'tool' });
    expect(result.strategy).toBe('completion:click');
    expect(detect).not.toHaveBeenCalled();
  });
});

describe('completion probes', () => {
  let dir: string | undefined;

  afterEach(() => {
    delete process.env.AIRLOCK_PROBE_TEST_LOG;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('run the tool in an empty scratch directory, not the caller cwd', async () => {
    dir = mkdtempSync(join(tmpdir(), 'airlock-cwd-test-'));
    const log = join(dir, 'cwd.log');
    const tool = join(dir, 'tool.sh');
    // A tool with no completion protocol at all: it records where it ran and fails.
    writeFileSync(tool, '#!/bin/sh\npwd >> "$AIRLOCK_PROBE_TEST_LOG"\nexit 1\n');
    chmodSync(tool, 0o755);
    process.env.AIRLOCK_PROBE_TEST_LOG = log;

    const { detectCompletionSupport } = await import('../src/discover/strategies/completion.js');
    expect(detectCompletionSupport(tool)).toBeNull();

    const cwds = new Set(readFileSync(log, 'utf8').trim().split('\n'));
    expect(cwds.size).toBe(1);
    const [cwd] = [...cwds];
    expect(cwd).not.toBe(process.cwd());
    expect(basename(cwd)).toMatch(/^airlock-probe-/);
  });
});
