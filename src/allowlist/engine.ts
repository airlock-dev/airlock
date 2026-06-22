import { bestSpecificity, specificity } from './pattern.js';
import type { AgentConfig } from '../config/schema.js';

export type Decision = 'allow' | 'ask' | 'deny';
export type DetailedDecision = Decision | 'default-deny';

export interface AllowlistMatch {
  pattern: string;
  specificity: number;
  source: 'deny' | 'remember_allow' | 'ask' | 'allow';
}

export interface AllowlistEvaluation {
  decision: DetailedDecision;
  match?: AllowlistMatch;
  candidates: AllowlistMatch[];
}

export class AllowlistEngine {
  constructor(private agents: Record<string, AgentConfig>) {}

  reload(agents: Record<string, AgentConfig>): void {
    this.agents = agents;
  }

  evaluate(agentId: string, toolName: string): Decision {
    const result = this.evaluateDetailed(agentId, toolName);
    return result.decision === 'default-deny' ? 'deny' : result.decision;
  }

  evaluateDetailed(agentId: string, toolName: string): AllowlistEvaluation {
    const agent = this.agents[agentId];
    if (!agent) return { decision: 'default-deny', candidates: [] };

    // Pure specificity: most specific matching pattern wins across all tiers.
    // Ties break deny > remembered allow > ask > allow. Remembered allow is an
    // operator-approved exception that can override an exact ask rule, either
    // permanently or until it expires.
    const rememberedAllow = (agent.remember_allow ?? [])
      .filter((rule) => !rule.expires_at || Date.parse(rule.expires_at) > Date.now())
      .map((rule) => rule.tool);
    const candidates = [
      ...matchingPatterns(agent.deny, toolName, 'deny'),
      ...matchingPatterns(rememberedAllow, toolName, 'remember_allow'),
      ...matchingPatterns(agent.ask, toolName, 'ask'),
      ...matchingPatterns(agent.allow, toolName, 'allow'),
    ];

    const denySpec = bestSpecificity(agent.deny, toolName);
    const rememberedAllowSpec = bestSpecificity(rememberedAllow, toolName);
    const askSpec = bestSpecificity(agent.ask, toolName);
    const allowSpec = bestSpecificity(agent.allow, toolName);

    const best = Math.max(denySpec, rememberedAllowSpec, askSpec, allowSpec);
    if (best < 0) {
      return { decision: 'default-deny', candidates };
    }

    const winningSource =
      denySpec === best
        ? 'deny'
        : rememberedAllowSpec === best
          ? 'remember_allow'
          : askSpec === best
            ? 'ask'
            : 'allow';
    const match = candidates
      .filter((candidate) => candidate.source === winningSource && candidate.specificity === best)
      .sort((a, b) => b.pattern.length - a.pattern.length)[0];

    return {
      decision: winningSource === 'remember_allow' ? 'allow' : winningSource,
      match,
      candidates,
    };
  }
}

function matchingPatterns(
  patterns: string[],
  toolName: string,
  source: AllowlistMatch['source']
): AllowlistMatch[] {
  return patterns
    .map((pattern) => ({ pattern, specificity: specificity(pattern, toolName), source }))
    .filter(
      (match): match is AllowlistMatch =>
        match.specificity >= 0 &&
        (source === 'deny' || source === 'remember_allow' || source === 'ask' || source === 'allow')
    );
}
