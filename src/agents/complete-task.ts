/**
 * Builds the `complete_task` FunctionDeclaration for agent termination.
 *
 * The agent calls this tool to submit its final structured output.
 */

import type { FunctionDeclaration, JsonSchema } from '../lib/types.js';

export const COMPLETE_TASK_TOOL_NAME = 'complete_task';

export interface OutputConfig {
  outputName: string;
  description: string;
  schema: JsonSchema;
}

export function buildCompleteTaskDeclaration(outputConfig?: OutputConfig): FunctionDeclaration {
  if (outputConfig) {
    return {
      name: COMPLETE_TASK_TOOL_NAME,
      description:
        'Call this tool to submit your final answer and complete the task. ' +
        'You MUST call this tool when your investigation is complete.',
      parameters: {
        type: 'object',
        properties: {
          [outputConfig.outputName]: {
            ...outputConfig.schema,
            description: outputConfig.description,
          },
        },
        required: [outputConfig.outputName],
      },
    };
  }

  return {
    name: COMPLETE_TASK_TOOL_NAME,
    description:
      'Call this tool to submit your final findings and complete the task. ' +
      'You MUST call this tool when your investigation is complete.',
    parameters: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'Your final results or findings as a detailed text response.',
        },
      },
      required: ['result'],
    },
  };
}
