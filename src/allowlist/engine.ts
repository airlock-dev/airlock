import { bestSpecificity } from './pattern.js';
import type { AgentConfig } from '../config/schema.js';

export type Decision = 'allow' | 'ask' | 'deny';

export class AllowlistEngine {
  constructor(private agents: Record<string, AgentConfig>) {}

  reload(agents: Record<string, AgentConfig>): void {
    this.agents = agents;
  }

  evaluate(agentId: string, toolName: string): Decision {
    const agent = this.agents[agentId];
    if (!agent) return 'deny';

    // Pure specificity: most specific matching pattern wins across all tiers.
    // Ties break deny > ask > allow (more restrictive wins).
    const denySpec = bestSpecificity(agent.deny, toolName);
    const askSpec = bestSpecificity(agent.ask, toolName);
    const allowSpec = bestSpecificity(agent.allow, toolName);

    const best = Math.max(denySpec, askSpec, allowSpec);
    if (best < 0) return 'deny'; // no match, fail-closed

    // Tiebreaker order: deny > ask > allow
    if (denySpec === best) return 'deny';
    if (askSpec === best) return 'ask';
    return 'allow';
  }
}
