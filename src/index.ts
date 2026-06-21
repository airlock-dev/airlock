#!/usr/bin/env node
import { parseArgs } from 'util';
import { loadConfig } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { Gateway } from './gateway.js';
import { runStdioMode } from './stdio-mode.js';
import { runDiscover } from './discover/cli.js';
import { runConfigureAgent } from './configure-agent/cli.js';
import { runCommandCenter, runConfigureWeb, runDashboard } from './configure-web/cli.js';
import { runConfigureCli } from './configure-cli/cli.js';
import { runConfigCheck } from './config/check.js';
import { runSetupOpenclaw } from './setup-openclaw/cli.js';
import { logger } from './util/logger.js';

// Handle subcommands before parseArgs
const subcommand = process.argv[2];
if (subcommand === 'discover') {
  runDiscover(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'configure-agent') {
  runConfigureAgent(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'configure-web') {
  runConfigureWeb(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'run') {
  runCommandCenter(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'dashboard') {
  runDashboard(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'gateway') {
  runGateway(process.argv.slice(3), { runtimeOnly: true });
} else if (subcommand === 'serve') {
  runGateway(process.argv.slice(3));
} else if (subcommand === 'configure-cli') {
  runConfigureCli(process.argv.slice(3)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'config' && process.argv[3] === 'check') {
  try {
    runConfigCheck(process.argv.slice(4));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (subcommand === 'setup' && process.argv[3] === 'openclaw') {
  try {
    runSetupOpenclaw(process.argv.slice(4));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else {
  runGateway(process.argv.slice(2));
}

function runGateway(argv: string[], options: { runtimeOnly?: boolean } = {}): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: './airlock.yaml' },
      agent: { type: 'string', short: 'a' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
airlock — permissions-aware MCP gateway

Usage:
  airlock [options]
  airlock gateway [options]
  airlock dashboard [options]
  airlock serve [options]
  airlock discover <cli|api> [options]
  airlock run [options]
  airlock configure-cli <tool> [options]
  airlock configure-agent [options]
  airlock configure-web [options]
  airlock config check <path>
  airlock setup openclaw

Options:
  -c, --config <path>    Config file path (default: ./airlock.yaml)
  -a, --agent <name>     Run in stdio mode for the given agent
      --pretty           Human-friendly colored log output
  -h, --help             Show this help message

Subcommands:
  run                    Browser command center for provider health and permissions
  gateway                MCP/runtime gateway only; disables in-process dashboard provider
  dashboard              Standalone admin dashboard for a remote gateway
  serve                  Combined gateway mode (same behavior as airlock [options])
  discover cli <tool>    Auto-discover CLI commands from --help or Fig specs
  discover api <spec>    Auto-discover API endpoints from an OpenAPI spec
  configure-cli <tool>   Interactive TUI to select and configure CLI commands
  configure-agent        Interactive TUI to build allow/ask/deny lists
  configure-web          Browser UI to edit profiles, agents, and permissions
  config check <path>    Validate config and fail on errors before deployment
  setup openclaw         Install the airlock-bridge plugin into OpenClaw

Examples:
  # Start full gateway server
  airlock --config /etc/airlock/gateway.yaml

  # Start runtime-only gateway for split deployments
  airlock gateway --config /etc/airlock/gateway.yaml

  # Start standalone admin dashboard for split deployments
  airlock dashboard --config /etc/airlock/gateway.yaml --gateway-url http://gateway:4111

  # Connect as a specific agent via stdio (for Claude Code, Cursor, etc.)
  airlock --agent helena

  # Install the OpenClaw bridge plugin (one command)
  airlock setup openclaw

  # Open the local Airlock command center
  airlock run --config ./airlock.yaml

  # Discover CLI tool commands
  airlock discover cli git --output git-commands.yaml

  # Discover API endpoints
  airlock discover api ./petstore.json --output petstore-api.yaml

  # Interactively configure agent permissions
  airlock configure-agent --config ./airlock.yaml --agent my-agent

  # Configure profiles and agents in a local web UI
  airlock configure-web --config ./airlock.yaml

  # Validate config before deployment
  airlock config check ./airlock.yaml
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
    const gateway = new Gateway(config, configPath, { runtimeOnly: options.runtimeOnly });

    const watcher = new ConfigWatcher(configPath);
    watcher.on('reload', (newConfig) => {
      gateway.reload(newConfig).catch((err) => {
        logger.error({ err }, 'Failed to apply reloaded config');
      });
    });
    watcher.start();

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutdown signal received');
      // Immediately prevent MCP clients from reconnecting — SIGINT
      // propagates to children, killing them before pool.stop() runs.
      gateway.disableReconnect();
      // The MCP SDK's StdioClientTransport.close() escalates:
      //   stdin.end → 2s wait → SIGTERM → 2s wait → SIGKILL
      // Give it enough time (5s) before forcing exit, otherwise
      // process.exit() orphans children mid-cleanup.
      const forceExit = setTimeout(() => {
        logger.warn('Graceful shutdown timed out, forcing exit');
        gateway.forceKill();
        process.exit(1);
      }, 5000);
      forceExit.unref();
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
