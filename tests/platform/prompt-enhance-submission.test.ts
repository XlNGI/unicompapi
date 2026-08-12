import { describe, expect, it } from 'vitest';
import { toProjectContextId } from '../../src/domain';
import { buildEnhancePrompt } from '../../src/platform';

describe('prompt enhancement composition', () => {
  it('combines system rules, pinned context content, and original input once', () => {
    const prompt = buildEnhancePrompt('Create the campaign key visual.', [{
      schemaVersion: 1,
      contextId: toProjectContextId('context-campaign'),
      contextRevision: 4,
      contentHash: 'b'.repeat(64),
      contentSnapshot: 'Campaign color is red; product name is UniComp.'
    }]);
    expect(prompt).toContain('你是创作提示词优化器');
    expect(prompt).toContain('revision="4"');
    expect(prompt).toContain('Campaign color is red; product name is UniComp.');
    expect(prompt).toContain('<user_input>\nCreate the campaign key visual.\n</user_input>');
  });

  it('keeps enhancement available without project context', () => {
    const prompt = buildEnhancePrompt('Create a simple icon.', []);
    expect(prompt).toContain('（无项目上下文）');
    expect(prompt).toContain('Create a simple icon.');
  });
});
