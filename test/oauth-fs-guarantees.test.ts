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
  syncFailsOnce: '' as string,
  readdirFails: '' as string,
  synced: [] as string[],
}));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    readdir: async (path: string, ...rest: unknown[]) => {
      if (fsHooks.readdirFails && path === fsHooks.readdirFails) {
        throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      }
      return (real.readdir as (...a: unknown[]) => ReturnType<typeof real.readdir>)(path, ...rest);
    },
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
        if (fsHooks.syncFailsOnce && path === fsHooks.syncFailsOnce) {
          fsHooks.syncFailsOnce = '';
          throw Object.assign(new Error('EIO: injected fsync'), { code: 'EIO' });
        }
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
const { oauthCommand } = await import('../src/pool/oauth-cli.js');

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'airlock-oauth-fs-'));
  fsHooks.linkFails = false;
  fsHooks.openFails = '';
  fsHooks.syncFailsOnce = '';
  fsHooks.readdirFails = '';
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
    const root = join(dir, 'store'); // the store directory itself does not exist yet
    const rootStore = new OAuthGrantStore('p', 'writer', root);
    await rootStore.write(grant, 'test');
    expect(fsHooks.synced).toContain(dir); // the new store directory's own entry
    await releaseAllWriterLocks();
    fsHooks.synced = [];
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

  it('a parent fsync that failed once is redone on the next write, even though the directory exists', async () => {
    const store = new OAuthGrantStore('p', 'writer', dir);
    fsHooks.syncFailsOnce = join(dir, '.grants'); // fsync for the new `.grants/p` entry fails
    await expect(store.write(grant, 'test')).rejects.toThrow('EIO');
    fsHooks.synced = [];
    await store.write(grant, 'test');
    expect(fsHooks.synced).toContain(join(dir, '.grants'));
    expect(fsHooks.synced).toContain(dir);
  });

  it('export-legacy fails (non-zero) when grants cannot be enumerated, instead of exporting nothing', async () => {
    await new OAuthGrantStore('p', 'writer', dir).write(grant, 'test');
    await releaseAllWriterLocks();
    fsHooks.readdirFails = join(dir, '.grants');
    const result = await oauthCommand(['export-legacy', '--dir', dir]);
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('EIO');
  });
});
