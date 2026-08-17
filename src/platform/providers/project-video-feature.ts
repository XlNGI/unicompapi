import {
  parseFeatureCandidateSubject,
  evaluatePromptEnhanceRequirement,
  toAssetId,
  toProjectContextId,
  type AssetRepository,
  type FeatureCandidateSubjectV1,
  type ParameterValue,
  type ProductFeatureSurface,
  type ProjectContextRepository,
  type ProjectId,
  type VideoDynamicParameterValue,
  type VideoWorkspaceDraft,
  type VideoWorkspaceRepository
} from '../../domain';
import { composeVideoPromptEnhancementInput } from '../../shared/prompt-enhancement-input';
import {
  freezeProjectContextOutboundSnapshots,
  pinProjectContextSelection
} from '../repositories';
import type {
  FeatureSubjectResolverPort,
  ResolvedFeatureSubjectV1
} from './provider-feature-candidates';
import type { ProviderFeatureContractV1 } from './provider-registry-feature-candidates';
import {
  NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_VIDEO_RESULT_SCHEMA_ID,
  newApiDefaultImageToVideoParameterSchema,
  newApiDefaultTextToVideoParameterSchema,
  newApiVideoUsageSchema
} from './newapi/newapi-contracts';
import {
  viduPackagedModelContracts,
  viduUsageSchema
} from './vidu/vidu-contracts';

export class ProjectVideoFeatureSubjectResolver
  implements FeatureSubjectResolverPort {
  constructor(
    private readonly projectId: ProjectId,
    private readonly drafts: VideoWorkspaceRepository,
    private readonly contexts: ProjectContextRepository,
    private readonly assets: AssetRepository
  ) {
    if (contexts.projectId !== projectId) {
      throw new TypeError('Video feature repositories belong to different projects');
    }
  }

  async resolve(subject: FeatureCandidateSubjectV1): Promise<ResolvedFeatureSubjectV1> {
    const parsed = parseFeatureCandidateSubject(subject);
    if (parsed.kind !== 'draft') {
      throw new TypeError('Video feature resolver requires a persisted draft subject');
    }
    const draft = await this.drafts.get(parsed.draftId);
    if (
      !draft ||
      draft.projectId !== this.projectId ||
      parsed.draftRevision !== videoDraftRevision(draft.updatedAt)
    ) {
      throw new TypeError('Video draft revision changed');
    }
    if (draft.state !== 'saved') {
      throw new TypeError('Video draft must be saved before candidate selection');
    }

    const productFeature = featureForDraft(draft);
    const surface: ProductFeatureSurface = draft.mode === 'quick_video'
      ? 'quick'
      : 'professional';
    const contextSnapshots = await this.resolveContexts(draft, surface);
    const materialReferences = [];

    if (draft.mode === 'quick_video') {
      if (draft.quick.reference || draft.contextReferences.length > 0) {
        throw new TypeError('Quick video requires text only and cannot consume context');
      }
    } else if (draft.mode === 'text_to_video') {
      if (draft.textToVideo.materials) {
        throw new TypeError('Text-to-video cannot consume material slots');
      }
    } else {
      if (draft.imageToVideo.materials) {
        throw new TypeError('Image-to-video cannot consume dynamic material slots');
      }
      const selection = draft.imageToVideo.source;
      if (!selection || selection.mediaKind !== 'image') {
        throw new TypeError('Image-to-video requires exactly one image source');
      }
      const asset = await this.assets.get(toAssetId(selection.assetId));
      if (!asset || asset.projectId !== this.projectId || asset.mediaKind !== 'image') {
        throw new TypeError('Selected image source is unavailable');
      }
      materialReferences.push({
        kind: 'asset' as const,
        referenceId: asset.id,
        revision: 1
      });
    }

    const outboundTextSnapshot = draft.prompt.finalPrompt;
    if (outboundTextSnapshot.trim().length === 0) {
      throw new TypeError('Video feature outbound text cannot be empty');
    }

    return {
      projectId: this.projectId,
      subject: parsed,
      productFeature,
      surface,
      imageCount: materialReferences.length,
      videoCount: 0,
      contextCount: contextSnapshots.length,
      parameterValues: routeParameterValues(
        draft.featureSelection?.parameterValues ?? {}
      ),
      outboundTextSnapshot,
      materialReferences,
      contextContentHashes: contextSnapshots.map((snapshot) => snapshot.contentHash)
    };
  }

  private async resolveContexts(
    draft: VideoWorkspaceDraft,
    surface: ProductFeatureSurface
  ) {
    const selections = [];
    const contexts = [];
    for (const reference of draft.contextReferences) {
      if (reference.kind !== 'project_context') {
        throw new TypeError('Video creation only accepts registered project contexts');
      }
      if (
        reference.contextRevision === undefined ||
        reference.includeInPrompt === undefined
      ) {
        throw new TypeError('Project context must be selected again to pin a revision');
      }
      const context = await this.contexts.get(toProjectContextId(reference.referenceId));
      if (!context) throw new TypeError('Selected project context is unavailable');
      contexts.push(context);
      selections.push(pinProjectContextSelection(
        context,
        reference.contextRevision,
        reference.includeInPrompt
      ));
    }
    return freezeProjectContextOutboundSnapshots({
      projectId: this.projectId,
      surface,
      contexts,
      selections
    });
  }
}

