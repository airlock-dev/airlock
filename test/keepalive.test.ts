import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import { enableTcpKeepAlive, DEFAULT_KEEPALIVE_IDLE_MS } from '../src/transport/keepalive.js';

// The behavioural payoff (the OS actually probing and closing a half-open peer) is OS-timed and
// not unit-testable; these tests pin the wiring that could regress — that we register a
// 'connection' handler and enable keep-alive on every accepted socket with the right idle.

describe('enableTcpKeepAlive', () => {
  it('enables TCP keep-alive on each accepted connection with the given idle', () => {
    const server = new EventEmitter() as unknown as Server;
    enableTcpKeepAlive(server, 12_345);

    const socket = { setKeepAlive: vi.fn() };
    server.emit('connection', socket);

    expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 12_345);
  });

  it('defaults the idle to DEFAULT_KEEPALIVE_IDLE_MS', () => {
    const server = new EventEmitter() as unknown as Server;
    enableTcpKeepAlive(server);

    const socket = { setKeepAlive: vi.fn() };
    server.emit('connection', socket);

    expect(socket.setKeepAlive).toHaveBeenCalledWith(true, DEFAULT_KEEPALIVE_IDLE_MS);
  });

  it('applies to every connection, not just the first', () => {
    const server = new EventEmitter() as unknown as Server;
    enableTcpKeepAlive(server, 1000);

    const a = { setKeepAlive: vi.fn() };
    const b = { setKeepAlive: vi.fn() };
    server.emit('connection', a);
    server.emit('connection', b);

    expect(a.setKeepAlive).toHaveBeenCalledWith(true, 1000);
    expect(b.setKeepAlive).toHaveBeenCalledWith(true, 1000);
  });
});
