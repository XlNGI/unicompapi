import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConversationImageInput, supportsConversationImageInput } from '../../src/platform/providers/conversation-image-input';
import { NEWAPI_CHAT_ADAPTER_ID } from '../../src/platform/providers/newapi/newapi-contracts';
import { documentAttachmentRequestParsers } from '../../src/shared/document-attachment-ipc';

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGf8AAAAASUVORK5CYII=';
const input = { mimeType: 'image/png', base64, checksumSha256: createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') };

describe('controlled conversation image input', () => {
  it('accepts only hash-bound local bytes with matching MIME', () => {
    expect(parseConversationImageInput(input)).toEqual(input);
    expect(() => parseConversationImageInput({ ...input, mimeType: 'image/jpeg' })).toThrow();
    expect(() => parseConversationImageInput({ ...input, base64: 'https://example.com/private.png' })).toThrow();
    expect(() => parseConversationImageInput({ ...input, checksumSha256: '0'.repeat(64) })).toThrow();
    expect(() => parseConversationImageInput({ ...input, url: 'https://example.com' })).toThrow();
  });
  it('enforces the bounded clipboard IPC and rejects mixed path/byte requests', () => {
    expect(documentAttachmentRequestParsers.importAttachment({ image: { mimeType: 'image/png', base64 } })).toMatchObject({ image: { base64 } });
    expect(() => documentAttachmentRequestParsers.importAttachment({ sourcePath: '/outside', image: { mimeType: 'image/png', base64 } })).toThrow();
    expect(() => documentAttachmentRequestParsers.importAttachment({ image: { mimeType: 'image/svg+xml', base64 } })).toThrow();
    expect(() => documentAttachmentRequestParsers.importAttachment({ image: { mimeType: 'image/png', base64: 'a'.repeat(11184813) } })).toThrow();
  });
  it('rejects text-only protocols and uses the latest model capability evidence', () => {
    expect(supportsConversationImageInput('deepseek.chat', [])).toBe(false);
    expect(supportsConversationImageInput(NEWAPI_CHAT_ADAPTER_ID, [])).toBe(true);
    expect(supportsConversationImageInput(NEWAPI_CHAT_ADAPTER_ID, [{ revision: 1, state: 'supported' }, { revision: 2, state: 'unsupported' }])).toBe(false);
    expect(supportsConversationImageInput(NEWAPI_CHAT_ADAPTER_ID, [{ revision: 2, state: 'supported' }, { revision: 1, state: 'unsupported' }])).toBe(true);
  });
});
