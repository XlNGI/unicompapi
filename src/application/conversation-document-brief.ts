import type { Conversation, MessageId } from '../domain';

export interface ConversationDocumentBriefEntry {
  readonly messageId: MessageId;
  readonly revision: number;
  readonly text: string;
}
export interface ConversationDocumentBrief {
  readonly entries: readonly ConversationDocumentBriefEntry[];
  readonly text: string;
  readonly truncated: boolean;
}

/** Source quotations from persisted user messages. This never creates permissions or model summaries. */
export function collectConversationDocumentBrief(conversation: Conversation, currentId: MessageId): ConversationDocumentBrief {
  const index = conversation.messages.findIndex(message => message.id === currentId);
  if (index < 0) return { entries: [], text: '', truncated: false };
  const candidates: ConversationDocumentBriefEntry[] = [];
  for (let position = index; position >= 0 && index - position < 4_096; position -= 1) {
    const message = conversation.messages[position];
    if (message.documentResult && position !== index) break;
    if (message.role !== 'user' || message.state !== 'completed') continue;
    const text = (message.displayContent ?? message.content).trim();
    if (text) candidates.unshift({ messageId: message.id, revision: message.revision, text });
  }
  // Retain source order with a fixed count/character budget. The Host does
  // not rank business meaning by words such as "must", "do not" or "style".
  const priority = candidates.map((entry, order) => ({ entry, order,
    weight: order === candidates.length - 1 ? 3 : order === 0 ? 2 : 1 }));
  priority.sort((a, b) => b.weight - a.weight || b.order - a.order);
  const selected: typeof priority = [];
  let characters = 0;
  for (const item of priority) {
    const remaining = 15_900 - characters;
    if (remaining <= 0 || selected.length >= 32) break;
    const text = item.entry.text.slice(0, Math.min(item.weight === 3 ? 7_900 : 4_000, remaining));
    selected.push({ ...item, entry: { ...item.entry, text } });
    characters += text.length + 1;
  }
  selected.sort((a, b) => a.order - b.order);
  const entries = selected.map(item => item.entry);
  return { entries, text: entries.map(entry => entry.text).join('\n'),
    truncated: entries.length !== candidates.length || entries.some(entry => entry.text !== candidates.find(item => item.messageId === entry.messageId)?.text) };
}

