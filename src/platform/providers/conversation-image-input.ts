import { createHash } from 'node:crypto';
import { NEWAPI_CHAT_ADAPTER_ID } from './newapi/newapi-contracts';

/** Protocol support is known locally; an unknown model is never asserted to be vision-capable. */
export function supportsConversationImageInput(adapterKey: string, evidence: readonly { revision: number; state: string }[]): boolean {
  return adapterKey === NEWAPI_CHAT_ADAPTER_ID &&
    [...evidence].sort((a, b) => b.revision - a.revision)[0]?.state !== 'unsupported';
}

export const conversationImageMaxBytes = 8 * 1024 * 1024;
export interface ConversationImageInput {
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly base64: string;
  readonly checksumSha256: string;
}

/** Ephemeral dispatch input. Never accept remote URLs or persist image bytes in chat logs. */
export function parseConversationImageInput(value: unknown): ConversationImageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid image input');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || typeof item.base64 !== 'string' ||
    item.base64.length > Math.ceil(conversationImageMaxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(item.base64)) throw new TypeError('Invalid image data');
  const bytes = Buffer.from(item.base64, 'base64');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'));
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const mimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : gif ? 'image/gif' : webp ? 'image/webp' : undefined;
  if (bytes.toString('base64') !== item.base64 || !mimeType || mimeType !== item.mimeType || bytes.length > conversationImageMaxBytes ||
    createHash('sha256').update(bytes).digest('hex') !== item.checksumSha256) throw new TypeError('Image content validation failed');
  return { mimeType, base64: item.base64, checksumSha256: item.checksumSha256 as string };
}
