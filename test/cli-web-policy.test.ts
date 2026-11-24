import { describe, expect, it } from 'vitest';
import { explainResolution, resolve } from '../web/src/policy.js';

// The dashboard's own rule resolution (it must agree with src/allowlist/engine.ts).
describe('web policy resolve()', () => {
  it('resolves decisions with wildcard specificity', () => {
    const rules = {
      allow: ['ticktick/*'],
      ask: ['ticktick/delete_task'],
      deny: ['github/*'],
    };

    expect(resolve(rules, 'ticktick/create_task').decision).toBe('allow');
    expect(resolve(rules, 'ticktick/delete_task').decision).toBe('ask');
    expect(resolve(rules, 'github/create_pr').decision).toBe('deny');
    expect(resolve(rules, 'ticktick/project/archive').decision).toBe('none');
  });

  it('reports the pattern a decision came from', () => {
    const rules = {
      allow: ['ticktick/*', 'github/create_pr'],
      ask: [],
      deny: [],
    };

    expect(resolve(rules, 'ticktick/create_task')).toEqual({
      decision: 'allow',
      pattern: 'ticktick/*',
    });
    expect(resolve(rules, 'github/create_pr')).toEqual({
      decision: 'allow',
      pattern: 'github/create_pr',
    });
    expect(resolve(rules, 'slack/post_message')).toEqual({ decision: 'none' });
  });

  it('breaks specificity ties deny > ask > allow', () => {
    const rules = { allow: ['github/*'], ask: ['github/*'], deny: ['github/*'] };
    expect(resolve(rules, 'github/create_pr').decision).toBe('deny');
    expect(resolve({ ...rules, deny: [] }, 'github/create_pr').decision).toBe('ask');
  });
});

describe('web policy explainResolution()', () => {
  const profiles = {
    'base-read': {
      extends: [],
      allow: ['github/list*', 'github/get_*'],
      ask: ['github/*'],
      deny: ['github/delete_repo'],
    },
    'default-safe': {
      extends: [],
      allow: ['exec/run'],
      ask: [],
      deny: [],
    },
  };

  it('explains winning profile rules and specificity precedence', () => {
    const own = {
      extends: ['base-read'],
      allow: [],
      ask: ['github/create_pr'],
      deny: [],
    };
    const res = explainResolution(own, profiles, 'github/list_prs', 'default-safe', 'agent "dev"');
    expect(res.decision).toBe('allow');
    expect(res.winner?.pattern).toBe('github/list*');
    expect(res.winner?.source).toBe('profile "base-read"');
    expect(res.matches.length).toBe(2);
    expect(res.matches[0].isWinner).toBe(true);
    expect(res.matches[1].isWinner).toBe(false);
  });

  it('explains tie-breaking deny > ask > allow across own and inherited rules', () => {
    const own = {
      extends: ['base-read'],
      allow: ['github/delete_repo'],
      ask: [],
      deny: [],
    };
    const res = explainResolution(own, profiles, 'github/delete_repo', undefined, 'agent "dev"');
    expect(res.decision).toBe('deny');
    expect(res.winner?.source).toBe('profile "base-read"');
    expect(res.reason).toContain('precedence');
  });

  it('reports default-deny when no rule matches', () => {
    const own = { extends: [], allow: ['github/*'], ask: [], deny: [] };
    const res = explainResolution(own, profiles, 'slack/post_message');
    expect(res.decision).toBe('none');
    expect(res.matches).toEqual([]);
    expect(res.reason).toContain('default');
  });
});
