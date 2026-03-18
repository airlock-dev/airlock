import { afterEach, describe, expect, it, vi } from 'vitest';

describe('completion adapters', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('child_process');
  });

  it('detects and discovers Click/Typer-style completion', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(
        (bin: string, args: string[], options?: { env?: Record<string, string> }) => {
          if (bin !== 'tool') {
            throw Object.assign(new Error('unexpected binary'), { stdout: '' });
          }

          const env = options?.env ?? {};
          if (args[0] === '__complete') {
            throw Object.assign(new Error('no cobra'), { stdout: '' });
          }

          if (env._TOOL_COMPLETE === 'bash_complete') {
            const words = env.COMP_WORDS;
            if (words === 'tool')
              return 'plain,build\tBuild project\nplain,deploy\tDeploy project\n';
            if (words === 'tool -') return 'plain,--verbose\tVerbose output\n';
            if (words === 'tool build') return 'plain,--tag\tBuild tag\n';
            if (words === 'tool build -') return 'plain,--tag\tBuild tag\n';
            if (words === 'tool deploy') return 'plain,--region\tRegion name\n';
            if (words === 'tool deploy -') return 'plain,--region\tRegion name\n';
            return '';
          }

          if (args.includes('--help')) {
            return 'Help line\n';
          }

          throw Object.assign(new Error('unsupported invocation'), { stdout: '' });
        }
      ),
    }));

    const { detectCompletionSupport, discoverViaCompletion } =
      await import('../src/discover/strategies/completion.js');

    expect(detectCompletionSupport('tool')).toBe('click');

    const result = discoverViaCompletion('tool');
    expect(result?.adapterId).toBe('click');
    expect(result?.commands).toHaveProperty('build');
    expect(result?.commands['build'].params).toHaveProperty('tag');
  });

  it('detects Clap env completion when Cobra and Click are unavailable', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(
        (bin: string, args: string[], options?: { env?: Record<string, string> }) => {
          if (bin !== 'tool') {
            throw Object.assign(new Error('unexpected binary'), { stdout: '' });
          }

          const env = options?.env ?? {};
          if (args[0] === '__complete') {
            throw Object.assign(new Error('no cobra'), { stdout: '' });
          }

          if (env._TOOL_COMPLETE === 'bash_complete') {
            throw Object.assign(new Error('no click'), { stdout: '' });
          }

          if (env.COMPLETE === 'bash') {
            return 'serve\n';
          }

          throw Object.assign(new Error('unsupported invocation'), { stdout: '' });
        }
      ),
    }));

    const { detectCompletionSupport } = await import('../src/discover/strategies/completion.js');
    expect(detectCompletionSupport('tool')).toBe('clap');
  });
});
