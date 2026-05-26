import { describe, it, expect } from 'vitest';
import { matches, matchesCommand, specificity, bestSpecificity } from '../src/allowlist/pattern.js';
import { AllowlistEngine } from '../src/allowlist/engine.js';
import type { AgentConfig } from '../src/config/schema.js';

// =============================================================================
// Pattern matching
// =============================================================================

describe('matches()', () => {
  it('exact match', () => {
    expect(matches('github/create_pr', 'github/create_pr')).toBe(true);
    expect(matches('github/create_pr', 'github/list_prs')).toBe(false);
  });

  it('wildcard /* suffix', () => {
    expect(matches('github/*', 'github/create_pr')).toBe(true);
    expect(matches('github/*', 'github/list_prs')).toBe(true);
    expect(matches('github/*', 'github2/foo')).toBe(false);
    expect(matches('filesystem/*', 'filesystem/read_file')).toBe(true);
    expect(matches('filesystem/*', 'filesystem2/read')).toBe(false);
  });

  it('does not match nested paths with /*', () => {
    expect(matches('github/*', 'github/foo/bar')).toBe(false);
  });

  it('prefix wildcard with *', () => {
    expect(matches('bash/git*', 'bash/git')).toBe(true);
    expect(matches('bash/git*', 'bash/git-lfs')).toBe(true);
    expect(matches('bash/git*', 'bash/gh')).toBe(false);
  });

  it('bare * matches any prefix (including nothing)', () => {
    expect(matches('*', 'anything')).toBe(true);
    expect(matches('*', '')).toBe(true);
  });

  it('no match returns false', () => {
    expect(matches('github/create_pr', 'slack/send')).toBe(false);
    expect(matches('bash/git*', 'bash/npm')).toBe(false);
  });
});

describe('matchesCommand()', () => {
  it('exact match', () => {
    expect(matchesCommand('git status', 'git status')).toBe(true);
    expect(matchesCommand('git status', 'git push')).toBe(false);
  });

  it('prefix wildcard', () => {
    expect(matchesCommand('git*', 'git status')).toBe(true);
    expect(matchesCommand('git*', 'git push origin main')).toBe(true);
    expect(matchesCommand('git*', 'npm install')).toBe(false);
  });
});

// =============================================================================
// Specificity
// =============================================================================

describe('specificity()', () => {
  describe('no match', () => {
    it('returns -1 for non-matching exact pattern', () => {
      expect(specificity('bash/git', 'bash/npm')).toBe(-1);
    });

    it('returns -1 for non-matching wildcard pattern', () => {
      expect(specificity('bash/git*', 'bash/npm')).toBe(-1);
      expect(specificity('github/*', 'slack/send')).toBe(-1);
    });

    it('returns -1 for non-matching /* pattern with similar prefix', () => {
      expect(specificity('github/*', 'github2/foo')).toBe(-1);
    });
  });

  describe('wildcard matches', () => {
    it('returns prefix length for /* wildcard', () => {
      expect(specificity('bash/*', 'bash/git')).toBe(5); // "bash/" = 5
      expect(specificity('github/*', 'github/create_pr')).toBe(7); // "github/" = 7
    });

    it('returns prefix length for prefix wildcard', () => {
      expect(specificity('bash/git*', 'bash/git')).toBe(8); // "bash/git" = 8
      expect(specificity('bash/git*', 'bash/git-lfs')).toBe(8);
    });

    it('longer prefix = higher specificity', () => {
      const broad = specificity('bash/*', 'bash/git');
      const narrow = specificity('bash/git*', 'bash/git');
      expect(narrow).toBeGreaterThan(broad!);
    });

    it('bare * has specificity 0', () => {
      expect(specificity('*', 'anything')).toBe(0);
    });
  });

  describe('exact matches', () => {
    it('returns length + 1 for exact match', () => {
      expect(specificity('bash/git', 'bash/git')).toBe(9); // 8 + 1
      expect(specificity('file/edit', 'file/edit')).toBe(10); // 9 + 1
    });

    it('exact match beats any wildcard of same prefix length', () => {
      const exact = specificity('bash/git', 'bash/git')!;
      const wildcard = specificity('bash/git*', 'bash/git')!;
      expect(exact).toBeGreaterThan(wildcard);
    });
  });
});

