#!/usr/bin/env node
import { parseArgs } from 'util';
import { loadConfig } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { Gateway } from './gateway.js';
import { runStdioMode } from './stdio-mode.js';
import { runDiscover } from './discover/cli.js';
import { logger } from './util/logger.js';

// Handle `airlock discover ...` subcommand before parseArgs
const subcommand = process.argv[2];
if (subcommand === 'discover') {
  runDiscover(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  runGateway();
}

function runGateway(): void {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      agent: { type: 'string', short: 'a' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
airlock — permissions-aware MCP gateway

Usage:
  airlock [options]
  airlock discover <cli|api> [options]

Options:
  -c, --config <path>    Config file path (default: ./airlock.yaml)
  -a, --agent <name>     Run in stdio mode for the given agent
  -h, --help             Show this help message

Subcommands:
  discover cli <tool>    Auto-discover CLI commands from --help or Fig specs
  discover api <spec>    Auto-discover API endpoints from an OpenAPI spec

Examples:
  # Start full gateway server
  airlock --config /etc/airlock/gateway.yaml

  # Connect as a specific agent via stdio (for Claude Code, Cursor, etc.)
  airlock --agent helena

  # Discover CLI tool commands
  airlock discover cli git --output git-commands.yaml

  # Discover API endpoints
  airlock discover api ./petstore.json --output petstore-api.yaml
`);
    process.exit(0);
  }

  async function main(): Promise<void> {
    const configPath = values.config ?? './airlock.yaml';
    const config = loadConfig(configPath);

    if (values.agent) {
      await runStdioMode(config, values.agent, configPath).catch((err) => {
        logger.error({ err }, 'Fatal error in stdio mode');
        process.exit(1);
      });
      return;
    }

    // Full gateway mode
    const gateway = new Gateway(config);

    const watcher = new ConfigWatcher(configPath);
    watcher.on('reload', (newConfig) => {
      gateway.reload(newConfig).catch((err) => {
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

  main().catch((err) => {
    logger.error({ err }, 'Fatal error');
    process.exit(1);
  });
}
