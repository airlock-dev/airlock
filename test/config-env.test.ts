import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServerConfig } from '../src/config/schema.js';

describe('McpServerConfig env var substitution', () => {
  const SAVED_ENV = { ...process.env };

  beforeEach(() => {
    process.env.TEST_TOKEN = 'secret-123';
    process.env.TEST_URL_VAR = 'https://example.com';
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it('substitutes ${VAR} in stdio env values', () => {
    const config = McpServerConfig.parse({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: '${TEST_TOKEN}' },
    });
    expect(config.type).toBe('stdio');
    if (config.type === 'stdio') {
      expect(config.env!.API_KEY).toBe('secret-123');
    }
  });

  it('substitutes ${VAR} in http headers', () => {
    const config = McpServerConfig.parse({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-API-Key': '${TEST_TOKEN}' },
    });
    expect(config.type).toBe('http');
    if (config.type === 'http') {
      expect(config.headers!['X-API-Key']).toBe('secret-123');
    }
  });

  it('substitutes ${VAR} in sse headers', () => {
    const config = McpServerConfig.parse({
      type: 'sse',
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer ${TEST_TOKEN}' },
    });
    expect(config.type).toBe('sse');
    if (config.type === 'sse') {
      expect(config.headers!.Authorization).toBe('Bearer secret-123');
    }
  });

  it('throws when env var is not set', () => {
    expect(() =>
      McpServerConfig.parse({
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-API-Key': '${NONEXISTENT_VAR}' },
      })
    ).toThrow('NONEXISTENT_VAR');
  });

  it('substitutes multiple vars in one value', () => {
    process.env.TEST_SCHEME = 'Bearer';
    const config = McpServerConfig.parse({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: '${TEST_SCHEME} ${TEST_TOKEN}' },
    });
    if (config.type === 'http') {
      expect(config.headers!.Authorization).toBe('Bearer secret-123');
    }
  });

  it('passes through headers without ${} unchanged', () => {
    const config = McpServerConfig.parse({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'Content-Type': 'application/json' },
    });
    if (config.type === 'http') {
      expect(config.headers!['Content-Type']).toBe('application/json');
    }
  });
});
