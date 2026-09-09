import {
  parseFeatureCandidateSubject,
  evaluatePromptEnhanceRequirement,
  toAssetId,
  toProjectContextId,
  type AssetRepository,
  type DynamicParameterValue,
  type FeatureCandidateSubjectV1,
  type ImageWorkspaceDraft,
  type ImageWorkspaceRepository,
  type ParameterValue,
  type ProductFeatureSurface,
  type ProjectContextRepository,
  type ProjectId
} from '../../domain';
import { composeImagePromptEnhancementInput } from '../../shared/prompt-enhancement-input';
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
  NEWAPI_IMAGE_CONSTRAINT_SET_ID,
  NEWAPI_IMAGE_EDIT_CONSTRAINT_SET_ID,
  NEWAPI_REFERENCE_IMAGE_CONSTRAINT_SET_ID,
  NEWAPI_IMAGE_RESULT_SCHEMA_ID,
  newApiDefaultImageEditParameterSchema,
  newApiDefaultReferenceToImageParameterSchema,
  newApiDefaultTextToImageParameterSchema,
  newApiImageUsageSchema,
  uniCompApiDefaultTextToImageParameterSchema
} from './newapi/newapi-contracts';
import {
  uniCompApiQwenImageReferenceToImageParameterSchema,
  uniCompApiQwenImageTextToImageParameterSchema,
  uniCompApiSeedream5TextToImageParameterSchema
} from './newapi/unicompapi-model-capabilities';
import {
  DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID,
  DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID,
  DOUBAO_VISION_CONSTRAINT_SET_ID,
  doubaoImageToPromptParameterSchema,
  doubaoImageUnderstandingParameterSchema,
  doubaoVisionUsageSchema
} from './volcengine/volcengine-contracts';
import {
  viduPackagedModelContracts,
  viduUsageSchema
} from './vidu/vidu-contracts';

