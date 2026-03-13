import { matches } from './pattern.js';
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

    // deny > ask > allow > default-deny
    if (agent.deny.some((p) => matches(p, toolName))) return 'deny';
    if (agent.ask.some((p) => matches(p, toolName))) return 'ask';
    if (agent.allow.some((p) => matches(p, toolName))) return 'allow';

    return 'deny'; // fail-closed
  }
}
