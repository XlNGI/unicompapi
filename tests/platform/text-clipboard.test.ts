import { describe, expect, it, vi } from 'vitest';
const nativeWrite = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ clipboard: { writeText: nativeWrite } }));
import { textClipboard } from '../../electron/text-clipboard';

describe('native text clipboard bridge', () => {
  it('writes Unicode text through the native module', async () => {
    nativeWrite.mockClear();
    await textClipboard.writeText('报告\n内容 ✅');
    expect(nativeWrite).toHaveBeenCalledTimes(1);
    expect(nativeWrite).toHaveBeenCalledWith('报告\n内容 ✅');
  });
  it.each([null, {}, 12, 'x'.repeat(2_000_001)])('rejects unsupported or oversized input before touching the clipboard', async input => {
    nativeWrite.mockClear();
    await expect(textClipboard.writeText(input as string)).rejects.toThrow('Invalid clipboard text');
    expect(nativeWrite).not.toHaveBeenCalled();
  });
});
