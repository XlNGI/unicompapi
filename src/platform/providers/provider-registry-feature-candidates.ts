import { createHash } from 'node:crypto';
import {
  parseUsageSchema,
  toIsoTimestamp,
  toProtocolBindingId,
  validateParameterSchemaV2,
  type ParameterSchemaV2,
  type ProductFeature,
  type UsageSchemaV1
} from '../../domain';
import {
  routeOpenAiCompatibleImageEditProfilesForEnabledModels,
  routeOpenAiCompatibleImageProfilesForEnabledModels,
  routeOpenAiCompatibleReferenceImageProfilesForEnabledModels
} from './newapi/openai-compatible-image-routing';
import { routeOpenAiCompatibleVideoProfilesForEnabledModels } from './newapi/openai-compatible-video-routing';
import {
  isKnownUniCompApiModel,
  isUniCompApiPackage,
  uniCompApiSupportsFeature,
  type UniCompApiModelFeature
} from './newapi/unicompapi-model-capabilities';
import type { ProviderPackageRegistry } from './provider-package-registry';
import type { JsonProviderRegistryStore } from './provider-registry';
import type {
  FeatureCandidateSourcePort,
  ResolvedFeatureCandidateV1,
  ResolvedFeatureSubjectV1
} from './provider-feature-candidates';
import type { RuntimeAuthorizationDecision } from './runtime-authorization-ledger';

export interface ProviderFeatureContractV1 {
  readonly parameterSchema: ParameterSchemaV2;
  readonly resultSchemaId: string;
  readonly resultSchemaRevision: number;
  readonly usageSchema: UsageSchemaV1;
  readonly constraintSetId: string;
  readonly constraintSetRevision: number;
  readonly featureMappingVersion: number;
}

export class ProviderFeatureContractRegistry {
  private readonly contracts: ReadonlyMap<string, ProviderFeatureContractV1>;

  constructor(contracts: readonly ProviderFeatureContractV1[]) {
    const entries = contracts.map((contract) => {
      const validated = validateContract(contract);
      return [contractIdentity(validated), validated] as const;
    });
    if (new Set(entries.map(([identity]) => identity)).size !== entries.length) {
      throw new TypeError('Provider feature contracts must be unique');
    }
    this.contracts = new Map(entries);
  }

  resolve(input: {
    readonly productFeature: ProductFeature;
    readonly parameterSchemaId: string;
    readonly resultSchemaId: string;
    readonly usageSchemaId: string;
    readonly constraintSetId: string;
  }): ProviderFeatureContractV1 | undefined {
    const contract = this.contracts.get(contractIdentity(input));
    return contract ? structuredClone(contract) : undefined;
  }
}

export interface ProviderCandidateRuntimeAuthorizationPort {
  checkAccess(input: {
    readonly providerPackageId: string;
    readonly connectionId: string;
    readonly adapterKey: string;
    readonly operation: 'submit';
  }): Promise<RuntimeAuthorizationDecision>;
}

export class RegistryFeatureCandidateSource implements FeatureCandidateSourcePort {
  constructor(
    private readonly registry: JsonProviderRegistryStore,
    private readonly packages: ProviderPackageRegistry,
    private readonly contracts: ProviderFeatureContractRegistry,
    private readonly authorization: ProviderCandidateRuntimeAuthorizationPort
  ) {}

