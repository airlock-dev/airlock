import { parseArgs } from 'util';
import { handleDiscoverCli, handleDiscoverApi } from './index.js';

const HELP = `
airlock discover — auto-generate config from CLI tools or API specs

Usage:
  airlock discover cli <tool> [options]
  airlock discover api <spec> [options]

CLI options:
  --output, -o <path>    Write YAML to file (default: stdout)
  --fig                  Try Fig autocomplete specs first, then local discovery
  --max-depth <n>        Max subcommand recursion depth (default: 2)
  --include <cmd,...>    Only include these commands
  --exclude <cmd,...>    Exclude these commands

API options:
  --output, -o <path>    Write YAML to file (default: stdout)
  --base-url <url>       Override the spec's base URL
  --include <filter,...> Only include matching operations (e.g. "GET /pets")
  --exclude <filter,...> Exclude matching operations (e.g. "DELETE *")

Examples:
  airlock discover cli git
  airlock discover cli docker --fig --output docker-commands.yaml
  airlock discover api ./petstore.json --output petstore-api.yaml
  airlock discover api https://api.example.com/openapi.json --base-url https://api.example.com
`;

export async function runDiscover(argv: string[]): Promise<void> {
  const mode = argv[0];

  if (!mode || mode === '--help' || mode === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (mode === 'cli') {
    return runDiscoverCli(argv.slice(1));
  }

  if (mode === 'api') {
    return runDiscoverApi(argv.slice(1));
  }

  console.error(`Unknown discover mode: "${mode}". Use "cli" or "api".`);
  console.log(HELP);
  process.exit(1);
}

async function runDiscoverCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      fig: { type: 'boolean', default: false },
      'max-depth': { type: 'string' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  const tool = positionals[0];
  await handleDiscoverCli({
    tool,
    output: values.output,
    fromFig: values.fig,
    maxDepth: values['max-depth'] ? parseInt(values['max-depth'], 10) : undefined,
    include: values.include?.split(','),
    exclude: values.exclude?.split(','),
  });
}

async function runDiscoverApi(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      'base-url': { type: 'string' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  const spec = positionals[0];
  await handleDiscoverApi({
    spec,
    output: values.output,
    baseUrl: values['base-url'],
    include: values.include?.split(','),
    exclude: values.exclude?.split(','),
  });
}
