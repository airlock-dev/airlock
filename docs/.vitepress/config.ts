import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Airlock',
  description: 'Permissions-aware MCP gateway for AI agents',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'Airlock',
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/quickstart' },
      { text: 'Concepts', link: '/concepts/permissions' },
      { text: 'Reference', link: '/reference/config' },
      { text: 'GitHub', link: 'https://github.com/airlock-dev/airlock' },
    ],
    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Claude Code Setup', link: '/guides/claude-code' },
          { text: 'OpenClaw Setup', link: '/guides/openclaw' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Permissions', link: '/concepts/permissions' },
          { text: 'Providers and Tools', link: '/concepts/providers-and-tools' },
          { text: 'Approvals and Audit', link: '/concepts/approvals-and-audit' },
          { text: 'Sandbox Presets and Variants', link: '/concepts/sandboxing' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'CLI Discovery Wizard', link: '/guides/cli-discovery' },
          { text: 'Hook Endpoint', link: '/guides/hook-endpoint' },
          { text: 'Sandboxed Python Variants', link: '/guides/sandboxed-python' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Config Overview', link: '/reference/config' },
          { text: 'CLI Commands', link: '/reference/cli' },
          { text: 'HITL Providers', link: '/reference/hitl-providers' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/airlock-dev/airlock' }],
    footer: {
      message: 'MIT Licensed',
      copyright: 'Copyright 2026 Airlock',
    },
  },
});
