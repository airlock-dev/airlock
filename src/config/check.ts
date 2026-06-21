import { parseArgs } from 'util';
import { loadConfig } from './loader.js';

export function runConfigCheck(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
airlock config check - validate an Airlock YAML config

Usage:
  airlock config check <path>
  airlock config check --config <path>

Options:
  -c, --config <path>    Config file path
  -h, --help             Show this help message
`);
    return;
  }

  const configPath = values.config ?? positionals[0];
  if (!configPath) {
    throw new Error('Config path is required. Usage: airlock config check <path>');
  }

  loadConfig(configPath);
  console.log(`Config OK: ${configPath}`);
}
