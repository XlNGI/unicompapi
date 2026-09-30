import { describe, expect, it } from 'vitest';
import {
  hasInvalidImageReference,
  remapDeletedImageReferences
} from '../../src/shared/image-reference-prompt';

describe('image reference prompt numbering', () => {
  it('renumbers following references without changing image 10', () => {
    expect(remapDeletedImageReferences('图1保留，图2删除，图3跟随，图10跟随', 2))
      .toBe('图1保留，图2（已失效）删除，图2跟随，图9跟随');
  });

  it('detects an invalidated reference marker', () => {
    expect(hasInvalidImageReference('请使用图2（已失效）中的人物')).toBe(true);
    expect(hasInvalidImageReference('请使用图2中的人物')).toBe(false);
  });
});
