#!/usr/bin/env npx tsx
/**
 * Thin shim — delegates to `airlock configure-agent`.
 * Kept for `npm run configure-agent` convenience during development.
 */
import { runConfigureAgent } from '../src/configure-agent/cli.js';

runConfigureAgent(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
