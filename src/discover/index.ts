import { writeFileSync } from 'fs';
import { discoverCli } from './strategies/help-parser.js';
import { fetchFigSpec, figSpecToCommands } from './strategies/fig.js';
import { discoverOpenApi } from './openapi.js';
import { serializeDiscovery } from './writer.js';

interface DiscoverCliOptions {
  tool: string;
  output?: string;
  fromFig?: boolean;
  maxDepth?: number;
  include?: string[];
  exclude?: string[];
}

interface DiscoverApiOptions {
  spec: string;
  output?: string;
  baseUrl?: string;
  include?: string[];
  exclude?: string[];
}

export async function handleDiscoverCli(options: DiscoverCliOptions): Promise<void> {
  let commands: Record<string, unknown>;
  let strategy: string;

  if (options.fromFig) {
    strategy = 'fig';
    const spec = await fetchFigSpec(options.tool);
    if (!spec) {
      console.error(`No Fig spec found for "${options.tool}". Falling back to --help parsing.`);
      strategy = 'help-text';
      commands = discoverCli(options.tool, {
        maxDepth: options.maxDepth,
        include: options.include,
        exclude: options.exclude,
      });
    } else {
      commands = figSpecToCommands(spec);
    }
  } else {
    strategy = 'help-text';
    commands = discoverCli(options.tool, {
      maxDepth: options.maxDepth,
      include: options.include,
      exclude: options.exclude,
    });
  }

  const data = {
    clis: {
      [options.tool]: {
        commands,
      },
    },
  };

  const yaml = serializeDiscovery(data, {
    command: `airlock discover cli ${options.tool}`,
    strategy,
  });

  if (options.output) {
    writeFileSync(options.output, yaml);
    console.log(`Discovery written to ${options.output}`);
  } else {
    process.stdout.write(yaml);
  }
}

export async function handleDiscoverApi(options: DiscoverApiOptions): Promise<void> {
  const result = await discoverOpenApi(options.spec, {
    baseUrl: options.baseUrl,
    include: options.include,
    exclude: options.exclude,
  });

  const yaml = serializeDiscovery(result, {
    command: `airlock discover api ${options.spec}`,
    strategy: 'openapi',
  });

  if (options.output) {
    writeFileSync(options.output, yaml);
    console.log(`Discovery written to ${options.output}`);
  } else {
    process.stdout.write(yaml);
  }
}
