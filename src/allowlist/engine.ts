import { matches, matchesCommand } from './pattern.js';
import type { AgentConfig } from '../config/schema.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type Decision = 'allow' | 'hitl' | 'deny';

export class AllowlistEngine {
  constructor(private agents: Record<string, AgentConfig>) {}

  reload(agents: Record<string, AgentConfig>): void {
    this.agents = agents;
  }

  evaluate(agentId: string, toolName: string): Decision {
    const agent = this.agents[agentId];
    if (!agent) return 'deny';

    const inAllow = agent.allow.some(p => matches(p, toolName));
    if (!inAllow) return 'deny';

    const inHitl = agent.hitl.some(p => matches(p, toolName));
    if (inHitl) return 'hitl';

    return 'allow';
  }

  filterTools(agentId: string, tools: Tool[]): Tool[] {
    return tools.filter(t => this.evaluate(agentId, t.name) !== 'deny');
  }

  evaluateExecCommand(agentId: string, command: string): Decision {
    const agent = this.agents[agentId];
    if (!agent) return 'deny';

    // deny takes priority
    const inDeny = agent.exec.deny.some(p => matchesCommand(p, command));
    if (inDeny) return 'deny';

    const inAllow = agent.exec.allow.some(p => matchesCommand(p, command));
    const inHitl = agent.exec.hitl.some(p => matchesCommand(p, command));

    if (inHitl) return 'hitl';
    if (inAllow) return 'allow';

    return 'deny'; // fail-closed
  }

  evaluateDomain(agentId: string, hostname: string): boolean {
    const agent = this.agents[agentId];
    if (!agent) return false;

    const allowlist = agent.http.domain_allowlist;
    if (allowlist.length === 0) return true; // empty = allow all

    return allowlist.some(pattern => domainMatches(pattern, hostname));
  }
}

function domainMatches(pattern: string, hostname: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2); // "sentry.io"
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }
  return false;
}
