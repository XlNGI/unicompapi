import { describe, expect, it } from 'vitest';
import { isConversationImageRequest, declinesConversationImageInput } from '../../src/application/conversation-image-request';
import { validateProductFeatureRequest } from '../../src/domain';

describe('conversation image requests', () => {
  it.each(['分析一下图片', '分析一下这个图片', '看看这张图', '识别截图中的文字', 'Describe this image'])('recognizes %s', text => {
    expect(isConversationImageRequest(text)).toBe(true);
  });
  it.each(['你好', '分析本季度收入', '不要分析图片', '图片只作为文档插图'])('does not initiate image reading for %s', text => {
    expect(isConversationImageRequest(text)).toBe(false);
  });
  it.each(['忽略图片，只讨论文字', '不用看图', 'Answer without the image'])('honors %s', text => {
    expect(declinesConversationImageInput(text)).toBe(true);
  });
  it('allows one image in conversation while retaining the media limits', () => {
    expect(() => validateProductFeatureRequest({ productFeature: 'text_chat', surface: 'conversation', imageCount: 1 })).not.toThrow();
    expect(() => validateProductFeatureRequest({ productFeature: 'text_chat', surface: 'conversation', imageCount: 2 })).toThrow();
    expect(() => validateProductFeatureRequest({ productFeature: 'text_chat', surface: 'conversation', videoCount: 1 })).toThrow();
  });
});