  async list(subject: ResolvedFeatureSubjectV1): Promise<readonly ResolvedFeatureCandidateV1[]> {
    let snapshot = await this.registry.load();
    if (subject.productFeature === 'text_to_image') {
      const routed = await this.registry.mutate((current) => {
        const next = routeOpenAiCompatibleImageProfilesForEnabledModels(
          current,
          this.packages,
          toIsoTimestamp(new Date().toISOString())
        );
        return { snapshot: next, result: next };
      });
      snapshot = routed;
    }
    if (subject.productFeature === 'image_edit') {
      const routed = await this.registry.mutate((current) => {
        const next = routeOpenAiCompatibleImageEditProfilesForEnabledModels(
          current,
          this.packages,
          toIsoTimestamp(new Date().toISOString())
        );
        return { snapshot: next, result: next };
      });
      snapshot = routed;
    }
    if (subject.productFeature === 'reference_to_image') {
      const routed = await this.registry.mutate((current) => {
        const next = routeOpenAiCompatibleReferenceImageProfilesForEnabledModels(
          current,
          this.packages,
          toIsoTimestamp(new Date().toISOString())
        );
        return { snapshot: next, result: next };
      });
      snapshot = routed;
    }
    if (
      subject.productFeature === 'text_to_video' ||
      subject.productFeature === 'image_to_video'
    ) {
      const routed = await this.registry.mutate((current) => {
        const next = routeOpenAiCompatibleVideoProfilesForEnabledModels(
          current,
          this.packages,
          toIsoTimestamp(new Date().toISOString())
        );
        return { snapshot: next, result: next };
      });
      snapshot = routed;
    }
    const candidates: ResolvedFeatureCandidateV1[] = [];

    for (const model of snapshot.models) {
      const provider = snapshot.providers.find((item) => item.id === model.providerId);
      const connection = snapshot.connections.find((item) => item.id === model.connectionId);
      // Deleted connections and retired models may remain as history tombstones
      // so immutable capability evidence keeps its references. They are never
      // current creation candidates and must not leak into model selectors.
      if (
        !provider ||
        !connection ||
        connection.state === 'deleted' ||
        model.catalogState === 'retired'
      ) continue;
      const profiles = (snapshot.modelProfiles ?? []).filter(
        (item) => item.modelId === model.id
      );

      for (const profile of profiles) {
        const binding = snapshot.protocolBindings.find((item) =>
          item.id === profile.protocolBindingId &&
          item.providerId === model.providerId &&
          item.connectionId === model.connectionId
        );

        for (const feature of profile.features.filter((item) =>
          item.productFeature === subject.productFeature
        )) {
          if (!currentUniCompFeatureSupported(
            profile.packageId,
            model.providerModelKey,
            feature.productFeature
          )) continue;
          const contract = this.contracts.resolve(feature);
          if (!contract) continue;
          if (!packagePublishesAdapter(this.packages, profile.packageId, profile.adapterKey)) {
            // Drop stale profiles after a package stops publishing the adapter
            // (e.g. UniCompAPI no longer exposes images/generations).
            continue;
          }
          const adapterBinding = connection.adapterBindings?.find((item) =>
            item.adapterId === profile.adapterKey &&
            item.protocolId === binding?.protocolId &&
            item.protocolVersion === binding?.protocolVersion
          );
          const bindingAvailable = Boolean(
            binding && adapterBinding &&
            provider.packageId === profile.packageId &&
            connection.packageId === profile.packageId &&
            connection.packageVersion === provider.packageVersion &&
            profile.protocolBindingId === binding.id &&
            binding.adapterKind === profile.adapterKey &&
            adapterRegistered(
              this.packages,
              profile.packageId,
              adapterBinding,
              binding.protocolId,
              binding.protocolVersion
            )
          );
          const runtime = await this.authorization.checkAccess({
            providerPackageId: profile.packageId,
            connectionId: connection.id,
            adapterKey: profile.adapterKey,
            operation: 'submit'
          });
          const policyId = runtime.policyId ?? 'runtime-policy-unavailable';
          const policyRevision = runtime.policyRevision ?? 1;
          const adapterVersion = adapterBinding?.adapterVersion ?? 'unavailable';

          candidates.push({
            candidateId: candidateId(model.id, profile.profileId, feature.productFeature),
            providerName: provider.name,
            connectionName: connection.name,
            modelName: model.displayName,
            recipientName: `${provider.name} / ${connection.name}`,
            outboundScope: outboundScope(provider.accessCategory),
            contentCategories: contentCategories(subject),
            parameterSchema: contract.parameterSchema,
            usageSchema: {
              schemaId: contract.usageSchema.id,
              revision: contract.usageSchema.revision
            },
            cost: { state: 'unknown' },
            eligibility: {
              modelEnabled: model.enabled,
              catalogState: model.catalogState ?? 'present',
              connectionState: connection.state,
              profileStatus: profile.status,
              featureSupported: true,
              bindingAvailable,
              runtimeAllowed: runtime.allowed,
              schemasInterpretable: true
            },
            routeTemplate: {
              packageId: profile.packageId,
              packageVersion: connection.packageVersion ?? provider.packageVersion ?? 'unavailable',
              adapterKey: profile.adapterKey,
              adapterVersion,
              providerId: provider.id,
              connectionId: connection.id,
              connectionRevision: connection.connectionRevision ?? 1,
              connectionConfigVersionId:
                connection.connectionConfigVersionId ?? 'connection-config-unavailable',
              endpointPolicyId: connection.endpointPolicyId ?? 'endpoint-policy-unavailable',
              endpointPolicyRevision: connection.endpointPolicyRevision ?? 1,
              credentialVersionId: connection.credentialVersionId ?? 'credential-version-unavailable',
              modelId: model.id,
              providerModelKey: model.providerModelKey,
              modelRevision: model.revision,
              profileId: profile.profileId,
              profileRevision: profile.revision,
              protocolBindingId: binding?.id ?? toProtocolBindingId(profile.protocolBindingId),
              protocolBindingRevision: 1,
              productFeature: feature.productFeature,
              ...(feature.internalPurpose ? { internalPurpose: feature.internalPurpose } : {}),
              featureMappingVersion: contract.featureMappingVersion,
              parameterSchemaId: contract.parameterSchema.schemaId,
              parameterSchemaRevision: contract.parameterSchema.revision,
              resultSchemaId: contract.resultSchemaId,
              resultSchemaRevision: contract.resultSchemaRevision,
              usageSchemaId: contract.usageSchema.id,
              usageSchemaRevision: contract.usageSchema.revision,
              constraintSetId: contract.constraintSetId,
              constraintSetRevision: contract.constraintSetRevision,
              runtimePolicyId: policyId,
              runtimePolicyRevision: policyRevision
            }
          });
        }
      }
    }
    return candidates;
  }
}

