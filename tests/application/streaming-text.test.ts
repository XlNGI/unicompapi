import { describe, expect, it } from 'vitest';
import { StreamingTextBuffer } from '../../src/pages/chat/streamingText';

describe('streaming text presentation', () => {
  it('spreads a received burst across frames and catches up within 100 ms', () => {
    const buffer = new StreamingTextBuffer();
    const content = '这是一段已经完整收到但需要平滑展示的文字';
    expect(buffer.update(content, true, 0)).toBe('');
    const first = buffer.advance(32);
    const second = buffer.advance(64);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.length).toBeLessThan(content.length);
    expect(content.startsWith(second)).toBe(true);
    expect(buffer.advance(100)).toBe(content);
    expect(buffer.pending).toBe(false);
  });

  it('never loses deltas or splits emoji while more text arrives', () => {
    const buffer = new StreamingTextBuffer();
    let text = '';
    let previous = '';
    for (let frame = 0; frame < 30; frame++) {
      text += '熊猫🐼';
      buffer.update(text, true, frame * 32);
      const next = buffer.advance(frame * 32 + 16);
      expect(next.startsWith(previous)).toBe(true);
      expect(text.startsWith(next)).toBe(true);
      expect(/[\uD800-\uDBFF]$/u.test(next)).toBe(false);
      previous = next;
    }
    expect(buffer.advance(1100)).toBe(text);
  });

  it('flushes immediately on completion/cancellation and replaces a different response', () => {
    const buffer = new StreamingTextBuffer();
    buffer.update('当前已经收到的完整回复', true, 0);
    buffer.advance(20);
    expect(buffer.update('当前已经收到的完整回复', false, 21)).toBe('当前已经收到的完整回复');
    expect(buffer.pending).toBe(false);
    expect(buffer.update('另一条回复', true, 22)).toBe('另一条回复');
  });
});
