import type { MessageDto } from '../../shared/chat-context-ipc';
import { projectDocumentBody } from './documentBodyPreview';

export function messageClipboardText(message: MessageDto, documentBody: boolean): string {
  const content = message.documentResult?.validatedContent ?? message.content;
  return documentBody ? projectDocumentBody(content).content : content;
}

export async function writeMessageClipboard(text: string): Promise<void> {
  const desktop = window.unicomp?.clipboard;
  if (desktop) return desktop.writeText(text);
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
}
