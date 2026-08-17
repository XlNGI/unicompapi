import { describe, expect, it } from 'vitest';
import { toProjectContextId } from '../../src/domain';
import {
  buildEnhancePrompt,
  claimPromptEnhancePreparation
} from '../../src/platform';

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

  it('includes structured prompt content in the enhancement request', () => {
    const prompt = buildEnhancePrompt(
      'Create a launch video.',
      [],
      '主体动作：转身看向镜头\n镜头运动：缓慢推进'
    );
    expect(prompt).toContain('<structured_input>');
    expect(prompt).toContain('主体动作：转身看向镜头');
  });

  it('supports context-only enhancement without a basic prompt', () => {
    const prompt = buildEnhancePrompt('', [{
      schemaVersion: 1,
      contextId: toProjectContextId('context-only'),
      contextRevision: 1,
      contentHash: 'c'.repeat(64),
      contentSnapshot: 'Registered brand palette.'
    }]);
    expect(prompt).toContain('Registered brand palette.');
    expect(prompt).not.toContain('empty');
  });
});

describe('prompt enhancement preparation consumption', () => {
  it('allows only one concurrent claimant to consume a prepared token', async () => {
    const preparation = { state: 'ready' as 'ready' | 'submitting' | 'consumed' };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => claimPromptEnhancePreparation(preparation)),
      Promise.resolve().then(() => claimPromptEnhancePreparation(preparation))
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(preparation.state).toBe('submitting');
  });
});
