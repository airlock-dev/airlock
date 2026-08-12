import { chmod, mkdir, open, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';

/**
 * Replace a private state file without ever truncating the last known-good copy.
 *
 * OAuth issuers commonly rotate refresh tokens. If an in-place write fails (ENOSPC, container
 * shutdown, I/O error), truncating the old file turns a recoverable persistence problem into a
 * mandatory browser re-authorization. Write + fsync a sibling first, then atomically rename it.
 */
export async function atomicWritePrivateFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => {});
    // rename() is atomic, but syncing the directory makes the replacement survive a sudden host
    // crash as well. Some platforms cannot open directories; durability there remains best-effort.
    const dirHandle = await open(dir, 'r').catch(() => undefined);
    if (dirHandle) {
      await dirHandle.sync().catch(() => {});
      await dirHandle.close().catch(() => {});
    }
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw err;
  }
}
