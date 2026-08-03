import {
  parseFeatureCandidateSubject,
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

export function createVideoProviderFeatureContracts(): readonly ProviderFeatureContractV1[] {
  return viduPackagedModelContracts.flatMap((modelContract) => {
    const features = modelContract.definition.profileTemplates.flatMap(
      (template) => template.features
    );
    return modelContract.parameterSchemas.flatMap((parameterSchema) => {
      if (parameterSchema.productFeature !== 'image_to_video') return [];
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
