import { stringify } from 'yaml';

export function serializeDiscovery(
  data: Record<string, unknown>,
  meta: { command: string; strategy: string },
): string {
  const header = [
    '# Auto-discovered by Airlock',
    `# Command: ${meta.command}`,
    `# Strategy: ${meta.strategy}`,
    `# Generated: ${new Date().toISOString()}`,
    '#',
    '# Review and customize this file, then reference it in your airlock.yaml config.',
    '',
  ].join('\n');

  return header + stringify(data, { lineWidth: 120 });
}
