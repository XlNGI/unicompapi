import { describe, expect, it } from 'vitest';
import {
  composeImagePromptEnhancementInput,
  composeVideoPromptEnhancementInput
} from '../../src/shared/prompt-enhancement-input';

describe('structured prompt enhancement input', () => {
  it('requires enhancement for image purpose, region or edit requirements', () => {
    const plain = composeImagePromptEnhancementInput({
      contextReferences: []
    });
    expect(plain).toEqual({ required: false, text: '' });

    const withPurpose = composeImagePromptEnhancementInput({
      contextReferences: [],
      input: { purpose: '仅参考构图，不复制人物' }
    });
    expect(withPurpose.required).toBe(true);
    expect(withPurpose.text).toContain('图片用途：仅参考构图，不复制人物');

    const withRegion = composeImagePromptEnhancementInput({
      contextReferences: [],
      input: {
        region: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 }
      }
    });
    expect(withRegion.required).toBe(true);
    expect(withRegion.text).toContain('左 10%');

    const withEdit = composeImagePromptEnhancementInput({
      contextReferences: [],
      editing: {
        mustKeep: ['人物姿态'],
        mustChange: ['移除杂物'],
        prohibited: ['新增人物']
      }
    });
    expect(withEdit.required).toBe(true);
    expect(withEdit.text).toContain('必须保留');
    expect(withEdit.text).toContain('必须修改');
    expect(withEdit.text).toContain('禁止出现');
  });

  it('treats selected project context as required enhancement content', () => {
    const result = composeImagePromptEnhancementInput({
      contextReferences: [
        { kind: 'project_context', includeInPrompt: true }
      ]
    });
    expect(result.required).toBe(true);
  });

  it('requires enhancement for video shots and image-to-video structured fields', () => {
    const text = composeVideoPromptEnhancementInput({
      contextReferences: [],
      textToVideo: {
        sourceKind: 'short_idea',
        shots: [{
          order: 1,
          description: '列车驶过悬崖',
          cameraMovement: '缓慢推进'
        }]
      }
    });
    expect(text.required).toBe(true);
    expect(text.text).toContain('镜头 1：列车驶过悬崖');
    expect(text.text).toContain('镜头运动：缓慢推进');

    const image = composeVideoPromptEnhancementInput({
      contextReferences: [],
      imageToVideo: {
        mustKeep: ['主体身份'],
        allowedChanges: ['背景'],
        prohibited: ['新增人物'],
        subjectAction: '转身看向镜头',
        cameraMovement: '',
        pace: '',
        depthOfField: ''
      }
    });
    expect(image.required).toBe(true);
    expect(image.text).toContain('主体动作：转身看向镜头');
    expect(image.text).toContain('禁止变化');
  });

  it('does not treat the image source as a second prompt', () => {
    const result = composeVideoPromptEnhancementInput({
      contextReferences: [],
      imageToVideo: {
        mustKeep: [],
        allowedChanges: [],
        prohibited: [],
        subjectAction: '',
        cameraMovement: '',
        pace: '',
        depthOfField: ''
      }
    });
    expect(result.required).toBe(false);
    expect(result.text).toBe('');
  });
});
