import { describe, expect, it } from 'vitest';
import { mergeCliSelection } from '../src/configure-cli/cli.js';

describe('configure-cli mergeCliSelection()', () => {
  it('merges commands into the existing tool entry and keeps its settings', () => {
    const doc = {
      agents: {},
      clis: {
        git: {
          cwd: '/repo',
          max_output_bytes: 1000,
          commands: {
            log: { exec: 'git log' },
            custom: { exec: 'git custom' },
            push: { exec: 'git push' },
          },
        },
        gh: { commands: { pr: { exec: 'gh pr' } } },
      },
    };

    const next = mergeCliSelection(doc, 'git', { status: { exec: 'git status' } }, ['push']);

    expect(next).toEqual({
      agents: {},
      clis: {
        git: {
          cwd: '/repo',
          max_output_bytes: 1000,
          commands: {
            log: { exec: 'git log' },
            custom: { exec: 'git custom' },
            status: { exec: 'git status' },
          },
        },
        gh: { commands: { pr: { exec: 'gh pr' } } },
      },
    });
  });

  it('creates the clis block when the config has none', () => {
    expect(mergeCliSelection({}, 'gog', { ls: { exec: 'gog ls' } }, [])).toEqual({
      clis: { gog: { commands: { ls: { exec: 'gog ls' } } } },
    });
  });
});
