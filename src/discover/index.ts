import { writeFileSync } from 'fs';
import { discoverCli } from './strategies/help-parser.js';
import { fetchFigSpec, figSpecToCommands } from './strategies/fig.js';
import {
  detectCompletionSupport,
  discoverViaCompletion,
  deduplicateAliases,
} from './strategies/completion.js';
import { discoverOpenApi } from './openapi.js';
import { serializeDiscovery } from './writer.js';
import type { CliCommandConfig } from '../config/schema.js';

interface DiscoverCliOptions {
  tool: string;
  output?: string;
  fromFig?: boolean;
  maxDepth?: number;
  include?: string[];
  exclude?: string[];
}

export interface CliDiscoveryResult {
  commands: Record<string, CliCommandConfig>;
  strategy: string;
}

interface DiscoverApiOptions {
  spec: string;
  output?: string;
  baseUrl?: string;
  include?: string[];
  exclude?: string[];
}

export async function handleDiscoverCli(options: DiscoverCliOptions): Promise<void> {
  const { commands, strategy } = await discoverCliCommands(options);

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

export async function discoverCliCommands(
  options: DiscoverCliOptions
): Promise<CliDiscoveryResult> {
  if (options.fromFig) {
    const spec = await fetchFigSpec(options.tool);
    if (spec) {
      return {
        commands: figSpecToCommands(spec),
        strategy: 'fig',
      };
    }

    console.error(`No Fig spec found for "${options.tool}". Falling back to local discovery.`);
  }

  const completionAdapter = detectCompletionSupport(options.tool);
  if (completionAdapter) {
    const result = discoverViaCompletion(options.tool, {
      maxDepth: options.maxDepth,
      include: options.include,
      exclude: options.exclude,
    });
    if (result) {
      let commands = result.commands;
      commands = deduplicateAliases(commands);

      return {
        commands,
        strategy: `completion:${result.adapterId}`,
      };
    }
  }

  return {
    commands: discoverCli(options.tool, {
      maxDepth: options.maxDepth,
      include: options.include,
      exclude: options.exclude,
    }),
    strategy: 'help-text',
  };
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
