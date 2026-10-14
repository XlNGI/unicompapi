import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageClipboardText, writeMessageClipboard } from '../../src/pages/chat/messageClipboard';
import type { MessageDto } from '../../src/shared/chat-context-ipc';

function message(content: string, extra: Partial<MessageDto> = {}): MessageDto {
  return { messageId: 'answer', conversationId: 'conversation', revision: 1, role: 'assistant', state: 'completed',
    content, attachments: [], createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z', ...extra };
}

afterEach(() => vi.unstubAllGlobals());

describe('message copy content', () => {
  it('copies ordinary markdown without changing its text', () => {
    expect(messageClipboardText(message('# 标题\n\n正文\n- 条目'), false)).toBe('# 标题\n\n正文\n- 条目');
  });
  it('projects document JSON to the same readable body without copying private fields', () => {
    const content = JSON.stringify({ title: '报告', reasoning: 'PRIVATE', path: 'PRIVATE',
      sections: [{ heading: '结论', blocks: [{ type: 'paragraph', text: '收入增长。' }] }] });
    expect(messageClipboardText(message(content), true)).toBe('# 报告\n\n## 结论\n\n收入增长。');
  });
  it('prefers verified document content over a stale raw draft, including when raw content is empty', () => {
    const result = { workId: 'work', kind: 'ppt' as const, fileName: '报告.pptx', sizeBytes: 100, validatedContent: '# 正式内容' };
    expect(messageClipboardText(message('OLD', { documentResult: result }), true)).toBe('# 正式内容');
    expect(messageClipboardText(message('', { documentResult: result }), true)).toBe('# 正式内容');
  });
  it('returns no text rather than leaking an outline with no body', () => {
    expect(messageClipboardText(message('{"reasoning":"PRIVATE"}'), true)).toBe('');
  });
});

describe('clipboard writer selection', () => {
  it('prefers the desktop writer even when the browser clipboard rejects for focus or permission', async () => {
    const writeText = vi.fn(async () => undefined), browserWrite = vi.fn(async () => { throw new Error('NotAllowedError'); });
    vi.stubGlobal('window', { unicomp: { clipboard: { writeText } } });
    vi.stubGlobal('navigator', { clipboard: { writeText: browserWrite } });
    await writeMessageClipboard('复制正文');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('复制正文');
    expect(browserWrite).not.toHaveBeenCalled();
  });
  it('supports the browser API without a desktop bridge', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('window', {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    await writeMessageClipboard('浏览器正文');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('浏览器正文');
  });
  it('propagates desktop write failure instead of claiming success', async () => {
    vi.stubGlobal('window', { unicomp: { clipboard: { writeText: async () => { throw new Error('write failed'); } } } });
    await expect(writeMessageClipboard('正文')).rejects.toThrow('write failed');
  });
  it('fails explicitly when no clipboard API exists', async () => {
    vi.stubGlobal('window', {}); vi.stubGlobal('navigator', {});
    await expect(writeMessageClipboard('正文')).rejects.toThrow('Clipboard unavailable');
  });
});
