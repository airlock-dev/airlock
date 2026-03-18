import { describe, it, expect } from 'vitest';
import { normalizeTool, isSimpleCommand, extractExecutable } from '../src/hook/normalizer.js';

describe('isSimpleCommand', () => {
  describe('simple commands (returns true)', () => {
    it('single command with no args', () => {
      expect(isSimpleCommand('ls')).toBe(true);
      expect(isSimpleCommand('pwd')).toBe(true);
    });

    it('command with arguments', () => {
      expect(isSimpleCommand('git status')).toBe(true);
      expect(isSimpleCommand('npm test')).toBe(true);
      expect(isSimpleCommand('git log --oneline -n 10')).toBe(true);
    });

    it('command with quoted strings', () => {
      expect(isSimpleCommand('git commit -m "hello world"')).toBe(true);
      expect(isSimpleCommand("echo 'hello world'")).toBe(true);
    });

    it('command with path-prefixed executable', () => {
      expect(isSimpleCommand('/usr/bin/git log --oneline')).toBe(true);
      expect(isSimpleCommand('./scripts/build.sh')).toBe(true);
    });

    it('command with leading env vars', () => {
      expect(isSimpleCommand('FOO=bar git push')).toBe(true);
      expect(isSimpleCommand('NODE_ENV=production npm start')).toBe(true);
    });

    it('command with flags containing equals signs', () => {
      expect(isSimpleCommand('git config --global user.name=foo')).toBe(true);
    });

    it('command with dashes and underscores', () => {
      expect(isSimpleCommand('docker-compose up -d')).toBe(true);
      expect(isSimpleCommand('my_script --verbose')).toBe(true);
    });
  });

  describe('complex commands (returns false)', () => {
    it('pipes', () => {
      expect(isSimpleCommand('echo foo | grep bar')).toBe(false);
      expect(isSimpleCommand('cat file.txt | wc -l')).toBe(false);
    });

    it('AND chains (&&)', () => {
      expect(isSimpleCommand('npm build && npm test')).toBe(false);
      expect(isSimpleCommand('cd dir && ls')).toBe(false);
    });

    it('OR chains (||)', () => {
      expect(isSimpleCommand('test -f file || echo missing')).toBe(false);
    });

    it('semicolons', () => {
      expect(isSimpleCommand('cmd1; cmd2')).toBe(false);
      expect(isSimpleCommand('echo a; echo b; echo c')).toBe(false);
    });

    it('command substitution with $()', () => {
      expect(isSimpleCommand('echo $(whoami)')).toBe(false);
      expect(isSimpleCommand('git tag $(date +%Y%m%d)')).toBe(false);
    });

    it('command substitution with backticks', () => {
      expect(isSimpleCommand('echo `date`')).toBe(false);
      expect(isSimpleCommand('git commit -m `hostname`')).toBe(false);
    });

    it('output redirects', () => {
      expect(isSimpleCommand('echo foo > file.txt')).toBe(false);
      expect(isSimpleCommand('echo foo >> file.txt')).toBe(false);
    });

    it('input redirects', () => {
      expect(isSimpleCommand('cat < input.txt')).toBe(false);
    });

    it('variable expansion', () => {
      expect(isSimpleCommand('echo $HOME')).toBe(false);
      expect(isSimpleCommand('echo ${USER}')).toBe(false);
      expect(isSimpleCommand('cd $GOPATH')).toBe(false);
    });

    it('braces', () => {
      expect(isSimpleCommand('{ cmd1; cmd2; }')).toBe(false);
    });

    it('subshells with parentheses', () => {
      expect(isSimpleCommand('(cd /tmp && ls)')).toBe(false);
    });

    it('background with &', () => {
      expect(isSimpleCommand('sleep 10 &')).toBe(false);
    });

    it('multiple metacharacters combined', () => {
      expect(isSimpleCommand('curl url | sh && echo done > /tmp/log')).toBe(false);
    });
  });
});

