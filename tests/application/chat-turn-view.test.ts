import { describe, expect, it } from 'vitest';
import { liveReplyCue, reasoningExpanded } from '../../src/pages/chat/chatTurnView';

describe('chat turn view', () => {
  it('shows real reasoning before the answer and keeps a normal wait free of invented thought', () => {
    expect(liveReplyCue({ productFeature: 'text_reasoning', reasoning: '', content: '', inProgress: true })).toBe('thinking');
    expect(liveReplyCue({ productFeature: 'text_chat', reasoning: '', content: '', inProgress: true })).toBe('organizing');
    expect(liveReplyCue({ productFeature: 'text_chat', reasoning: '先确认问题', content: '', inProgress: true })).toBe('thinking');
    expect(liveReplyCue({ productFeature: 'text_reasoning', reasoning: '先确认问题', content: '可以。', inProgress: true })).toBe('answer');
  });

  it('keeps reasoning open only while it is the live reply, then follows the user toggle', () => {
    expect(reasoningExpanded({ reasoning: '先确认问题', content: '', inProgress: true })).toBe(true);
    expect(reasoningExpanded({ reasoning: '先确认问题', content: '', inProgress: true, opened: false })).toBe(false);
    expect(reasoningExpanded({ reasoning: '先确认问题', content: '可以。', inProgress: true, opened: false })).toBe(false);
    expect(reasoningExpanded({ reasoning: '先确认问题', content: '可以。', inProgress: false, opened: true })).toBe(true);
    expect(reasoningExpanded({ reasoning: '', content: '', inProgress: true, opened: true })).toBe(false);
  });
});
