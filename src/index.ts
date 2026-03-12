#!/usr/bin/env node
import { parseArgs } from 'util';
import { loadConfig } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { Gateway } from './gateway.js';
import { runStdioMode } from './stdio-mode.js';
import { logger } from './util/logger.js';

const { values } = parseArgs({
  options: {
    config:  { type: 'string', short: 'c', default: './airlock.yaml' },
    profile: { type: 'string', short: 'p' },
    help:    { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
airlock — permissions-aware MCP gateway

Usage:
  airlock [options]

Options:
  -c, --config <path>    Config file path (default: ./airlock.yaml)
  -p, --profile <name>   Run in stdio mode for the given agent profile
  -h, --help             Show this help message

Examples:
  # Start full gateway server
  airlock --config /etc/airlock/gateway.yaml

  # Connect as a specific agent via stdio (for Claude Code, Cursor, etc.)
  airlock --profile helena
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const configPath = values.config!;
  let config = loadConfig(configPath);

  if (values.profile) {
    await runStdioMode(config, values.profile, configPath).catch(err => {
      logger.error({ err }, 'Fatal error in stdio mode');
      process.exit(1);
    });
    return;
  }

  // Full gateway mode
  const gateway = new Gateway(config);

  const watcher = new ConfigWatcher(configPath);
  watcher.on('reload', (newConfig) => {
    gateway.reload(newConfig).catch(err => {
      logger.error({ err }, 'Failed to apply reloaded config');
    });
  });
  watcher.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      watcher.stop();
      await gateway.stop();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'Unhandled promise rejection');
  });

  await gateway.start();
}

main().catch(err => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
