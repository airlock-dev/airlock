import { matches } from './pattern.js';
import type { AgentConfig } from '../config/schema.js';

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
}
