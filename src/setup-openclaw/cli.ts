/**
 * `airlock setup openclaw` — one-command setup for the airlock-bridge plugin.
 *
 * Creates a symlink from ~/.openclaw/extensions/airlock-bridge to the bundled
 * plugin in this package. The symlink means updates to airlock automatically
 * update the plugin — no need to rerun this command after upgrading.
 */

import { mkdirSync, symlinkSync, existsSync, lstatSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runSetupOpenclaw(_argv: string[]): void {
  // Locate the bundled plugin source relative to this file.
  // In the source tree: src/setup-openclaw/cli.ts → ../../extensions/openclaw
  // In the dist tree:   dist/setup-openclaw/cli.js → ../../extensions/openclaw
  const pluginSrc = join(__dirname, '..', '..', 'extensions', 'openclaw');

  if (!existsSync(pluginSrc)) {
    throw new Error(`Plugin source not found at ${pluginSrc}`);
  }

  const extensionsDir = join(homedir(), '.openclaw', 'extensions');
  const dest = join(extensionsDir, 'airlock-bridge');

  mkdirSync(extensionsDir, { recursive: true });

  // Remove an existing symlink or warn about a real directory.
  if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink()) {
      unlinkSync(dest);
    } else {
      throw new Error(
        `${dest} already exists and is not a symlink.\nRemove it manually to continue.`
      );
    }
  }

  symlinkSync(pluginSrc, dest, 'dir');

  console.log(`✓ airlock-bridge → ${pluginSrc}

Restart the OpenClaw gateway to load it:

  openclaw restart

The plugin connects to http://localhost:4111 as agent "openclaw" by default.
Override with environment variables if needed:

  export AIRLOCK_URL=http://localhost:4111
  export AIRLOCK_AGENT=openclaw
  export AIRLOCK_SECRET=your-agent-token
`);
}