export function videoDraftRevision(updatedAt: string): number {
  const revision = Date.parse(updatedAt);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('Video draft timestamp cannot form a stable revision');
  }
  return revision;
}

export async function assertVideoPromptEnhancementSatisfied(input: {
  readonly projectId: ProjectId;
  readonly draft: VideoWorkspaceDraft;
  readonly contexts: ProjectContextRepository;
}): Promise<void> {
  const references = input.draft.contextReferences.filter(
    (reference) => reference.kind === 'project_context' && reference.includeInPrompt === true
  );
  const structuredInput = composeVideoPromptEnhancementInput(input.draft).text;
  if (references.length === 0 && structuredInput.trim().length === 0) return;

  const contexts = [];
  const selections = [];
  for (const reference of references) {
    if (reference.contextRevision === undefined) {
      throw new TypeError('Project context must be selected again before prompt enhancement');
    }
    const context = await input.contexts.get(toProjectContextId(reference.referenceId));
    if (!context) throw new TypeError('Selected project context is unavailable');
    contexts.push(context);
    selections.push(pinProjectContextSelection(
      context,
      reference.contextRevision,
      true
    ));
  }
  const contextSnapshots = freezeProjectContextOutboundSnapshots({
    projectId: input.projectId,
    surface: input.draft.mode === 'quick_video' ? 'quick' : 'professional',
    contexts,
    selections
  });
  const enhancement = [...input.draft.prompt.systemSupplements]
    .reverse()
    .find((supplement) => supplement.source === 'enhancement');
  const requirement = await evaluatePromptEnhanceRequirement({
    policy: {
      allowWithoutContext: true,
      requireWhenContextExists: true
    },
    originalInput: input.draft.prompt.originalInput,
    structuredInput,
    contextSnapshots,
    enhancementSourceReferences: enhancement ? [enhancement.sourceReference] : []
  });
  if (!requirement.satisfied) {
    throw new TypeError('Current prompt content requires a current prompt enhancement');
  }
  if (input.draft.prompt.finalPrompt.trim() !== enhancement?.content.trim()) {
    throw new TypeError('The current prompt enhancement must be used as the final prompt');
  }
}

export function createVideoProviderFeatureContracts(): readonly ProviderFeatureContractV1[] {
  const viduContracts = viduPackagedModelContracts.flatMap((modelContract) => {
    const features = modelContract.definition.profileTemplates.flatMap(
      (template) => template.features
    );
    return modelContract.parameterSchemas.flatMap((parameterSchema) => {
      // Official Vidu text2video schemas must be registered so quick/text video
      // pages can resolve selectable candidates (image_to_video alone is not enough).
      if (
        parameterSchema.productFeature !== 'image_to_video' &&
        parameterSchema.productFeature !== 'text_to_video'
      ) {
        return [];
      }
      const feature = features.find(
        (item) => item.parameterSchemaId === parameterSchema.schemaId
      );
      if (!feature) throw new TypeError('Vidu video feature contract is incomplete');
      return [{
        parameterSchema,
        resultSchemaId: feature.resultSchemaId,
        resultSchemaRevision: 1,
        usageSchema: viduUsageSchema,
        constraintSetId: feature.constraintSetId,
        constraintSetRevision: 1,
        featureMappingVersion: 1
      }];
    });
  });
  return [
    ...viduContracts,
    {
      parameterSchema: newApiDefaultTextToVideoParameterSchema,
      resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiVideoUsageSchema,
      constraintSetId: NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: newApiDefaultImageToVideoParameterSchema,
      resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiVideoUsageSchema,
      constraintSetId: NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    }
  ];
}

function featureForDraft(draft: VideoWorkspaceDraft) {
  const explicit = draft.featureSelection?.productFeature;
  if (explicit) return explicit;
  if (draft.mode === 'quick_video') {
    if (draft.quick.reference) {
      throw new TypeError('Legacy quick video material must be migrated explicitly');
    }
    return 'text_to_video' as const;
  }
  return draft.mode === 'image_to_video'
    ? 'image_to_video' as const
    : 'text_to_video' as const;
}

function routeParameterValues(
  values: Readonly<Record<string, VideoDynamicParameterValue>>
): Readonly<Record<string, ParameterValue>> {
  if (!isRouteParameterValue(values)) {
    throw new TypeError('Video feature parameters contain unsupported values');
  }
  return values;
}

function isRouteParameterValue(
  value: unknown
): value is Readonly<Record<string, ParameterValue>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isParameterValue);
}

function isParameterValue(value: unknown): value is ParameterValue {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isParameterValue);
  return isRouteParameterValue(value);
}
