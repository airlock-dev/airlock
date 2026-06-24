import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';

const docsDir = join(process.cwd(), 'docs');
const outputDir = join(docsDir, 'public');
const excludedDirs = new Set(['.vitepress', 'public']);

function collectMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) files.push(...collectMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }

  return files;
}

function routeForMarkdown(path: string): string {
  const normalized = relative(docsDir, path).split(sep).join('/');
  const withoutExtension = normalized.replace(/\.md$/, '');
  if (withoutExtension === 'index') return '/';
  return `/${withoutExtension.replace(/\/index$/, '')}`;
}

function routeRank(route: string): number {
  if (route === '/') return 0;
  if (route === '/quickstart') return 1;
  if (route.startsWith('/concepts/')) return 2;
  if (route.startsWith('/guides/')) return 3;
  if (route.startsWith('/reference/')) return 4;
  return 5;
}

const pages = collectMarkdownFiles(docsDir)
  .map(routeForMarkdown)
  .sort((a, b) => routeRank(a) - routeRank(b) || a.localeCompare(b));

const lines = [
  'Airlock documentation',
  'https://docs.airlock.bot',
  '',
  'Airlock is a permissions-aware MCP gateway for AI agents. It fronts MCP servers, CLI tools, built-in exec/http tools, and OpenAPI-backed APIs with per-agent allow/ask/deny policy, approvals, audit logging, and sandboxed tool variants.',
  '',
  'Pages:',
  ...pages.map((page) => `- ${page}`),
];

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'llms.txt'), `${lines.join('\n')}\n`, 'utf8');
