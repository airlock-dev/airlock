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
    // Ties break deny > remembered allow > ask > allow. Remembered allow is an
    // operator-approved exception that can override an exact ask rule, either
    // permanently or until it expires.
    const denySpec = bestSpecificity(agent.deny, toolName);
    const rememberedAllowSpec = bestSpecificity(
      (agent.remember_allow ?? [])
        .filter((rule) => !rule.expires_at || Date.parse(rule.expires_at) > Date.now())
        .map((rule) => rule.tool),
      toolName
    );
    const askSpec = bestSpecificity(agent.ask, toolName);
    const allowSpec = bestSpecificity(agent.allow, toolName);

    const best = Math.max(denySpec, rememberedAllowSpec, askSpec, allowSpec);
    if (best < 0) return 'deny'; // no match, fail-closed

    // Tiebreaker order: deny > remembered allow > ask > allow
    if (denySpec === best) return 'deny';
    if (rememberedAllowSpec === best) return 'allow';
    if (askSpec === best) return 'ask';
    return 'allow';
  }
}
