import { writeFileSync } from 'fs';
import { discoverCli } from './strategies/help-parser.js';
import { fetchFigSpec, figSpecToCommands } from './strategies/fig.js';
import { discoverViaCompletion, deduplicateAliases } from './strategies/completion.js';
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
  const filters = {
    maxDepth: options.maxDepth,
    include: options.include,
    exclude: options.exclude,
  };

  if (options.fromFig) {
    const spec = await fetchFigSpec(options.tool);
    if (spec) {
      return {
        commands: figSpecToCommands(spec, filters),
        strategy: 'fig',
      };
    }

    console.error(`No Fig spec found for "${options.tool}". Falling back to local discovery.`);
  }

  // Each adapter detects itself as it is tried; detecting up front as well would spawn the tool
  // once more per adapter for nothing.
  const result = discoverViaCompletion(options.tool, filters);
  if (result) {
    return {
      commands: deduplicateAliases(result.commands),
      strategy: `completion:${result.adapterId}`,
    };
  }

  return {
    commands: discoverCli(options.tool, filters),
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
