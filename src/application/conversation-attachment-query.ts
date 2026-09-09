import type { ConversationIntentPlan } from '../domain';

/** Use validated task requirements; provider prompts are not source-reading instructions. */
export function conversationAttachmentQuery(
  plan: ConversationIntentPlan | undefined,
  source: { readonly content: string; readonly displayContent?: string }
): string {
  const requirements = plan?.parameters.requirements;
  return typeof requirements === 'string' && requirements.trim()
    ? requirements
    : source.displayContent ?? source.content;
}
