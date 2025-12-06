import type { Artifact, Message } from '@a2a-js/sdk';
import { z } from 'zod';

import type { WorkflowPlugin, WorkflowContext, WorkflowState } from '../../src/workflows/types.js';

const plugin: WorkflowPlugin = {
  id: 'example-workflow',
  name: 'Example Workflow',
  description:
    'A comprehensive workflow example demonstrating A2A patterns, pause/resume, multiple artifacts, and lifecycle management',
  version: '1.0.0',

  inputSchema: z.object({
    message: z.string().optional(),
    count: z.number().int().positive().optional().default(1),
  }),

  async *execute(context: WorkflowContext): AsyncGenerator<WorkflowState, unknown, unknown> {
    const { message = 'Hello from example workflow!', count = 1 } = context.parameters ?? {};

    // Status: Starting workflow
    const startMessage: Message = {
      kind: 'message',
      messageId: 'status-start',
      contextId: context.contextId,
      role: 'agent',
      parts: [{ kind: 'text', text: 'Starting example workflow processing...' }],
    };

    yield {
      type: 'status',
      status: {
        state: 'working',
        message: startMessage,
      },
    };

    // Artifact 1: Initial configuration summary
    const configArtifact: Artifact = {
      artifactId: 'config-summary',
      name: 'config-summary.json',
      description: 'Workflow configuration and parameters',
      parts: [
        {
          kind: 'text',
          text: JSON.stringify({
            workflowId: context.taskId,
            message,
            count,
            startedAt: new Date().toISOString(),
          }),
        },
      ],
    };
    yield { type: 'artifact', artifact: configArtifact };

    // Simulate some work with progress updates
    for (let i = 0; i < (count as number); i++) {
      yield {
        type: 'progress',
        current: i + 1,
        total: count as number,
      };

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Artifact 2: Processing result
    const processingArtifact: Artifact = {
      artifactId: 'processing-result',
      name: 'processing-result.json',
      description: 'Intermediate processing results',
      parts: [
        {
          kind: 'text',
          text: JSON.stringify({
            status: 'processed',
            iterations: count,
            processedAt: new Date().toISOString(),
          }),
        },
      ],
    };
    yield { type: 'artifact', artifact: processingArtifact };

    // Pause for user confirmation
    const pauseMessage: Message = {
      kind: 'message',
      messageId: 'pause-confirmation',
      contextId: context.contextId,
      role: 'agent',
      parts: [{ kind: 'text', text: 'Please confirm to proceed with final step' }],
    };

    const userInput = (yield {
      type: 'pause',
      status: {
        state: 'input-required',
        message: pauseMessage,
      },
      inputSchema: z.object({
        confirmed: z.boolean(),
        notes: z.string().optional(),
        timestamp: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'Must be ISO 8601 timestamp format')
          .optional(),
      }),
    }) as { confirmed?: boolean; notes?: string; timestamp?: string } | undefined;

    // Continue after confirmation
    const continueMessage: Message = {
      kind: 'message',
      messageId: 'status-continue',
      contextId: context.contextId,
      role: 'agent',
      parts: [{ kind: 'text', text: 'Finalizing workflow...' }],
    };

    yield {
      type: 'status',
      status: {
        state: 'working',
        message: continueMessage,
      },
    };

    // Artifact 3: Final result with user confirmation
    const finalArtifact: Artifact = {
      artifactId: 'final-result',
      name: 'final-result.json',
      description: 'Final workflow result including user confirmation',
      parts: [
        {
          kind: 'text',
          text: JSON.stringify({
            message,
            count,
            confirmed: userInput?.confirmed ?? false,
            userNotes: userInput?.notes,
            userTimestamp: userInput?.timestamp,
            completedAt: new Date().toISOString(),
          }),
        },
      ],
    };
    yield { type: 'artifact', artifact: finalArtifact };

    // Final status
    const completeMessage: Message = {
      kind: 'message',
      messageId: 'status-complete',
      contextId: context.contextId,
      role: 'agent',
      parts: [{ kind: 'text', text: 'Workflow completed successfully' }],
    };

    yield {
      type: 'status',
      status: {
        state: 'completed',
        message: completeMessage,
      },
    };

    // Return structured result
    return {
      success: true,
      workflowId: context.taskId,
      message,
      count,
      userConfirmed: userInput?.confirmed ?? false,
      artifactsGenerated: 3,
      completedAt: new Date().toISOString(),
    };
  },
};

export default plugin;
