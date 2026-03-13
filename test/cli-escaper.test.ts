import { describe, it, expect } from 'vitest';
import { escapeShellArg } from '../src/backend/cli/escaper.js';

describe('escapeShellArg()', () => {
  it('wraps simple string in single quotes', () => {
    expect(escapeShellArg('hello')).toBe("'hello'");
  });

  it('handles empty string', () => {
    expect(escapeShellArg('')).toBe("''");
  });

  it('escapes internal single quotes', () => {
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
  });

  it('handles spaces', () => {
    expect(escapeShellArg('hello world')).toBe("'hello world'");
  });

  it('prevents semicolon injection: ; rm -rf /', () => {
    const escaped = escapeShellArg('; rm -rf /');
    expect(escaped).toBe("'; rm -rf /'");
  });

  it('prevents command substitution: $(curl evil)', () => {
    const escaped = escapeShellArg('$(curl evil)');
    expect(escaped).toBe("'$(curl evil)'");
  });

  it('prevents backtick substitution: `whoami`', () => {
    const escaped = escapeShellArg('`whoami`');
    expect(escaped).toBe("'`whoami`'");
  });

  it('prevents && chaining: && echo pwned', () => {
    const escaped = escapeShellArg('&& echo pwned');
    expect(escaped).toBe("'&& echo pwned'");
  });

  it('prevents pipe chains: | cat /etc/passwd', () => {
    const escaped = escapeShellArg('| cat /etc/passwd');
    expect(escaped).toBe("'| cat /etc/passwd'");
  });

  it('handles double quotes', () => {
    expect(escapeShellArg('"quoted"')).toBe("'\"quoted\"'");
  });

  it('handles backslashes', () => {
    expect(escapeShellArg('back\\slash')).toBe("'back\\slash'");
  });

  it('handles newlines', () => {
    expect(escapeShellArg('line1\nline2')).toBe("'line1\nline2'");
  });

  it('handles tabs', () => {
    expect(escapeShellArg('col1\tcol2')).toBe("'col1\tcol2'");
  });

  it('handles unicode', () => {
    expect(escapeShellArg('こんにちは')).toBe("'こんにちは'");
  });

  it('rejects null bytes', () => {
    expect(() => escapeShellArg('bad\0input')).toThrow(/null bytes/);
  });

  it('handles dollar signs (variable expansion)', () => {
    expect(escapeShellArg('$HOME')).toBe("'$HOME'");
  });

  it('handles multiple single quotes', () => {
    expect(escapeShellArg("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('handles glob characters', () => {
    expect(escapeShellArg('*.txt')).toBe("'*.txt'");
  });

  it('handles redirection operators', () => {
    expect(escapeShellArg('> /etc/passwd')).toBe("'> /etc/passwd'");
    expect(escapeShellArg('>> /tmp/log')).toBe("'>> /tmp/log'");
    expect(escapeShellArg('< /dev/null')).toBe("'< /dev/null'");
  });
});
