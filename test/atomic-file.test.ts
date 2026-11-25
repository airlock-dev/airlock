import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Make fsync of a *directory* fail (an I/O error after the rename), everything else real.
const failDirSync = vi.hoisted(() => ({ dir: '' }));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    open: async (path: string, ...rest: unknown[]) => {
      const handle = await (real.open as (...a: unknown[]) => ReturnType<typeof real.open>)(
        path,
        ...rest
      );
      if (failDirSync.dir && path === failDirSync.dir) {
        return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, {
          sync: () => Promise.reject(Object.assign(new Error('EIO: injected'), { code: 'EIO' })),
          close: () => handle.close(),
        });
      }
      return handle;
    },
  };
});

const { atomicWritePrivateFile } = await import('../src/util/atomic-file.js');

let dir = '';
afterEach(async () => {
  failDirSync.dir = '';
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('atomicWritePrivateFile', () => {
  it('reports a failing directory fsync instead of claiming durability', async () => {
    dir = await mkdtemp(join(tmpdir(), 'airlock-atomic-'));
    const path = join(dir, 'grant.json');
    await atomicWritePrivateFile(path, 'one');
    failDirSync.dir = dir;
    await expect(atomicWritePrivateFile(path, 'two')).rejects.toThrow('EIO');
    // The content is visible (rename happened) but the caller was told it may not be durable.
    expect(await readFile(path, 'utf-8')).toBe('two');
  });
});
