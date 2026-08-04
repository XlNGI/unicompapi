import {
  applyImageStructuredResult,
  promptSupplementSources,
  toDraftId,
  toIsoTimestamp,
  type ImageObservation,
  type ImageObservationSet,
  type ImageWorkspaceRepository,
  type PromptSnapshot
} from '../../domain';
import type { ImageWorkspaceMutationCoordinator } from '../ipc/image-workspace-mutations';

export interface ImageSpecializedResultV1 {
  readonly schemaVersion: 1;
  readonly productFeature: 'image_understanding' | 'image_to_prompt';
  readonly observations: ImageObservationSet;
  readonly promptDraft?: {
    readonly finalPrompt: string;
    readonly systemSupplements: PromptSnapshot['systemSupplements'];
  };
}

export class ImageSpecializedResultReceiver {
  constructor(
    private readonly drafts: ImageWorkspaceRepository,
    private readonly mutations: ImageWorkspaceMutationCoordinator,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  receive(input: {
    readonly draftId: string;
    readonly expectedDraftUpdatedAt: string;
    readonly result: ImageSpecializedResultV1;
  }) {
    return this.mutations.enqueue(async () => {
      const result = parseResult(input.result);
      const draft = await this.drafts.get(toDraftId(input.draftId));
      if (!draft) throw receiverError('draft_not_found');
      if (draft.updatedAt !== input.expectedDraftUpdatedAt) {
        throw receiverError('draft_revision_changed');
      }
      if (draft.mode !== result.productFeature) {
        throw receiverError('result_feature_mismatch');
      }

      const analyzedAt = toIsoTimestamp(this.now());
      const observations = normalizeObservations(result.observations);
      const updated = draft.mode === 'image_understanding'
        ? applyImageStructuredResult(draft, { observations, analyzedAt })
        : applyImageStructuredResult(draft, {
            observations,
            analyzedAt,
            ...normalizePromptDraft(result.promptDraft)
          });
      await this.drafts.save(updated);
      return updated;
    });
  }
}

export class ImageSpecializedResultReceiverError extends Error {
  constructor(
    readonly code:
      | 'draft_not_found'
      | 'draft_revision_changed'
      | 'result_feature_mismatch'
      | 'invalid_result'
  ) {
    super(`Image specialized result rejected: ${code}`);
    this.name = 'ImageSpecializedResultReceiverError';
  }
}

function normalizeObservations(value: ImageObservationSet): ImageObservationSet {
  const groups = [
    ['visible-fact', value.visibleFacts],
    ['model-inference', value.modelInferences],
    ['uncertainty', value.uncertainties],
    ['unrecognized', value.unrecognized]
  ] as const;
  if (groups.reduce((total, [, items]) => total + items.length, 0) > 200) {
    throw receiverError('invalid_result');
  }
  const normalized = groups.map(([prefix, items]) => {
    if (items.length > 100) throw receiverError('invalid_result');
    return items.map((item, index): ImageObservation => {
      if (!isRecord(item) || Object.keys(item).some((key) =>
        !['id', 'content'].includes(key)
      )) throw receiverError('invalid_result');
      return {
        id: `${prefix}-${index + 1}`,
        content: normalizedText(item.content as string, 1_000)
      };
    });
  });
  return {
    visibleFacts: normalized[0],
    modelInferences: normalized[1],
    uncertainties: normalized[2],
    unrecognized: normalized[3]
  };
}

function normalizePromptDraft(
  value: ImageSpecializedResultV1['promptDraft']
): NonNullable<ImageSpecializedResultV1['promptDraft']> {
  if (!value || value.systemSupplements.length > 20) {
    throw receiverError('invalid_result');
  }
  return {
    finalPrompt: normalizedText(value.finalPrompt, 20_000),
    systemSupplements: value.systemSupplements.map((item) => {
      if (!isRecord(item) || Object.keys(item).some((key) =>
        !['content', 'source', 'sourceReference'].includes(key)
      ) || !promptSupplementSources.includes(item.source as never)) {
        throw receiverError('invalid_result');
      }
      return {
        content: normalizedText(item.content as string, 4_000),
        source: item.source as PromptSnapshot['systemSupplements'][number]['source'],
        ...(item.sourceReference
          ? { sourceReference: normalizedText(item.sourceReference as string, 500) }
          : {})
      };
    })
  };
}

function parseResult(value: unknown): ImageSpecializedResultV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !['image_understanding', 'image_to_prompt'].includes(String(value.productFeature))) {
    throw receiverError('invalid_result');
  }
  const feature = value.productFeature as ImageSpecializedResultV1['productFeature'];
  const allowed = feature === 'image_to_prompt'
    ? ['schemaVersion', 'productFeature', 'observations', 'promptDraft']
    : ['schemaVersion', 'productFeature', 'observations'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
    !isRecord(value.observations)) {
    throw receiverError('invalid_result');
  }
  const observations = value.observations;
  const observationKeys = [
    'visibleFacts', 'modelInferences', 'uncertainties', 'unrecognized'
  ];
  if (Object.keys(observations).some((key) => !observationKeys.includes(key)) ||
    observationKeys.some((key) => !Array.isArray(observations[key]))) {
    throw receiverError('invalid_result');
  }
  if (feature === 'image_to_prompt' && (
    !isRecord(value.promptDraft) ||
    Object.keys(value.promptDraft).some((key) =>
      !['finalPrompt', 'systemSupplements'].includes(key)
    ) ||
    !Array.isArray(value.promptDraft.systemSupplements)
  )) {
    throw receiverError('invalid_result');
  }
  return value as unknown as ImageSpecializedResultV1;
}

function normalizedText(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw receiverError('invalid_result');
  const normalized = value
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw receiverError('invalid_result');
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function receiverError(
  code: ImageSpecializedResultReceiverError['code']
): ImageSpecializedResultReceiverError {
  return new ImageSpecializedResultReceiverError(code);
}
