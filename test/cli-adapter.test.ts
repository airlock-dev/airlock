import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CliBackendAdapter } from '../src/backend/cli/adapter.js';
import { CliParamConfig, GatewayConfig } from '../src/config/schema.js';
import type { CliConfig } from '../src/config/schema.js';
import { validateConfig } from '../src/config/loader.js';

function makeCliConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    commands: {},
    max_output_bytes: 30_000,
    ...overrides,
  };
}

describe('CliBackendAdapter', () => {
  it('generates tools from commands config', async () => {
    const config = makeCliConfig({
      commands: {
        status: {
          exec: 'git status',
          description: 'Show git status',
          params: {},
          timeout: 30,
        },
        log: {
          exec: 'git log',
          description: 'Show commit log',
          params: {
            count: { type: 'number', flag: '-n', positional: false, required: false },
          },
          timeout: 30,
        },
      },
    });

    const adapter = new CliBackendAdapter('git', config);
    const tools = await adapter.listTools();

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(['git/status', 'git/log']);
    expect(tools[1].inputSchema.properties).toHaveProperty('count');
  });

  it('executes a simple command', async () => {
    const config = makeCliConfig({
      commands: {
        echo: {
          exec: 'echo {msg}',
          params: { msg: { type: 'string', positional: false, required: true } },
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'test/echo',
      args: { msg: 'hello world' },
      agentId: 'agent1',
    });

    expect(result.success).toBe(true);
    expect((result.data as { stdout: string }).stdout.trim()).toBe('hello world');
  });

  it('rejects tools with wrong prefix', async () => {
    const adapter = new CliBackendAdapter('git', makeCliConfig());
    const result = await adapter.call({
      tool: 'other/status',
      args: {},
      agentId: 'agent1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not belong to adapter');
  });

  it('returns error for unknown command', async () => {
    const adapter = new CliBackendAdapter('test', makeCliConfig());
    const result = await adapter.call({
      tool: 'test/nonexistent',
      args: {},
      agentId: 'agent1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown CLI command/);
  });

  it('returns error for missing required params', async () => {
    const config = makeCliConfig({
      commands: {
        push: {
          exec: 'git push {remote}',
          params: { remote: { type: 'string', positional: false, required: true } },
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('git', config);
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'git/push',
      args: {},
      agentId: 'agent1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Required parameter/);
  });

  it('reports non-zero exit codes', async () => {
    const config = makeCliConfig({
      commands: {
        fail: {
          exec: 'exit 1',
          params: {},
          timeout: 5,
        },
      },
    });

    const adapter = new CliBackendAdapter('test', config);
    await adapter.listTools();

    const result = await adapter.call({
      tool: 'test/fail',
      args: {},
      agentId: 'agent1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Exit code 1/);
  });

  it('builds input schema with required fields', async () => {
    const config = makeCliConfig({
      commands: {
        cmd: {
          exec: 'mycmd',
          params: {
            name: { type: 'string', positional: false, required: true, description: 'The name' },
            verbose: { type: 'boolean', flag: '-v', positional: false, required: false },
          },
          timeout: 30,
        },
      },
    });

    const adapter = new CliBackendAdapter('app', config);
    const tools = await adapter.listTools();
    const schema = tools[0].inputSchema;

    expect(schema.required).toEqual(['name']);
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('verbose');
  });
});

describe('CliParamConfig flag validation', () => {
  it('accepts valid flags', () => {
    expect(CliParamConfig.parse({ type: 'string', flag: '-n' }).flag).toBe('-n');
    expect(CliParamConfig.parse({ type: 'boolean', flag: '--verbose' }).flag).toBe('--verbose');
  });

  it('rejects flags that do not start with a dash', () => {
    expect(() => CliParamConfig.parse({ type: 'string', flag: 'bad' })).toThrow(/dash/i);
    expect(() => CliParamConfig.parse({ type: 'string', flag: 'rm -rf /' })).toThrow(/dash/i);
  });

  it('allows omitting flag entirely', () => {
    const result = CliParamConfig.parse({ type: 'string' });
    expect(result.flag).toBeUndefined();
  });
});

describe('validateConfig CLI warnings', () => {
  it('warns on unreachable params (no flag, not positional, not in template)', () => {
    const config = GatewayConfig.parse({
      clis: {
        mycli: {
          commands: {
            run: {
              exec: 'mycli run',
              params: {
                orphan: { type: 'string' },
              },
            },
          },
        },
      },
    });

    const diagnostics = validateConfig(config);
    const warn = diagnostics.find((d) => d.message.includes('orphan'));
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warn');
    expect(warn!.message).toContain('will be ignored');
  });

  it('does not warn when param is referenced in template', () => {
    const config = GatewayConfig.parse({
      clis: {
        mycli: {
          commands: {
            run: {
              exec: 'mycli run {name}',
              params: {
                name: { type: 'string' },
              },
            },
          },
        },
      },
    });

    const diagnostics = validateConfig(config);
    const warn = diagnostics.find((d) => d.message.includes('name'));
    expect(warn).toBeUndefined();
  });

  it('does not warn when param has a flag', () => {
    const config = GatewayConfig.parse({
      clis: {
        mycli: {
          commands: {
            run: {
              exec: 'mycli run',
              params: {
                verbose: { type: 'boolean', flag: '--verbose' },
              },
            },
          },
        },
      },
    });

    const diagnostics = validateConfig(config);
    const warn = diagnostics.find((d) => d.message.includes('verbose'));
    expect(warn).toBeUndefined();
  });

  it('does not warn when param is positional', () => {
    const config = GatewayConfig.parse({
      clis: {
        mycli: {
          commands: {
            run: {
              exec: 'mycli run',
              params: {
                file: { type: 'string', positional: true },
              },
            },
          },
        },
      },
    });

    const diagnostics = validateConfig(config);
    const warn = diagnostics.find((d) => d.message.includes('file'));
    expect(warn).toBeUndefined();
  });
});

describe('discovered commands merge', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `airlock-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges discovered commands with inline commands', async () => {
    const discoveredPath = join(tmpDir, 'discovered.yaml');
    writeFileSync(
      discoveredPath,
      `commands:
  status:
    exec: 'git status'
    timeout: 10
  diff:
    exec: 'git diff'
    timeout: 10
`
    );

    const config = makeCliConfig({
      discovered: discoveredPath,
      commands: {
        log: { exec: 'git log', params: {}, timeout: 30 },
      },
    });

    const adapter = new CliBackendAdapter('git', config);
    const tools = await adapter.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('git/status');
    expect(names).toContain('git/diff');
    expect(names).toContain('git/log');
  });

  it('inline commands override discovered commands with same name', async () => {
    const discoveredPath = join(tmpDir, 'override.yaml');
    writeFileSync(
      discoveredPath,
      `commands:
  status:
    exec: 'git status --short'
    description: 'discovered version'
    timeout: 10
`
    );

    const config = makeCliConfig({
      discovered: discoveredPath,
      commands: {
        status: {
          exec: 'git status --long',
          description: 'inline version',
          params: {},
          timeout: 30,
        },
      },
    });

    const adapter = new CliBackendAdapter('git', config);
    const tools = await adapter.listTools();
    const statusTool = tools.find((t) => t.name === 'git/status');

    expect(statusTool).toBeDefined();
    expect(statusTool!.description).toBe('inline version');
  });

  it('skips invalid discovered commands gracefully', async () => {
    const discoveredPath = join(tmpDir, 'invalid.yaml');
    writeFileSync(
      discoveredPath,
      `commands:
  bad:
    notAnExecField: 'oops'
`
    );

    const config = makeCliConfig({
      discovered: discoveredPath,
      commands: {
        good: { exec: 'echo ok', params: {}, timeout: 5 },
      },
    });

    const adapter = new CliBackendAdapter('git', config);
    const tools = await adapter.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toEqual(['git/good']);
  });

  it('handles missing discovered file gracefully', async () => {
    const config = makeCliConfig({
      discovered: join(tmpDir, 'nonexistent.yaml'),
      commands: {
        echo: { exec: 'echo hi', params: {}, timeout: 5 },
      },
    });

    const adapter = new CliBackendAdapter('test', config);
    const tools = await adapter.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test/echo');
  });
});

describe('output truncation', () => {
  it('truncates stdout exceeding maxOutputBytes', async () => {
    // Generate 200 bytes of output, cap at 100
    const config = makeCliConfig({
      commands: {
        big: { exec: 'head -c 200 /dev/zero | tr "\\0" "A"', params: {}, timeout: 5 },
      },
    });

    const adapter = new CliBackendAdapter('test', config, { maxOutputBytes: 100 });
    const result = await adapter.call({ tool: 'test/big', args: {}, agentId: 'a1' });

    expect(result.success).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    const stdout = (result.data as { stdout: string }).stdout;
    expect(stdout.length).toBeLessThanOrEqual(100);
  });

  it('does not truncate output within limit', async () => {
    const config = makeCliConfig({
      commands: {
        small: { exec: 'echo hello', params: {}, timeout: 5 },
      },
    });

    const adapter = new CliBackendAdapter('test', config, { maxOutputBytes: 1000 });
    const result = await adapter.call({ tool: 'test/small', args: {}, agentId: 'a1' });

    expect(result.success).toBe(true);
    expect(result.metadata?.truncated).toBe(false);
    expect((result.data as { stdout: string }).stdout.trim()).toBe('hello');
  });
});

describe('timeout handling', () => {
  it('kills command that exceeds timeout', async () => {
    const config = makeCliConfig({
      commands: {
        slow: { exec: 'sleep 60', params: {}, timeout: 1 },
      },
    });

    const adapter = new CliBackendAdapter('test', config);
    const result = await adapter.call({ tool: 'test/slow', args: {}, agentId: 'a1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
  }, 15_000);
});
