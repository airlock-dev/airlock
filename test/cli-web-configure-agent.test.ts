import { describe, expect, it } from 'vitest';
import {
  mergeAgentRules,
  resolveExistingDecision,
  type Decision,
  type ToolEntry,
} from '../src/configure-agent/cli.js';

function entry(namespacedName: string, decision: Decision): ToolEntry {
  return { namespacedName, description: '', annotations: {}, decision, suspiciousPatterns: [] };
}

describe('configure-agent resolveExistingDecision()', () => {
  it('uses the most specific pattern, ties deny > ask > allow', () => {
    const rules = {
      allow: ['filesystem/*'],
      ask: ['filesystem/write_file'],
      deny: ['github/*'],
    };
    expect(resolveExistingDecision(rules, 'filesystem/read_file')).toBe('allow');
    expect(resolveExistingDecision(rules, 'filesystem/write_file')).toBe('ask');
    expect(resolveExistingDecision(rules, 'github/create_pr')).toBe('deny');
    expect(resolveExistingDecision(rules, 'slack/post')).toBeNull();
    expect(resolveExistingDecision({ allow: ['x/a'], ask: [], deny: ['x/a'] }, 'x/a')).toBe('deny');
  });
});

describe('configure-agent mergeAgentRules()', () => {
  it('keeps patterns the TUI did not show: wildcards, built-ins and silent providers', () => {
    const existing = {
      allow: ['filesystem/*', 'exec/run', 'slow/list', 'echo/echo'],
      ask: ['http/*'],
      deny: ['echo/add'],
    };
    const merged = mergeAgentRules(existing, [
      entry('filesystem/read_file', 'allow'),
      entry('filesystem/delete_file', 'ask'),
      entry('echo/echo', 'deny'),
      entry('echo/add', 'deny'),
    ]);

    expect(merged.allow).toEqual(['filesystem/*', 'exec/run', 'slow/list']);
    expect(merged.ask).toEqual(['http/*', 'filesystem/delete_file']);
    expect(merged.deny).toEqual(['echo/echo', 'echo/add']);
  });

  it('adds no exact rule a kept wildcard already covers, but keeps one that existed', () => {
    const merged = mergeAgentRules({ allow: ['github/*', 'github/get_me'], ask: [], deny: [] }, [
      entry('github/list_prs', 'allow'),
      entry('github/get_me', 'allow'),
    ]);
    expect(merged.allow).toEqual(['github/*', 'github/get_me']);
  });

  it('writes every listed tool for an agent with no rules yet', () => {
    const merged = mergeAgentRules({ allow: [], ask: [], deny: [] }, [
      entry('echo/echo', 'allow'),
      entry('echo/add', 'ask'),
      entry('echo/rm', 'deny'),
    ]);
    expect(merged).toEqual({ allow: ['echo/echo'], ask: ['echo/add'], deny: ['echo/rm'] });
  });
});
