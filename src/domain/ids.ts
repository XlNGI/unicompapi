declare const domainIdBrand: unique symbol;

type DomainId<Name extends string> = string & {
  readonly [domainIdBrand]: Name;
};

export type ProjectId = DomainId<'ProjectId'>;
export type DraftId = DomainId<'DraftId'>;
export type AssetId = DomainId<'AssetId'>;
export type FileReferenceId = DomainId<'FileReferenceId'>;
export type TaskId = DomainId<'TaskId'>;
export type ExecutionId = DomainId<'ExecutionId'>;
export type WorkId = DomainId<'WorkId'>;
export type ProviderId = DomainId<'ProviderId'>;
export type ConnectionId = DomainId<'ConnectionId'>;
export type ModelId = DomainId<'ModelId'>;
export type ProtocolBindingId = DomainId<'ProtocolBindingId'>;
export type ProviderOperationRecordId = DomainId<'ProviderOperationRecordId'>;
export type CapabilityEvidenceId = DomainId<'CapabilityEvidenceId'>;
export type RoutingPreferenceId = DomainId<'RoutingPreferenceId'>;
export type VideoEditDraftId = DomainId<'VideoEditDraftId'>;
export type VideoExportPlanId = DomainId<'VideoExportPlanId'>;
export type VideoClipId = DomainId<'VideoClipId'>;
export type TextOverlayId = DomainId<'TextOverlayId'>;
export type ConversationId = DomainId<'ConversationId'>;
export type MessageId = DomainId<'MessageId'>;
export type ConversationResponseDraftId = DomainId<'ConversationResponseDraftId'>;
export type ConversationResponseExecutionId = DomainId<'ConversationResponseExecutionId'>;
export type ConversationResponseStreamEventId = DomainId<'ConversationResponseStreamEventId'>;
export type ProjectContextId = DomainId<'ProjectContextId'>;
export type ProjectContextDraftId = DomainId<'ProjectContextDraftId'>;
export type ProjectContextFragmentId = DomainId<'ProjectContextFragmentId'>;
export type DocumentDraftId = DomainId<'DocumentDraftId'>;
export type ProviderInvocationAttemptId = DomainId<'ProviderInvocationAttemptId'>;
export type ProviderInvocationEventId = DomainId<'ProviderInvocationEventId'>;
export type ProviderUsageObservationId = DomainId<'ProviderUsageObservationId'>;
export type LocalResultObservationId = DomainId<'LocalResultObservationId'>;
export type UsageSchemaId = DomainId<'UsageSchemaId'>;
export type ProviderExecutionRouteSnapshotId = DomainId<'ProviderExecutionRouteSnapshotId'>;
export type SubmissionIntentId = DomainId<'SubmissionIntentId'>;

function toDomainId<Name extends string>(value: string, label: Name): DomainId<Name> {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError(`${label} cannot be empty`);
  }

  return normalized as DomainId<Name>;
}

export const toProjectId = (value: string) => toDomainId(value, 'ProjectId');
export const toDraftId = (value: string) => toDomainId(value, 'DraftId');
export const toAssetId = (value: string) => toDomainId(value, 'AssetId');
export const toFileReferenceId = (value: string) =>
  toDomainId(value, 'FileReferenceId');
export const toTaskId = (value: string) => toDomainId(value, 'TaskId');
export const toExecutionId = (value: string) =>
  toDomainId(value, 'ExecutionId');
export const toWorkId = (value: string) => toDomainId(value, 'WorkId');
export const toProviderId = (value: string) => toDomainId(value, 'ProviderId');
export const toConnectionId = (value: string) =>
  toDomainId(value, 'ConnectionId');
export const toModelId = (value: string) => toDomainId(value, 'ModelId');
export const toProtocolBindingId = (value: string) =>
  toDomainId(value, 'ProtocolBindingId');
export const toProviderOperationRecordId = (value: string) =>
  toDomainId(value, 'ProviderOperationRecordId');
export const toCapabilityEvidenceId = (value: string) =>
  toDomainId(value, 'CapabilityEvidenceId');
export const toRoutingPreferenceId = (value: string) =>
  toDomainId(value, 'RoutingPreferenceId');
export const toVideoEditDraftId = (value: string) =>
  toDomainId(value, 'VideoEditDraftId');
export const toVideoExportPlanId = (value: string) =>
  toDomainId(value, 'VideoExportPlanId');
export const toVideoClipId = (value: string) =>
  toDomainId(value, 'VideoClipId');
export const toTextOverlayId = (value: string) =>
  toDomainId(value, 'TextOverlayId');
export const toConversationId = (value: string) =>
  toDomainId(value, 'ConversationId');
export const toMessageId = (value: string) =>
  toDomainId(value, 'MessageId');
export const toConversationResponseDraftId = (value: string) =>
  toDomainId(value, 'ConversationResponseDraftId');
export const toConversationResponseExecutionId = (value: string) =>
  toDomainId(value, 'ConversationResponseExecutionId');
export const toConversationResponseStreamEventId = (value: string) =>
  toDomainId(value, 'ConversationResponseStreamEventId');
export const toProjectContextId = (value: string) =>
  toDomainId(value, 'ProjectContextId');
export const toProjectContextDraftId = (value: string) =>
  toDomainId(value, 'ProjectContextDraftId');
export const toProjectContextFragmentId = (value: string) =>
  toDomainId(value, 'ProjectContextFragmentId');
export const toDocumentDraftId = (value: string) =>
  toDomainId(value, 'DocumentDraftId');
export const toProviderInvocationAttemptId = (value: string) =>
  toDomainId(value, 'ProviderInvocationAttemptId');
export const toProviderInvocationEventId = (value: string) =>
  toDomainId(value, 'ProviderInvocationEventId');
export const toProviderUsageObservationId = (value: string) =>
  toDomainId(value, 'ProviderUsageObservationId');
export const toLocalResultObservationId = (value: string) =>
  toDomainId(value, 'LocalResultObservationId');
export const toUsageSchemaId = (value: string) =>
  toDomainId(value, 'UsageSchemaId');
export const toProviderExecutionRouteSnapshotId = (value: string) =>
  toDomainId(value, 'ProviderExecutionRouteSnapshotId');
export const toSubmissionIntentId = (value: string) =>
  toDomainId(value, 'SubmissionIntentId');
