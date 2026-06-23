import { describe, it, expect } from 'vitest';
import { isBlockedHost } from '../src/security/blocked-hosts.js';
import { isDomainAllowed } from '../src/security/domain-allowlist.js';

describe('isBlockedHost()', () => {
  const defaultBlocked = [
    'localhost', '127.0.0.1', '::1',
    '*.local', '10.*', '192.168.*', '172.16.*',
  ];

  it('blocks localhost', () => {
    expect(isBlockedHost('localhost', defaultBlocked, [])).toBe(true);
  });

  it('blocks 127.0.0.1', () => {
    expect(isBlockedHost('127.0.0.1', defaultBlocked, [])).toBe(true);
  });

  it('blocks bracketed IPv6 localhost from URL hostnames', () => {
    expect(isBlockedHost('[::1]', defaultBlocked, [])).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 loopback', () => {
    expect(isBlockedHost('[::ffff:7f00:1]', [...defaultBlocked, '::ffff:127.0.0.1'], [])).toBe(true);
  });

  it('blocks *.local domains', () => {
    expect(isBlockedHost('mybox.local', defaultBlocked, [])).toBe(true);
    expect(isBlockedHost('local', defaultBlocked, [])).toBe(false);
  });

  it('blocks 192.168.x.x', () => {
    expect(isBlockedHost('192.168.1.1', defaultBlocked, [])).toBe(true);
    expect(isBlockedHost('192.169.1.1', defaultBlocked, [])).toBe(false);
  });

  it('blocks 10.x.x.x', () => {
    expect(isBlockedHost('10.0.0.1', defaultBlocked, [])).toBe(true);
  });

  it('does not block public domains', () => {
    expect(isBlockedHost('example.com', defaultBlocked, [])).toBe(false);
    expect(isBlockedHost('api.github.com', defaultBlocked, [])).toBe(false);
  });

  it('allowed_local overrides block', () => {
    expect(isBlockedHost('localhost', defaultBlocked, ['localhost'])).toBe(false);
  });
});

describe('isDomainAllowed()', () => {
  it('empty allowlist allows everything', () => {
    expect(isDomainAllowed('anything.com', [])).toBe(true);
  });

  it('exact match', () => {
    expect(isDomainAllowed('api.github.com', ['api.github.com'])).toBe(true);
    expect(isDomainAllowed('other.github.com', ['api.github.com'])).toBe(false);
  });

  it('wildcard subdomain', () => {
    expect(isDomainAllowed('org.sentry.io', ['*.sentry.io'])).toBe(true);
    expect(isDomainAllowed('sentry.io', ['*.sentry.io'])).toBe(true);
    expect(isDomainAllowed('evil.com', ['*.sentry.io'])).toBe(false);
  });
});