describe('extractExecutable', () => {
  describe('basic extraction', () => {
    it('extracts from simple commands', () => {
      expect(extractExecutable('git status')).toBe('git');
      expect(extractExecutable('npm test')).toBe('npm');
      expect(extractExecutable('gh pr list')).toBe('gh');
      expect(extractExecutable('docker ps')).toBe('docker');
    });

    it('extracts single-word commands (no arguments)', () => {
      expect(extractExecutable('ls')).toBe('ls');
      expect(extractExecutable('pwd')).toBe('pwd');
      expect(extractExecutable('whoami')).toBe('whoami');
    });

    it('handles multiple arguments after executable', () => {
      expect(extractExecutable('git log --oneline -n 10 --all')).toBe('git');
      expect(extractExecutable('npx vitest run test/foo.test.ts')).toBe('npx');
    });
  });

  describe('path-prefixed commands', () => {
    it('extracts basename from absolute paths', () => {
      expect(extractExecutable('/usr/bin/git log')).toBe('git');
      expect(extractExecutable('/usr/local/bin/npm install')).toBe('npm');
      expect(extractExecutable('/bin/sh -c echo')).toBe('sh');
    });

    it('extracts basename from relative paths', () => {
      expect(extractExecutable('./scripts/build.sh')).toBe('build.sh');
      expect(extractExecutable('../bin/run')).toBe('run');
    });
  });

  describe('leading env var assignments', () => {
    it('skips single env var', () => {
      expect(extractExecutable('FOO=bar git push')).toBe('git');
      expect(extractExecutable('NODE_ENV=test npm run build')).toBe('npm');
    });

    it('skips multiple env vars', () => {
      expect(extractExecutable('A=1 B=2 python3 script.py')).toBe('python3');
      expect(extractExecutable('CC=gcc CXX=g++ make build')).toBe('make');
    });

    it('returns null when only env vars with no command', () => {
      expect(extractExecutable('FOO=bar')).toBeNull();
      expect(extractExecutable('A=1 B=2')).toBeNull();
    });

    it('does not confuse arguments with env vars', () => {
      // These have = in args but after the command
      expect(extractExecutable('git config user.name=foo')).toBe('git');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(extractExecutable('')).toBeNull();
    });

    it('returns null for whitespace-only', () => {
      expect(extractExecutable('   ')).toBeNull();
      expect(extractExecutable('\t\t')).toBeNull();
    });

    it('handles leading/trailing whitespace', () => {
      expect(extractExecutable('  git status  ')).toBe('git');
      expect(extractExecutable('\tgit log')).toBe('git');
    });

    it('handles multiple spaces between tokens', () => {
      expect(extractExecutable('git    status')).toBe('git');
    });
  });
});

