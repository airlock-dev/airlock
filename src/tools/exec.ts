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
  truncated?: boolean;
}

export type ExecDecision = 'allow' | 'hitl' | 'deny';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap on stdout/stderr

/** Shell metacharacters that allow command chaining / injection */
const SHELL_INJECTION_RE = /[;|&`$(){}]/;

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

/**
 * Reject commands containing shell metacharacters that could bypass
 * the prefix-based allow/deny matching (e.g. chaining via ; && || | $()).
 */
export function containsShellInjection(command: string): boolean {
  return SHELL_INJECTION_RE.test(command);
}

export function evaluateExecCommand(command: string, agentConfig: AgentConfig): ExecDecision {
  // Reject shell injection regardless of allow/deny patterns
  if (containsShellInjection(command)) return 'deny';

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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        stdout += chunk.slice(0, remaining).toString();
      } else {
        truncated = true;
      }
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        stderr += chunk.slice(0, remaining).toString();
      } else {
        truncated = true;
      }
      stderrBytes += chunk.length;
    });

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
        truncated,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
