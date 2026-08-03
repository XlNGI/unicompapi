import type { ProductFeature } from './product-feature';

export const catalogStates = ['present', 'missing', 'retired'] as const;
export type CatalogState = (typeof catalogStates)[number];

export const modelProfileStatuses = [
  'declared',
  'verified',
  'restricted',
  'disabled'
] as const;
export type ModelProfileStatus = (typeof modelProfileStatuses)[number];

export interface ModelFeatureProfileFeature {
  readonly productFeature: ProductFeature;
  readonly internalPurpose?: string;
  readonly parameterSchemaId: string;
  readonly resultSchemaId: string;
  readonly usageSchemaId: string;
  readonly constraintSetId: string;
}

export interface ModelFeatureProfileTemplate {
  readonly templateId: string;
  readonly adapterKey: string;
  readonly protocolDefinitionId: string;
  readonly features: readonly ModelFeatureProfileFeature[];
  readonly sourceDocumentRevision: string;
}

export interface ProviderModelDefinition {
  readonly schemaVersion: 1;
  readonly definitionId: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerModelKey: string;
  readonly profileTemplates: readonly ModelFeatureProfileTemplate[];
}

export interface ModelFeatureProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly revision: number;
  readonly packageId: string;
  readonly sourceTemplateId: string;
  readonly adapterKey: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly protocolBindingId: string;
  readonly status: ModelProfileStatus;
  readonly features: readonly ModelFeatureProfileFeature[];
  readonly evidenceIds: readonly string[];
  readonly recordedAt: string;
}