describe('normalizeTool', () => {
  describe('claude-code client', () => {
    describe('file tools', () => {
      it('maps Edit → file/edit', () => {
        expect(normalizeTool('claude-code', 'Edit', {})).toEqual({ name: 'file/edit' });
      });

      it('maps Read → file/read', () => {
        expect(normalizeTool('claude-code', 'Read', {})).toEqual({ name: 'file/read' });
      });

      it('maps Write → file/write', () => {
        expect(normalizeTool('claude-code', 'Write', {})).toEqual({ name: 'file/write' });
      });

      it('maps Glob → file/glob', () => {
        expect(normalizeTool('claude-code', 'Glob', {})).toEqual({ name: 'file/glob' });
      });

      it('maps Grep → file/grep', () => {
        expect(normalizeTool('claude-code', 'Grep', {})).toEqual({ name: 'file/grep' });
      });
    });

    describe('http tools', () => {
      it('maps WebFetch → http/fetch', () => {
        expect(normalizeTool('claude-code', 'WebFetch', {})).toEqual({ name: 'http/fetch' });
      });

      it('maps WebSearch → http/search', () => {
        expect(normalizeTool('claude-code', 'WebSearch', {})).toEqual({ name: 'http/search' });
      });
    });

    describe('other tools', () => {
      it('maps Agent → agent/spawn', () => {
        expect(normalizeTool('claude-code', 'Agent', {})).toEqual({ name: 'agent/spawn' });
      });

      it('maps TodoRead → todo/read', () => {
        expect(normalizeTool('claude-code', 'TodoRead', {})).toEqual({ name: 'todo/read' });
      });

      it('maps TodoWrite → todo/write', () => {
        expect(normalizeTool('claude-code', 'TodoWrite', {})).toEqual({ name: 'todo/write' });
      });

      it('maps NotebookEdit → notebook/edit', () => {
        expect(normalizeTool('claude-code', 'NotebookEdit', {})).toEqual({ name: 'notebook/edit' });
      });
    });

    describe('bash tool — simple commands', () => {
      it('normalizes to bash/<executable>', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'git status' })).toEqual({
          name: 'bash/git',
          executable: 'git',
        });
        expect(normalizeTool('claude-code', 'Bash', { command: 'npm test' })).toEqual({
          name: 'bash/npm',
          executable: 'npm',
        });
        expect(normalizeTool('claude-code', 'Bash', { command: 'gh pr list --repo foo/bar' })).toEqual({
          name: 'bash/gh',
          executable: 'gh',
        });
      });

      it('handles path-prefixed executables', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: '/usr/bin/git log' })).toEqual({
          name: 'bash/git',
          executable: 'git',
        });
      });

      it('handles env var prefixed commands', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'NODE_ENV=test npm run build' })).toEqual({
          name: 'bash/npm',
          executable: 'npm',
        });
      });

      it('handles single-word commands', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'ls' })).toEqual({
          name: 'bash/ls',
          executable: 'ls',
        });
      });
    });

    describe('bash tool — complex commands', () => {
      it('normalizes piped commands to bash/_complex', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'echo foo | grep bar' })).toEqual({
          name: 'bash/_complex',
          executable: undefined,
        });
      });

      it('normalizes chained commands to bash/_complex', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'npm build && npm test' })).toEqual({
          name: 'bash/_complex',
          executable: undefined,
        });
      });

      it('normalizes commands with redirects to bash/_complex', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'echo hello > file.txt' })).toEqual({
          name: 'bash/_complex',
          executable: undefined,
        });
      });

      it('normalizes commands with variable expansion to bash/_complex', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'echo $HOME' })).toEqual({
          name: 'bash/_complex',
          executable: undefined,
        });
      });

      it('normalizes commands with subshells to bash/_complex', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 'echo $(whoami)' })).toEqual({
          name: 'bash/_complex',
          executable: undefined,
        });
      });
    });

    describe('bash tool — edge cases', () => {
      it('normalizes empty command to bash/_empty', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: '' })).toEqual({ name: 'bash/_empty' });
      });

      it('normalizes missing command to bash/_empty', () => {
        expect(normalizeTool('claude-code', 'Bash', {})).toEqual({ name: 'bash/_empty' });
      });

      it('normalizes whitespace-only command to bash/_empty', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: '   ' })).toEqual({ name: 'bash/_empty' });
      });

      it('treats non-string command as empty', () => {
        expect(normalizeTool('claude-code', 'Bash', { command: 123 })).toEqual({ name: 'bash/_empty' });
        expect(normalizeTool('claude-code', 'Bash', { command: null })).toEqual({ name: 'bash/_empty' });
        expect(normalizeTool('claude-code', 'Bash', { command: true })).toEqual({ name: 'bash/_empty' });
      });
    });

    describe('unknown tools pass through', () => {
      it('passes MCP-style tool names as-is', () => {
        expect(normalizeTool('claude-code', 'mcp__server__tool', {})).toEqual({
          name: 'mcp__server__tool',
        });
      });

      it('passes arbitrary unknown tool names as-is', () => {
        expect(normalizeTool('claude-code', 'SomeFutureTool', { arg: 'val' })).toEqual({
          name: 'SomeFutureTool',
        });
      });
    });
  });

  describe('unknown client', () => {
    it('passes through all tools as-is regardless of tool name', () => {
      expect(normalizeTool('unknown-client', 'Bash', { command: 'git status' })).toEqual({
        name: 'Bash',
      });
      expect(normalizeTool('unknown-client', 'Edit', {})).toEqual({ name: 'Edit' });
      expect(normalizeTool('unknown-client', 'Read', {})).toEqual({ name: 'Read' });
    });
  });

  describe('tool input is preserved (not mutated)', () => {
    it('does not modify the input object', () => {
      const input = { command: 'git status', other: 'value' };
      const inputCopy = { ...input };
      normalizeTool('claude-code', 'Bash', input);
      expect(input).toEqual(inputCopy);
    });
  });
});
