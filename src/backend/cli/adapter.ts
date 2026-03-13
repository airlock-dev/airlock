import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from '../types.js';
import type { ToolCall, ToolResult } from '../../types.js';
import type { CliConfig, CliCommandConfig } from '../../config/schema.js';
import { buildCommand } from './builder.js';
import { childLogger } from '../../util/logger.js';

const log = childLogger('cli-adapter');

export class CliBackendAdapter implements BackendAdapter {
  readonly id: string;
  private commands: Record<string, CliCommandConfig>;
  private shell: string;
  private defaultCwd?: string;

  constructor(
    private configKey: string,
    private config: CliConfig,
  ) {
    this.id = `cli:${configKey}`;
    this.shell = config.shell ?? '/bin/sh';
    this.defaultCwd = config.cwd;

    // Merge discovered commands with inline commands
    this.commands = { ...config.commands };
    if (config.discovered) {
      try {
        const raw = readFileSync(config.discovered, 'utf-8');
        const parsed = parseYaml(raw);
        if (parsed?.commands && typeof parsed.commands === 'object') {
          this.commands = { ...parsed.commands, ...this.commands }; // inline takes precedence
        }
      } catch (err) {
        log.warn({ err, path: config.discovered }, 'Failed to load discovered CLI config');
      }
    }
  }

  async listTools(): Promise<Tool[]> {
    return Object.entries(this.commands).map(([name, cmd]) => ({
      name: `${this.configKey}/${name}`,
      description: cmd.description ?? `CLI command: ${cmd.exec}`,
      inputSchema: this.buildInputSchema(cmd),
    }));
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const commandName = toolCall.tool.slice(this.configKey.length + 1);
    const cmdConfig = this.commands[commandName];

    if (!cmdConfig) {
      return { success: false, error: `Unknown CLI command: ${commandName}` };
    }

    let fullCommand: string;
    try {
      fullCommand = buildCommand(cmdConfig, toolCall.args);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const cwd = cmdConfig.cwd ?? this.defaultCwd;
    const timeoutMs = cmdConfig.timeout * 1000;

    return this.exec(fullCommand, cwd, timeoutMs);
  }

  async stop(): Promise<void> {}

  private exec(command: string, cwd?: string, timeoutMs = 30000): Promise<ToolResult> {
    return new Promise((resolve) => {
      const child = spawn(this.shell, ['-c', command], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 2000);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ success: false, error: `Command timed out after ${timeoutMs}ms`, metadata: { duration_ms: timeoutMs } });
          return;
        }
        resolve({
          success: code === 0,
          data: { exit_code: code, stdout, stderr },
          error: code !== 0 ? `Exit code ${code}: ${stderr.trim()}` : undefined,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      });
    });
  }

  private buildInputSchema(cmd: CliCommandConfig): Tool['inputSchema'] {
    const properties: Record<string, object> = {};
    const required: string[] = [];

    for (const [name, param] of Object.entries(cmd.params)) {
      const prop: Record<string, unknown> = {};

      switch (param.type) {
        case 'number': prop.type = 'number'; break;
        case 'boolean': prop.type = 'boolean'; break;
        default: prop.type = 'string'; break;
      }

      if (param.description) prop.description = param.description;
      if (param.default !== undefined) prop.default = param.default;

      properties[name] = prop;
      if (param.required) required.push(name);
    }

    return {
      type: 'object' as const,
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
}