export class ProjectImageFeatureSubjectResolver
  implements FeatureSubjectResolverPort {
  constructor(
    private readonly projectId: ProjectId,
    private readonly drafts: ImageWorkspaceRepository,
    private readonly contexts: ProjectContextRepository,
    private readonly assets: AssetRepository
  ) {
    if (contexts.projectId !== projectId) {
      throw new TypeError('Image feature repositories belong to different projects');
    }
  }

  async resolve(subject: FeatureCandidateSubjectV1): Promise<ResolvedFeatureSubjectV1> {
    const parsed = parseFeatureCandidateSubject(subject);
    if (parsed.kind !== 'draft') {
      throw new TypeError('Image feature resolver requires a persisted draft subject');
    }
    const draft = await this.drafts.get(parsed.draftId);
    if (
      !draft ||
      draft.projectId !== this.projectId ||
      parsed.draftRevision !== imageDraftRevision(draft.updatedAt)
    ) {
      throw new TypeError('Image draft revision changed');
    }
    if (draft.state !== 'saved') {
      throw new TypeError('Image draft must be saved before candidate selection');
    }
    const productFeature = featureForDraft(draft);
    const surface: ProductFeatureSurface = draft.mode === 'quick_image'
      ? 'quick'
      : 'professional';
    const contextSnapshots = await this.resolveContexts(draft, surface);
    const materialReferences = [];
    if (draft.input) {
      const asset = await this.assets.get(toAssetId(draft.input.assetId));
      if (!asset || asset.projectId !== this.projectId || asset.mediaKind !== 'image') {
        throw new TypeError('Selected image material is unavailable');
      }
      materialReferences.push({
        kind: 'asset' as const,
        referenceId: asset.id,
        revision: 1
      });
    }
    const outboundTextSnapshot = outboundText(draft);
    if (outboundTextSnapshot.trim().length === 0) {
      throw new TypeError('Image feature outbound text cannot be empty');
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
    draft: ImageWorkspaceDraft,
    surface: ProductFeatureSurface
  ) {
    const selections = [];
    const contexts = [];
    for (const reference of draft.contextReferences) {
      if (reference.kind !== 'project_context') {
        throw new TypeError('Image creation only accepts registered project contexts');
      }
      if (
        reference.contextRevision === undefined ||
        reference.includeInPrompt === undefined
      ) {
        throw new TypeError('Project context must be selected again to pin a revision');
      }
      const context = await this.contexts.get(
        toProjectContextId(reference.referenceId)
      );
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

export async function assertImagePromptEnhancementSatisfied(input: {
  readonly projectId: ProjectId;
  readonly draft: ImageWorkspaceDraft;
  readonly contexts: ProjectContextRepository;
}): Promise<void> {
  const references = input.draft.contextReferences.filter(
    (reference) => reference.kind === 'project_context' && reference.includeInPrompt === true
  );
  const structuredInput = composeImagePromptEnhancementInput(input.draft).text;
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
    surface: 'professional',
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

function routeParameterValues(
  values: Readonly<Record<string, DynamicParameterValue>>
): Readonly<Record<string, ParameterValue>> {
  if (!isRouteParameterValue(values)) {
    throw new TypeError('Image feature parameters contain unsupported values');
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

export function imageDraftRevision(updatedAt: string): number {
  const revision = Date.parse(updatedAt);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('Image draft timestamp cannot form a stable revision');
  }
  return revision;
}

export function createImageProviderFeatureContracts(): readonly ProviderFeatureContractV1[] {
  const viduContracts = viduPackagedModelContracts.flatMap((modelContract) => {
    const features = modelContract.definition.profileTemplates.flatMap(
      (template) => template.features
    );
    return modelContract.parameterSchemas.flatMap((parameterSchema) => {
      if (![
        'text_to_image',
        'reference_to_image',
        'image_edit'
      ].includes(parameterSchema.productFeature)) {
        return [];
      }
      const feature = features.find(
        (item) => item.parameterSchemaId === parameterSchema.schemaId
      );
      if (!feature) throw new TypeError('Vidu image feature contract is incomplete');
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
      parameterSchema: newApiDefaultTextToImageParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_IMAGE_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: uniCompApiDefaultTextToImageParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_IMAGE_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: uniCompApiQwenImageTextToImageParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_IMAGE_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: uniCompApiSeedream5TextToImageParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_IMAGE_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: newApiDefaultImageEditParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_IMAGE_EDIT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: newApiDefaultReferenceToImageParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_REFERENCE_IMAGE_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: uniCompApiQwenImageReferenceToImageParameterSchema,
      resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiImageUsageSchema,
      constraintSetId: NEWAPI_REFERENCE_IMAGE_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: doubaoImageUnderstandingParameterSchema,
      resultSchemaId: DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: doubaoVisionUsageSchema,
      constraintSetId: DOUBAO_VISION_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: doubaoImageToPromptParameterSchema,
      resultSchemaId: DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: doubaoVisionUsageSchema,
      constraintSetId: DOUBAO_VISION_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    }
  ];
}

function featureForDraft(draft: ImageWorkspaceDraft) {
  const explicit = draft.featureSelection?.productFeature;
  if (explicit) return explicit;
  if (draft.mode === 'quick_image') {
    if (draft.input) {
      throw new TypeError('Legacy quick reference must move to professional image creation');
    }
    return 'text_to_image' as const;
  }
  if (draft.mode === 'professional_image') {
    throw new TypeError('Professional image creation requires an explicit feature');
  }
  if (draft.mode === 'image_understanding') return 'image_understanding' as const;
  if (draft.mode === 'image_to_prompt') return 'image_to_prompt' as const;
  return 'image_edit' as const;
}

function outboundText(draft: ImageWorkspaceDraft): string {
  if (draft.mode === 'image_to_prompt') {
    return [draft.imageToPrompt.purpose, ...draft.imageToPrompt.requirements]
      .filter(Boolean)
      .join('\n');
  }
  return draft.prompt.finalPrompt;
}
