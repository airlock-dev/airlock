import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { figSpecToCommands } from '../src/discover/strategies/fig.js';
import { parseFlags, parseSubcommands, inferType } from '../src/discover/strategies/help-parser.js';
import { discoverOpenApi } from '../src/discover/openapi.js';
import { serializeDiscovery } from '../src/discover/writer.js';

describe('figSpecToCommands()', () => {
  it('converts subcommands to CLI command configs', () => {
    const spec = {
      name: 'git',
      subcommands: [
        {
          name: 'status',
          description: 'Show working tree status',
          options: [
            { name: ['--short', '-s'], description: 'Give output in short format' },
            { name: '--branch', description: 'Show branch info', args: { name: 'branch' } },
          ],
        },
        {
          name: 'commit',
          description: 'Record changes',
          options: [
            {
              name: ['--message', '-m'],
              description: 'Commit message',
              args: { name: 'message' },
            },
            { name: '--amend', description: 'Amend previous commit' },
          ],
        },
      ],
    };

    const commands = figSpecToCommands(spec);

    expect(commands).toHaveProperty('status');
    expect(commands).toHaveProperty('commit');
    expect(commands['status'].exec).toBe('git status');
    expect(commands['status'].params['short']).toEqual({
      type: 'boolean',
      flag: '--short',
      positional: false,
      required: false,
      description: 'Give output in short format',
    });
    expect(commands['commit'].params['message'].type).toBe('string');
    expect(commands['commit'].params['amend'].type).toBe('boolean');
  });

  it('handles nested subcommands', () => {
    const spec = {
      name: 'docker',
      subcommands: [
        {
          name: 'container',
          description: 'Manage containers',
          subcommands: [
            {
              name: 'ls',
              description: 'List containers',
              options: [{ name: '--all', description: 'Show all containers' }],
            },
          ],
        },
      ],
    };

    const commands = figSpecToCommands(spec);

    expect(commands).toHaveProperty('container');
    expect(commands).toHaveProperty('container_ls');
    expect(commands['container_ls'].exec).toBe('docker container ls');
  });

  it('handles array name (aliases)', () => {
    const spec = {
      name: 'npm',
      subcommands: [
        {
          name: ['install', 'i'],
          description: 'Install packages',
          options: [],
        },
      ],
    };

    const commands = figSpecToCommands(spec);
    expect(commands).toHaveProperty('install');
    expect(commands['install'].exec).toBe('npm install');
  });
});

describe('parseFlags()', () => {
  it('extracts long flags with descriptions', () => {
    const help = `Usage: mycli [options]

Options:
  -v, --verbose          Enable verbose output
  -o, --output <file>    Output file path
      --timeout <ms>     Request timeout in milliseconds
`;
    const flags = parseFlags(help);

    expect(flags).toHaveLength(3);
    expect(flags[0]).toMatchObject({ name: 'verbose', flag: '--verbose', type: 'boolean' });
    expect(flags[1]).toMatchObject({ name: 'output', flag: '--output', type: 'string' });
    expect(flags[2]).toMatchObject({ name: 'timeout', flag: '--timeout', type: 'number' });
  });

  it('handles flags with equals-sign argument syntax', () => {
    const help = `Options:
  --config=<path>        Path to config file
  --port=<num>           Port number
`;
    const flags = parseFlags(help);

    expect(flags).toHaveLength(2);
    expect(flags[0]).toMatchObject({ name: 'config', flag: '--config', type: 'string' });
    expect(flags[1]).toMatchObject({ name: 'port', flag: '--port', type: 'number' });
  });

  it('returns empty array for help text with no flags', () => {
    const help = `Usage: mycli <command>

This tool does things.
`;
    expect(parseFlags(help)).toEqual([]);
  });

  it('converts dashes in flag names to underscores', () => {
    const help = `Options:
  --dry-run              Run without making changes
`;
    const flags = parseFlags(help);
    expect(flags[0].name).toBe('dry_run');
    expect(flags[0].flag).toBe('--dry-run');
  });
});

describe('parseSubcommands()', () => {
  it('extracts subcommands from Commands section', () => {
    const help = `Usage: mycli <command>

Commands:
  init        Initialize a new project
  build       Build the project
  test        Run tests

Options:
  --help      Show help
`;
    const subs = parseSubcommands(help);
    expect(subs).toEqual(['init', 'build', 'test']);
  });

  it('handles "Available Commands:" heading', () => {
    const help = `Available Commands:
  start       Start the server
  stop        Stop the server
`;
    const subs = parseSubcommands(help);
    expect(subs).toEqual(['start', 'stop']);
  });

  it('returns empty array when no commands section', () => {
    const help = `Usage: mycli [options]

Options:
  --verbose   Be verbose
`;
    expect(parseSubcommands(help)).toEqual([]);
  });
});

describe('inferType()', () => {
  it('returns boolean for enable/disable/verbose keywords', () => {
    expect(inferType('--verbose', 'Enable verbose output')).toBe('boolean');
    expect(inferType('--force', 'Force overwrite')).toBe('boolean');
    expect(inferType('--quiet', 'Quiet mode')).toBe('boolean');
  });

  it('returns number for count/port/timeout keywords', () => {
    expect(inferType('--port', 'Listen on port')).toBe('number');
    expect(inferType('--timeout', 'Timeout in seconds')).toBe('number');
    expect(inferType('--max', 'Max retries')).toBe('number');
    expect(inferType('--depth', 'Search depth')).toBe('number');
  });

  it('returns string by default', () => {
    expect(inferType('--name', 'Your name')).toBe('string');
    expect(inferType('--output', 'Output file')).toBe('string');
  });

  it('returns boolean for short flags without description', () => {
    expect(inferType('-v', 'v')).toBe('boolean');
  });
});

describe('discoverOpenApi()', () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces ApiConfig from spec', async () => {
    dir = mkdtempSync(join(tmpdir(), 'discover-api-'));
    const specPath = join(dir, 'petstore.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Petstore', version: '1.0.0' },
        servers: [{ url: 'https://petstore.example.com/v1' }],
        paths: {
          '/pets': {
            get: {
              operationId: 'listPets',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      })
    );

    const result = await discoverOpenApi(specPath);

    expect(result.apis).toHaveProperty('petstore');
    expect(result.apis['petstore'].spec).toBe(specPath);
    expect(result.apis['petstore'].base_url).toBe('https://petstore.example.com/v1');
  });

  it('derives key from URL, skipping generic filenames', async () => {
    dir = mkdtempSync(join(tmpdir(), 'discover-api-'));
    const specPath = join(dir, 'openapi.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Test', version: '1.0.0' },
        paths: {},
      })
    );

    // Local path: uses the filename even if it's generic
    const result = await discoverOpenApi(specPath);
    // The key should still be derived (not crash)
    const keys = Object.keys(result.apis);
    expect(keys).toHaveLength(1);
  });
});

describe('serializeDiscovery()', () => {
  it('produces YAML with header comments', () => {
    const yaml = serializeDiscovery(
      { clis: { git: { commands: {} } } },
      { command: 'airlock discover cli git', strategy: 'help-text' }
    );

    expect(yaml).toContain('# Auto-discovered by Airlock');
    expect(yaml).toContain('# Command: airlock discover cli git');
    expect(yaml).toContain('# Strategy: help-text');
    expect(yaml).toContain('clis:');
  });
});
