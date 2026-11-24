import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { McpServerConfig } from './schema.js';

const MAX_BEARER_FILE_BYTES = 16 * 1024;

export function hasConflictingBearerAuth(provider: McpServerConfig): boolean {
  return (
    provider.type === 'http' &&
    Boolean(
      provider.bearer_token_file &&
      (provider.oauth ||
        provider.client_credentials ||
        Object.keys(provider.headers ?? {}).some((name) => name.toLowerCase() === 'authorization'))
    )
  );
}

export function resolveProviderBearerFile(provider: McpServerConfig): McpServerConfig {
  if (provider.type !== 'http' || !provider.bearer_token_file) return provider;
  if (hasConflictingBearerAuth(provider)) {
    throw new Error('bearer_token_file cannot be combined with another Authorization source.');
  }

  const { bearer_token_file, ...connection } = provider;
  try {
    const fd = openSync(bearer_token_file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Expected a regular file');
      const contents = Buffer.alloc(MAX_BEARER_FILE_BYTES + 1);
      let length = 0;
      while (length < contents.length) {
        const count = readSync(fd, contents, length, contents.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_BEARER_FILE_BYTES) throw new Error('Credential file too large');
      const token = contents.toString('utf8', 0, length).trim();
      if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error('Expected a bearer token');
      return {
        ...connection,
        headers: { ...connection.headers, Authorization: `Bearer ${token}` },
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(
      'bearer_token_file must be a readable file containing one bearer token up to 16 KiB.'
    );
  }
}
