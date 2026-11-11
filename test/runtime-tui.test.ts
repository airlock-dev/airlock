import { describe, it, expect, afterEach, vi } from 'vitest';
import { TuiHitlProvider } from '../src/hitl/providers/tui.js';

type KeyHandler = { active: boolean; items: unknown[]; handleKey(key: string): void };

/** The constructor opens /dev/tty; key handling needs none of that. */
function makeProvider(): KeyHandler {
  const provider = Object.create(TuiHitlProvider.prototype) as KeyHandler;
  provider.active = true;
  provider.items = [];
  return provider;
}

describe('TUI approval provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns Ctrl-C into SIGINT even when nothing is pending', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    makeProvider().handleKey('\x03');

    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    expect(exit).not.toHaveBeenCalled();
  });
});
