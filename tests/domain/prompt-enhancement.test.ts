import { describe, expect, it } from 'vitest';
import {
  evaluatePromptEnhanceRequirement,
  promptEnhanceInputFingerprint,
  promptEnhanceSourceReference,
  toProjectContextId,
  type ProjectContextOutboundSnapshotV1
} from '../../src/domain';

const policy = {
  allowWithoutContext: true,
  requireWhenContextExists: true
} as const;

describe('prompt enhancement policy', () => {
  it('is optional without context and mandatory with context', async () => {
    await expect(evaluatePromptEnhanceRequirement({
      policy,
      originalInput: 'Create a launch image',
      contextSnapshots: [],
      enhancementSourceReferences: []
    })).resolves.toMatchObject({ required: false, satisfied: false });

    await expect(evaluatePromptEnhanceRequirement({
      policy,
      originalInput: 'Create a launch image',
      contextSnapshots: [context()],
      enhancementSourceReferences: []
    })).resolves.toMatchObject({ required: true, satisfied: false });
  });

  it('accepts only a result derived from the current input and context snapshot', async () => {
    const inputFingerprint = await promptEnhanceInputFingerprint({
      originalInput: 'Create a launch image',
      contextSnapshots: [context()]
    });
    const sourceReference = promptEnhanceSourceReference({
      inputFingerprint,
      executionId: 'prompt-once-test'
    });
    await expect(evaluatePromptEnhanceRequirement({
      policy,
      originalInput: 'Create a launch image',
      contextSnapshots: [context()],
      enhancementSourceReferences: [sourceReference]
    })).resolves.toMatchObject({ required: true, satisfied: true, inputFingerprint });

    await expect(evaluatePromptEnhanceRequirement({
      policy,
      originalInput: 'Create a changed launch image',
      contextSnapshots: [context()],
      enhancementSourceReferences: [sourceReference]
    })).resolves.toMatchObject({ required: true, satisfied: false });
  });
});

function context(): ProjectContextOutboundSnapshotV1 {
  return {
    schemaVersion: 1,
    contextId: toProjectContextId('context-brand'),
    contextRevision: 3,
    contentHash: 'a'.repeat(64),
    contentSnapshot: 'Use the registered brand palette.'
  };
}
