import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { AIRLOCK_CONTEXT_KEY } from '../airlock/context.js';

const ASK_POLICY_TEXT =
  'This tool is proxied by Airlock, a human-in-the-loop gateway for MCP tools. Policy: ask. Calling it will notify the user and pause until approved or denied. Include _airlock.reason explaining why you are requesting this action now. If the action is risky, briefly name the relevant risk.';

export function addAskPolicyGuidance(tool: Tool): Tool {
  return {
    ...tool,
    description: [tool.description, ASK_POLICY_TEXT].filter(Boolean).join('\n\n'),
    inputSchema: addAirlockReasonSchema(tool.inputSchema),
  };
}

function addAirlockReasonSchema(inputSchema: Tool['inputSchema']): Tool['inputSchema'] {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return inputSchema;
  }

  const schema = inputSchema as Record<string, unknown>;
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    ...schema,
    type: 'object',
    properties: {
      ...properties,
      [AIRLOCK_CONTEXT_KEY]: {
        type: 'object',
        description: 'Airlock approval context shown to the user. Stripped before tool execution.',
        properties: {
          reason: {
            type: 'string',
            description:
              'Why you are requesting this action now. Be concise and factual; include risk if relevant.',
            maxLength: 500,
          },
          note: {
            type: 'string',
            description: 'Optional additional factual context for the user.',
            maxLength: 500,
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
    required: required.includes(AIRLOCK_CONTEXT_KEY)
      ? required
      : [...required, AIRLOCK_CONTEXT_KEY],
  } as Tool['inputSchema'];
}
