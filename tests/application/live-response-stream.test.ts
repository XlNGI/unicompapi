import { describe, expect, it } from 'vitest';
import { shouldCommitResponseFrame } from '../../src/pages/chat/liveResponseStream';

describe('live response frame', () => {
  it('does not rerender the page for ordinary streaming text', () => {
    const progress: readonly unknown[] = [];
    expect(shouldCommitResponseFrame(
      { state: 'streaming', taskProgress: progress },
      { state: 'streaming', taskProgress: progress }
    )).toBe(false);
  });

  it('commits when the reply starts, finishes, or task progress changes', () => {
    expect(shouldCommitResponseFrame(undefined, { state: 'streaming' })).toBe(true);
    expect(shouldCommitResponseFrame(
      { state: 'pending' },
      { state: 'streaming' }
    )).toBe(true);
    expect(shouldCommitResponseFrame(
      { state: 'streaming', taskProgress: [] },
      { state: 'streaming', taskProgress: [{ stage: 'rendering' }] }
    )).toBe(true);
  });
});
