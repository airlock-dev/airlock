/**
 * Filesystem guarantees OAuth storage relies on, with fs failures injected (works as root, unlike
 * chmod): hard links are required (fail closed without them), new directories are made durable
 * by fsyncing their parents, and directory-open errors propagate.
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  linkFails: false as false | string,
  openFails: '' as string,
  synced: [] as string[],
}));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    link: async (from: string, to: string) => {
      if (fsHooks.linkFails && to.includes('/.grants/')) {
        throw Object.assign(new Error(`${fsHooks.linkFails}: injected`), {
          code: fsHooks.linkFails,
        });
      }
      return real.link(from, to);
    },
    open: async (path: string, ...rest: unknown[]) => {
      if (fsHooks.openFails && path === fsHooks.openFails) {
        throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      }
      const handle = await (real.open as (...a: unknown[]) => ReturnType<typeof real.open>)(
        path,
        ...rest
      );
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        fsHooks.synced.push(path);
        return sync();
      };
      return handle;
    },
  };
});

const { OAuthGrantStore } = await import('../src/pool/oauth-store.js');
const { FileOAuthProvider } = await import('../src/pool/oauth-provider.js');
const { releaseAllWriterLocks } = await import('../src/pool/oauth-lock.js');

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'airlock-oauth-fs-'));
  fsHooks.linkFails = false;
  fsHooks.openFails = '';
  fsHooks.synced = [];
});
afterEach(async () => {
  await releaseAllWriterLocks();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const grant = {
  clientInfo: { client_id: 'c', redirect_uris: ['http://127.0.0.1:1/cb'] },
  tokens: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' },
  obtainedAt: Date.now(),
};

describe('OAuth storage — filesystem guarantees', () => {
  it('without hard links, nothing is published and no refresh may start (fail closed)', async () => {
    await writeFile(join(dir, 'p.json'), JSON.stringify(grant));
    fsHooks.linkFails = 'EPERM';
    const provider = new FileOAuthProvider('p', 1, undefined, undefined, undefined, {
      storeDir: dir,
    });
    const begun = await provider.beginExchange({
      state: 'in_flight',
      startedAt: Date.now(),
      issuer: 'https://as.example',
      tokenEndpoint: 'https://as.example/token',
      discovery: { authorizationServerUrl: 'https://as.example' },
    });
    expect(begun).toMatchObject({ ok: false, kind: 'unwritable' });
    expect((begun as { message: string }).message).toContain('hard links');
    expect(JSON.parse(await readFile(join(dir, 'p.json'), 'utf-8'))).toEqual(grant);
  });

  it('fsyncs the parent of every directory it creates before publishing into it', async () => {
    const store = new OAuthGrantStore('p', 'writer', dir);
    await store.write(grant, 'test');
    expect(fsHooks.synced).toContain(dir); // `.grants` entry
    expect(fsHooks.synced).toContain(join(dir, '.grants')); // `.grants/p` entry
    expect(fsHooks.synced).toContain(join(dir, '.grants', 'p')); // the revision itself
  });

  it('propagates a directory that cannot be opened for fsync', async () => {
    await mkdir(join(dir, '.grants', 'p'), { recursive: true });
    fsHooks.openFails = join(dir, '.grants', 'p');
    const store = new OAuthGrantStore('p', 'writer', dir);
    await expect(store.write(grant, 'test')).rejects.toThrow('EACCES');
  });
});
