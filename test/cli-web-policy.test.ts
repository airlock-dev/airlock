import { describe, expect, it } from 'vitest';
import { resolve } from '../web/src/policy.js';

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
