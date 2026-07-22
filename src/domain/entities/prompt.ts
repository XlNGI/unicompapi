export const promptSupplementSources = [
  'project_context',
  'selected_context',
  'style',
  'structure',
  'constraint',
  'translation',
  'model_format'
] as const;

export type PromptSupplementSource =
  (typeof promptSupplementSources)[number];

export interface PromptSupplement {
  readonly content: string;
  readonly source: PromptSupplementSource;
  readonly sourceReference?: string;
}

export interface PromptSnapshot {
  readonly originalInput: string;
  readonly systemSupplements: readonly PromptSupplement[];
  readonly finalPrompt: string;
}