function validateContract(contract: ProviderFeatureContractV1): ProviderFeatureContractV1 {
  const parameterSchema = validateParameterSchemaV2(contract.parameterSchema);
  const usageSchema = parseUsageSchema(contract.usageSchema);
  if (
    !stableId(contract.resultSchemaId) ||
    !stableId(contract.constraintSetId) ||
    !positiveInteger(contract.resultSchemaRevision) ||
    !positiveInteger(contract.constraintSetRevision) ||
    !positiveInteger(contract.featureMappingVersion)
  ) {
    throw new TypeError('Provider feature contract is invalid');
  }
  return {
    parameterSchema,
    resultSchemaId: contract.resultSchemaId,
    resultSchemaRevision: contract.resultSchemaRevision,
    usageSchema,
    constraintSetId: contract.constraintSetId,
    constraintSetRevision: contract.constraintSetRevision,
    featureMappingVersion: contract.featureMappingVersion
  };
}

function contractIdentity(input: {
  readonly productFeature?: ProductFeature;
  readonly parameterSchema?: ParameterSchemaV2;
  readonly parameterSchemaId?: string;
  readonly resultSchemaId: string;
  readonly usageSchema?: UsageSchemaV1;
  readonly usageSchemaId?: string;
  readonly constraintSetId: string;
}): string {
  return [
    input.productFeature ?? input.parameterSchema!.productFeature,
    input.parameterSchemaId ?? input.parameterSchema!.schemaId,
    input.resultSchemaId,
    input.usageSchemaId ?? input.usageSchema!.id,
    input.constraintSetId
  ].join('\u0000');
}

function currentUniCompFeatureSupported(
  packageId: string,
  providerModelKey: string,
  productFeature: ProductFeature
): boolean {
  if (!isUniCompApiPackage(packageId) || !isKnownUniCompApiModel(providerModelKey)) {
    return true;
  }
  const supportedFeatures: readonly UniCompApiModelFeature[] = [
    'text_chat',
    'text_reasoning',
    'text_to_image',
    'reference_to_image',
    'image_edit',
    'text_to_video',
    'image_to_video'
  ];
  if (!supportedFeatures.includes(productFeature as UniCompApiModelFeature)) {
    return false;
  }
  return uniCompApiSupportsFeature(
    packageId,
    providerModelKey,
    productFeature as UniCompApiModelFeature
  );
}

function adapterRegistered(
  packages: ProviderPackageRegistry,
  packageId: string,
  adapter: { readonly adapterId: string; readonly adapterVersion: string },
  protocolId: string,
  protocolVersion: string
): boolean {
  try {
    packages.resolveAdapter(
      packageId,
      adapter.adapterId,
      adapter.adapterVersion,
      protocolId,
      protocolVersion
    );
    return true;
  } catch {
    return false;
  }
}

function packagePublishesAdapter(
  packages: ProviderPackageRegistry,
  packageId: string,
  adapterId: string
): boolean {
  const templates = packages.listSafeTemplates().filter((item) => item.packageId === packageId);
  for (const template of templates) {
    try {
      const resolved = packages.resolveTemplate(packageId, template.templateId);
      if (resolved.adapters.some((adapter) => adapter.adapterId === adapterId)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function candidateId(modelId: string, profileId: string, feature: ProductFeature): string {
  return `candidate-${createHash('sha256')
    .update(`${modelId}\u0000${profileId}\u0000${feature}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function outboundScope(
  access: 'online' | 'local' | 'lan' | 'custom_remote'
): ResolvedFeatureCandidateV1['outboundScope'] {
  if (access === 'local') return 'local_device';
  if (access === 'lan') return 'local_network';
  return 'external_service';
}

function contentCategories(subject: ResolvedFeatureSubjectV1): readonly string[] {
  return [
    subject.subject.kind === 'conversation_response_draft'
      ? 'conversation_text'
      : 'prompt_text',
    ...(subject.imageCount > 0 ? ['image_media'] : []),
    ...(subject.videoCount > 0 ? ['video_media'] : []),
    ...(subject.contextCount > 0 ? ['project_context'] : [])
  ];
}

function stableId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
