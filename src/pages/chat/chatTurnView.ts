export type LiveReplyCue = 'thinking' | 'organizing' | 'answer';

export function liveReplyCue(input: {
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly reasoning: string;
  readonly content: string;
  readonly inProgress: boolean;
}): LiveReplyCue {
  if (input.content.trim()) return 'answer';
  if (!input.inProgress) return 'answer';
  if (input.productFeature === 'text_reasoning' || input.reasoning.trim()) return 'thinking';
  return 'organizing';
}

export function reasoningExpanded(input: {
  readonly reasoning: string;
  readonly content: string;
  readonly inProgress: boolean;
  readonly opened: boolean;
}): boolean {
  if (!input.reasoning.trim()) return false;
  if (!input.content.trim() && input.inProgress) return true;
  return input.opened;
}
