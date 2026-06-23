import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BackendAdapter } from './types.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { HitlBatcher } from '../hitl/batcher.js';
import type { HitlEngine } from '../hitl/engine.js';
import type { ActivityStream, AirlockActivitySeverity } from '../activity/stream.js';
import {
  AIRLOCK_ASK_USER_TOOL,
  AIRLOCK_LOG_TOOL,
  AIRLOCK_NOTIFY_USER_TOOL,
} from '../airlock/tools.js';

export interface AirlockBackendDeps {
  hitlEngine?: HitlEngine;
  hitlBatcher?: HitlBatcher;
  activityStream?: ActivityStream;
}

export class AirlockBackendAdapter implements BackendAdapter {
  readonly id = 'builtin:airlock';

  constructor(private deps: AirlockBackendDeps = {}) {}

  listTools(): Promise<Tool[]> {
    return Promise.resolve([
      {
        name: AIRLOCK_ASK_USER_TOOL,
        description:
          'Ask the user a blocking yes/no question through Airlock. This is for explicit human input, not for bypassing normal tool policy.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The concise question to show the user.',
            },
            context: {
              type: 'string',
              description: 'Optional factual context explaining why you are asking now.',
            },
          },
          required: ['question'],
          additionalProperties: false,
        },
      },
      {
        name: AIRLOCK_NOTIFY_USER_TOOL,
        description:
          'Send an informational Airlock notification to the user. This does not request or grant permission.',
        inputSchema: activityInputSchema('Notification body shown to the user.'),
      },
      {
        name: AIRLOCK_LOG_TOOL,
        description:
          'Add a quiet Airlock activity log entry. This does not notify the user and does not request or grant permission.',
        inputSchema: activityInputSchema('Log body recorded in the Airlock activity stream.'),
      },
    ]);
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    if (toolCall.tool === AIRLOCK_ASK_USER_TOOL) {
      return this.askUser(toolCall);
    }
    if (toolCall.tool === AIRLOCK_NOTIFY_USER_TOOL) {
      return this.activity(toolCall, 'notification');
    }
    if (toolCall.tool === AIRLOCK_LOG_TOOL) {
      return this.activity(toolCall, 'log');
    }
    return { success: false, error: `Unknown Airlock tool: ${toolCall.tool}` };
  }

  async stop(): Promise<void> {}

  private async askUser(toolCall: ToolCall): Promise<ToolResult> {
    const { hitlEngine, hitlBatcher } = this.deps;
    if (!hitlEngine || !hitlBatcher) {
      return { success: false, error: 'airlock/ask_user requires the Airlock HITL runtime' };
    }

    const question = toolCall.args.question;
    if (typeof question !== 'string' || !question.trim()) {
      return { success: false, error: 'airlock/ask_user requires a non-empty question' };
    }
    const context = typeof toolCall.args.context === 'string' ? toolCall.args.context.trim() : '';
    const args = {
      question: question.trim(),
      ...(context ? { context } : {}),
    };

    const ticket = hitlEngine.create({
      agentId: toolCall.agentId,
      tool: AIRLOCK_ASK_USER_TOOL,
      args,
    });
    hitlBatcher.add({
      id: ticket.id,
      code: ticket.code,
      agentId: toolCall.agentId,
      tool: AIRLOCK_ASK_USER_TOOL,
      args,
      timeoutMs: hitlEngine.timeoutMs,
    });

    const result = await ticket.result;
    return {
      success: true,
      data: {
        status: result,
        approved: result === 'approved',
      },
    };
  }

  private activity(toolCall: ToolCall, kind: 'notification' | 'log'): ToolResult {
    const title = toolCall.args.title;
    const body = toolCall.args.body;
    if (typeof title !== 'string' || !title.trim()) {
      return { success: false, error: `${toolCall.tool} requires a non-empty title` };
    }
    if (typeof body !== 'string' || !body.trim()) {
      return { success: false, error: `${toolCall.tool} requires a non-empty body` };
    }

    const severity =
      typeof toolCall.args.severity === 'string' &&
      ['info', 'success', 'warning', 'error'].includes(toolCall.args.severity)
        ? (toolCall.args.severity as AirlockActivitySeverity)
        : 'info';

    const event = this.deps.activityStream?.emit({
      kind,
      agentId: toolCall.agentId,
      title: title.trim(),
      body: body.trim(),
      severity,
    });

    return {
      success: true,
      data: {
        ok: true,
        kind,
        ...(event ? { id: event.id, createdAt: event.createdAt } : {}),
      },
    };
  }
}

function activityInputSchema(bodyDescription: string): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short human-facing title.' },
      body: { type: 'string', description: bodyDescription },
      severity: {
        type: 'string',
        enum: ['info', 'success', 'warning', 'error'],
        description: 'Optional severity used by Airlock clients when rendering the event.',
      },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  };
}
