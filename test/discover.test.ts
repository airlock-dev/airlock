import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { figSpecToCommands } from '../src/discover/strategies/fig.js';
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
            { name: ['--message', '-m'], description: 'Commit message', args: { name: 'message' } },
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
              options: [
                { name: '--all', description: 'Show all containers' },
              ],
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

describe('discoverOpenApi()', () => {
  it('produces ApiConfig from spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discover-api-'));
    const specPath = join(dir, 'petstore.json');
    writeFileSync(specPath, JSON.stringify({
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
    }));

    const result = await discoverOpenApi(specPath);

    expect(result.apis).toHaveProperty('petstore');
    expect(result.apis['petstore'].spec).toBe(specPath);
    expect(result.apis['petstore'].base_url).toBe('https://petstore.example.com/v1');

    rmSync(dir, { recursive: true });
  });
});

describe('serializeDiscovery()', () => {
  it('produces YAML with header comments', () => {
    const yaml = serializeDiscovery(
      { clis: { git: { commands: {} } } },
      { command: 'airlock discover cli git', strategy: 'help-text' },
    );

    expect(yaml).toContain('# Auto-discovered by Airlock');
    expect(yaml).toContain('# Command: airlock discover cli git');
    expect(yaml).toContain('# Strategy: help-text');
    expect(yaml).toContain('clis:');
  });
});
