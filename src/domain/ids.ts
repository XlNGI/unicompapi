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
