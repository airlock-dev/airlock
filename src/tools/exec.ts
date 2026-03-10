import { spawn } from 'child_process';
import type { AgentConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { matchesCommand } from '../allowlist/pattern.js';

export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

export type ExecDecision = 'allow' | 'hitl' | 'deny';

export function buildExecTool(): Tool {
  return {
    name: 'exec/run',
    description: 'Run a shell command in a controlled environment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command:    { type: 'string', description: 'Shell command to run' },
        cwd:        { type: 'string', description: 'Working directory' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
  };
}

export function evaluateExecCommand(command: string, agentConfig: AgentConfig): ExecDecision {
  // Deny takes priority
  if (agentConfig.exec.deny.some(p => matchesCommand(p, command))) return 'deny';
  if (agentConfig.exec.hitl.some(p => matchesCommand(p, command))) return 'hitl';
  if (agentConfig.exec.allow.some(p => matchesCommand(p, command))) return 'allow';
  return 'deny'; // fail-closed
}

export async function executeExec(
  command: string,
  agentConfig: AgentConfig,
  cwd?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const timeout = timeoutMs ?? agentConfig.exec.default_timeout_ms;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: agentConfig.exec.env,
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
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        stdout,
        stderr,
        duration_ms: Date.now() - start,
        timed_out: timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
