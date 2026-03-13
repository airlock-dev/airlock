import { describe, it, expect } from 'vitest';
import { CliBackendAdapter } from '../src/backend/cli/adapter.js';
import { CliParamConfig, GatewayConfig } from '../src/config/schema.js';
import type { CliConfig } from '../src/config/schema.js';
import { validateConfig } from '../src/config/loader.js';

function makeCliConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    commands: {},
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