describe('bestSpecificity()', () => {
  it('returns -1 for empty patterns', () => {
    expect(bestSpecificity([], 'bash/git')).toBe(-1);
  });

  it('returns -1 when no patterns match', () => {
    expect(bestSpecificity(['github/*', 'slack/*'], 'bash/git')).toBe(-1);
  });

  it('returns the highest specificity among matching patterns', () => {
    expect(bestSpecificity(['bash/*', 'bash/git*'], 'bash/git')).toBe(8);
  });

  it('ignores non-matching patterns', () => {
    expect(bestSpecificity(['bash/*', 'file/edit'], 'bash/git')).toBe(5);
  });

  it('handles single pattern', () => {
    expect(bestSpecificity(['bash/git*'], 'bash/git')).toBe(8);
  });

  it('exact match wins over wildcards in same list', () => {
    expect(bestSpecificity(['bash/*', 'bash/git*', 'bash/git'], 'bash/git')).toBe(9);
  });

  it('handles duplicate patterns', () => {
    expect(bestSpecificity(['bash/git*', 'bash/git*'], 'bash/git')).toBe(8);
  });
});

// =============================================================================
// AllowlistEngine
// =============================================================================

function makeAgent(allow: string[], ask: string[] = [], deny: string[] = []): AgentConfig {
  return {
    allow,
    remember_allow: [],
    ask,
    deny,
    tool_overrides: {},
    exec: { allow: [], ask: [], deny: [], env: {}, default_timeout_ms: 30000 },
    http: { domain_allowlist: [], max_response_bytes: 1048576, timeout_ms: 30000 },
  };
}

describe('AllowlistEngine', () => {
  // ---------------------------------------------------------------------------
  // Basic behavior
  // ---------------------------------------------------------------------------
  describe('basic behavior', () => {
    it('denies tools not in any list (fail-closed)', () => {
      const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
      expect(engine.evaluate('agent1', 'slack/send_message')).toBe('deny');
    });

    it('allows tools in allow list', () => {
      const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
    });

    it('returns ask for tools in ask list', () => {
      const engine = new AllowlistEngine({
        agent1: makeAgent(['github/*'], ['github/create_pr']),
      });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('ask');
      expect(engine.evaluate('agent1', 'github/list_prs')).toBe('allow');
    });

    it('ask implies allow — no need to also put in allow list', () => {
      const engine = new AllowlistEngine({ agent1: makeAgent([], ['github/create_pr']) });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('ask');
    });

    it('deny blocks when no more specific allow/ask exists', () => {
      const engine = new AllowlistEngine({
        agent1: makeAgent([], [], ['github/*']),
      });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
      expect(engine.evaluate('agent1', 'github/list_prs')).toBe('deny');
    });

    it('denies unknown agent', () => {
      const engine = new AllowlistEngine({});
      expect(engine.evaluate('nobody', 'anything')).toBe('deny');
    });

    it('denies unknown agent even with valid agents configured', () => {
      const engine = new AllowlistEngine({ agent1: makeAgent(['*']) });
      expect(engine.evaluate('agent2', 'anything')).toBe('deny');
    });
  });

  // ---------------------------------------------------------------------------
  // Reload
  // ---------------------------------------------------------------------------
  describe('reload', () => {
    it('updates agent configs', () => {
      const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
      engine.reload({ agent1: makeAgent(['filesystem/*']) });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
      expect(engine.evaluate('agent1', 'filesystem/read_file')).toBe('allow');
    });

    it('can add new agents', () => {
      const engine = new AllowlistEngine({});
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
      engine.reload({ agent1: makeAgent(['github/*']) });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
    });

    it('can remove agents', () => {
      const engine = new AllowlistEngine({ agent1: makeAgent(['github/*']) });
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
      engine.reload({});
      expect(engine.evaluate('agent1', 'github/create_pr')).toBe('deny');
    });
  });

  // ---------------------------------------------------------------------------
  // Specificity-aware resolution
  // ---------------------------------------------------------------------------
  describe('specificity-aware resolution', () => {
    describe('allow vs ask', () => {
      it('more specific allow beats less specific ask', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/git*', 'bash/npm*'], ['bash/*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow');
        expect(engine.evaluate('agent1', 'bash/npm')).toBe('allow');
        expect(engine.evaluate('agent1', 'bash/curl')).toBe('ask');
      });

      it('more specific ask beats less specific allow', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/*'], ['bash/rm*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow');
        expect(engine.evaluate('agent1', 'bash/rm')).toBe('ask');
        expect(engine.evaluate('agent1', 'bash/rm-old')).toBe('ask');
      });

      it('exact allow beats wildcard ask', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/git'], ['bash/git*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow');
        expect(engine.evaluate('agent1', 'bash/git-lfs')).toBe('ask');
      });

      it('exact ask beats wildcard allow', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/git*'], ['bash/git']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('ask');
        expect(engine.evaluate('agent1', 'bash/git-lfs')).toBe('allow');
      });
    });

    describe('allow vs deny', () => {
      it('more specific allow overrides less specific deny', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/git*'], [], ['bash/*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow');
        expect(engine.evaluate('agent1', 'bash/curl')).toBe('deny');
      });

      it('exact allow overrides wildcard deny', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['github/create_pr'], [], ['github/*']),
        });
        expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
        expect(engine.evaluate('agent1', 'github/list_prs')).toBe('deny');
      });

      it('more specific deny overrides less specific allow', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/*'], [], ['bash/rm*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow');
        expect(engine.evaluate('agent1', 'bash/rm')).toBe('deny');
      });
    });

    describe('ask vs deny', () => {
      it('more specific ask overrides less specific deny', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent([], ['bash/git*'], ['bash/*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('ask');
        expect(engine.evaluate('agent1', 'bash/curl')).toBe('deny');
      });

      it('more specific deny overrides less specific ask', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent([], ['bash/*'], ['bash/rm*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('ask');
        expect(engine.evaluate('agent1', 'bash/rm')).toBe('deny');
      });
    });

    describe('three-way competition', () => {
      it('each tier wins when it has the most specific pattern', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(
            ['bash/git*'], // specificity 8
            ['bash/*'], // specificity 5
            ['bash/rm*'] // specificity 7
          ),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow'); // 8 wins
        expect(engine.evaluate('agent1', 'bash/rm')).toBe('deny'); // 7 beats 5
        expect(engine.evaluate('agent1', 'bash/curl')).toBe('ask'); // only 5 matches
      });

      it('most specific wins across all three tiers simultaneously', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(
            ['bash/git'], // exact, specificity 9
            ['bash/git*'], // specificity 8
            ['bash/*'] // specificity 5
          ),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow'); // exact 9 wins
        expect(engine.evaluate('agent1', 'bash/git-lfs')).toBe('ask'); // 8 beats 5
        expect(engine.evaluate('agent1', 'bash/curl')).toBe('deny'); // only 5 matches
      });
    });

    describe('tiebreakers', () => {
      it('deny wins ties with ask', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent([], ['bash/rm*'], ['bash/rm*']),
        });
        expect(engine.evaluate('agent1', 'bash/rm')).toBe('deny');
      });

      it('deny wins ties with allow', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/rm*'], [], ['bash/rm*']),
        });
        expect(engine.evaluate('agent1', 'bash/rm')).toBe('deny');
      });

      it('ask wins ties with allow', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/git*'], ['bash/git*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('ask');
      });

      it('deny wins three-way tie', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['bash/git*'], ['bash/git*'], ['bash/git*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('deny');
      });

      it('exact match ties break deny > ask > allow', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent(['file/edit'], ['file/edit'], ['file/edit']),
        });
        expect(engine.evaluate('agent1', 'file/edit')).toBe('deny');
      });
    });

    describe('remembered allow', () => {
      it('allows a remembered exact rule to override an exact ask rule', () => {
        const agent = makeAgent([], ['github/create_pr']);
        agent.remember_allow = [{ tool: 'github/create_pr' }];
        const engine = new AllowlistEngine({ agent1: agent });

        expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
      });

      it('allows an unexpired remembered exact rule to override an exact ask rule', () => {
        const agent = makeAgent([], ['github/create_pr']);
        agent.remember_allow = [
          { tool: 'github/create_pr', expires_at: new Date(Date.now() + 60_000).toISOString() },
        ];
        const engine = new AllowlistEngine({ agent1: agent });

        expect(engine.evaluate('agent1', 'github/create_pr')).toBe('allow');
      });

      it('ignores expired remembered allow rules', () => {
        const agent = makeAgent([], ['github/create_pr']);
        agent.remember_allow = [
          { tool: 'github/create_pr', expires_at: new Date(Date.now() - 60_000).toISOString() },
        ];
        const engine = new AllowlistEngine({ agent1: agent });

        expect(engine.evaluate('agent1', 'github/create_pr')).toBe('ask');
      });
    });

    describe('multiple patterns in same tier', () => {
      it('uses the most specific matching pattern within a tier', () => {
        // allow has both broad and specific; the specific one determines the tier's score
        const engine = new AllowlistEngine({
          agent1: makeAgent(
            ['bash/*', 'bash/git'], // best allow specificity: exact 9
            ['bash/git*'] // best ask specificity: 8
          ),
        });
        // exact allow (9) beats ask wildcard (8)
        expect(engine.evaluate('agent1', 'bash/git')).toBe('allow');
        // bash/npm: allow bash/* (5) vs ask bash/git* doesn't match → only allow matches
        expect(engine.evaluate('agent1', 'bash/npm')).toBe('allow');
      });
    });

    describe('empty lists', () => {
      it('empty allow list means nothing is allowed by default', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent([], [], []),
        });
        expect(engine.evaluate('agent1', 'anything')).toBe('deny');
      });

      it('only ask list populated', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent([], ['bash/*'], []),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('ask');
        expect(engine.evaluate('agent1', 'file/read')).toBe('deny');
      });

      it('only deny list populated', () => {
        const engine = new AllowlistEngine({
          agent1: makeAgent([], [], ['bash/*']),
        });
        expect(engine.evaluate('agent1', 'bash/git')).toBe('deny');
        expect(engine.evaluate('agent1', 'file/read')).toBe('deny'); // fail-closed
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Real-world hook config scenario
  // ---------------------------------------------------------------------------
  describe('real-world: claude-code hook config', () => {
    const engine = new AllowlistEngine({
      'claude-code': makeAgent(
        // allow — safe tools and known-good bash executables
        ['bash/git*', 'bash/npm*', 'bash/npx*', 'file/read', 'file/glob', 'file/grep'],
        // ask — catch-all for bash, sensitive file ops
        ['bash/*', 'file/edit', 'file/write'],
        // deny — dangerous bash executables, complex commands
        ['bash/rm*', 'bash/sudo*', 'bash/_complex', 'bash/_empty']
      ),
    });

    it('allows known-safe bash commands', () => {
      expect(engine.evaluate('claude-code', 'bash/git')).toBe('allow');
      expect(engine.evaluate('claude-code', 'bash/npm')).toBe('allow');
      expect(engine.evaluate('claude-code', 'bash/npx')).toBe('allow');
    });

    it('allows read-only file operations', () => {
      expect(engine.evaluate('claude-code', 'file/read')).toBe('allow');
      expect(engine.evaluate('claude-code', 'file/glob')).toBe('allow');
      expect(engine.evaluate('claude-code', 'file/grep')).toBe('allow');
    });

    it('asks for unknown bash commands', () => {
      expect(engine.evaluate('claude-code', 'bash/gh')).toBe('ask');
      expect(engine.evaluate('claude-code', 'bash/curl')).toBe('ask');
      expect(engine.evaluate('claude-code', 'bash/python3')).toBe('ask');
      expect(engine.evaluate('claude-code', 'bash/docker')).toBe('ask');
    });

    it('asks for mutating file operations', () => {
      expect(engine.evaluate('claude-code', 'file/edit')).toBe('ask');
      expect(engine.evaluate('claude-code', 'file/write')).toBe('ask');
    });

    it('denies dangerous bash commands', () => {
      expect(engine.evaluate('claude-code', 'bash/rm')).toBe('deny');
      expect(engine.evaluate('claude-code', 'bash/sudo')).toBe('deny');
    });

    it('denies complex and empty bash commands', () => {
      expect(engine.evaluate('claude-code', 'bash/_complex')).toBe('deny');
      expect(engine.evaluate('claude-code', 'bash/_empty')).toBe('deny');
    });

    it('denies tools not in any list', () => {
      expect(engine.evaluate('claude-code', 'agent/spawn')).toBe('deny');
      expect(engine.evaluate('claude-code', 'http/fetch')).toBe('deny');
    });
  });
});
