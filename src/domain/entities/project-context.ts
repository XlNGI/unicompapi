import { InvariantViolationError } from '../errors';
import {
  toConversationId,
  toDraftId,
  toMessageId,
  toProjectContextDraftId,
  toProjectContextFragmentId,
  toProjectContextId,
  toProjectId,
  type ConversationId,
  type DraftId,
  type MessageId,
  type ProjectContextDraftId,
  type ProjectContextFragmentId,
  type ProjectContextId,
  type ProjectId
} from '../ids';
import {
  assertTimestampNotBefore,
  toIsoTimestamp,
  type IsoTimestamp
} from '../timestamps';
import type { MessageRole } from './conversation';

export const projectContextSourceKinds = [
  'conversation_selection',
  'user_note',
  'image_analysis',
  'imported_content'
] as const;
export type ProjectContextSourceKind =
  (typeof projectContextSourceKinds)[number];

export const projectContextSourceStatuses = [
  'available',
  'source_deleted',
  'source_unavailable'
] as const;
export type ProjectContextSourceStatus =
  (typeof projectContextSourceStatuses)[number];

export const projectContextStatuses = ['active', 'deleted'] as const;
export type ProjectContextStatus = (typeof projectContextStatuses)[number];

export interface ProjectContextSelectionRangeV1 {
  readonly schemaVersion: 1;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface ProjectContextMessageFragmentV1 {
  readonly schemaVersion: 1;
  readonly id: ProjectContextFragmentId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly messageRevision: number;
  readonly messageRole: MessageRole;
  readonly selectionOrder: number;
  readonly selection: ProjectContextSelectionRangeV1;
  readonly contentSnapshot: string;
}

export interface ConversationSelectionProjectContextDraftV1 {
  readonly schemaVersion: 1;
  readonly id: ProjectContextDraftId;
  readonly revision: number;
  readonly projectId: ProjectId;
  readonly sourceKindSchemaVersion: 1;
  readonly sourceKind: 'conversation_selection';
  readonly conversationId: ConversationId;
  readonly labels: readonly string[];
  readonly fragments: readonly ProjectContextMessageFragmentV1[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ImageAnalysisProjectContextDraftV1 {
  readonly schemaVersion: 1;
  readonly id: ProjectContextDraftId;
  readonly revision: number;
  readonly projectId: ProjectId;
  readonly sourceKindSchemaVersion: 1;
  readonly sourceKind: 'image_analysis';
  readonly sourceImageDraftId: DraftId;
  readonly sourceImageResultRevision: number;
  readonly labels: readonly string[];
  readonly contentSnapshot: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type ProjectContextDraftV1 =
  | ConversationSelectionProjectContextDraftV1
  | ImageAnalysisProjectContextDraftV1;

interface ProjectContextVersionBaseV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: ProjectContextStatus;
  readonly sourceKindSchemaVersion: 1;
  readonly sourceStatus: ProjectContextSourceStatus;
  readonly labels: readonly string[];
  readonly contentSnapshot: string;
  readonly registeredAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

interface ConversationSelectionProjectContextSourceV1 {
  readonly sourceKind: 'conversation_selection';
  readonly sourceConversationId: ConversationId;
  readonly sourceFragments: readonly ProjectContextMessageFragmentV1[];
}

interface ImageAnalysisProjectContextSourceV1 {
  readonly sourceKind: 'image_analysis';
  readonly sourceImageDraftId: DraftId;
  readonly sourceImageResultRevision: number;
}

type ProjectContextVersionSourceV1 =
  | ConversationSelectionProjectContextSourceV1
  | ImageAnalysisProjectContextSourceV1;

export type ActiveProjectContextVersionV1 =
  ProjectContextVersionBaseV1 &
  ProjectContextVersionSourceV1 & { readonly status: 'active' };

export type DeletedProjectContextVersionV1 =
  ProjectContextVersionBaseV1 &
  ProjectContextVersionSourceV1 & {
    readonly status: 'deleted';
    readonly deletedAt: IsoTimestamp;
  };

export type ProjectContextVersionV1 =
  | ActiveProjectContextVersionV1
  | DeletedProjectContextVersionV1;

export interface ProjectContextV1 {
  readonly schemaVersion: 1;
  readonly id: ProjectContextId;
  readonly projectId: ProjectId;
  readonly currentRevision: number;
  readonly status: ProjectContextStatus;
  readonly versions: readonly ProjectContextVersionV1[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface CreateProjectContextDraftInput {
  readonly id: ProjectContextDraftId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly createdAt: IsoTimestamp;
}

export interface CreateProjectContextFragmentInput {
  readonly id: ProjectContextFragmentId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly messageRevision: number;
  readonly messageRole: MessageRole;
  readonly selection: ProjectContextSelectionRangeV1;
  readonly contentSnapshot: string;
}

const draftBaseKeys = [
  'schemaVersion',
  'id',
  'revision',
  'projectId',
  'sourceKindSchemaVersion',
  'sourceKind',
  'labels',
  'createdAt',
  'updatedAt'
] as const;

const conversationDraftKeys = [
  ...draftBaseKeys,
  'conversationId',
  'fragments'
] as const;

const imageAnalysisDraftKeys = [
  ...draftBaseKeys,
  'sourceImageDraftId',
  'sourceImageResultRevision',
  'contentSnapshot'
] as const;

const contextKeys = [
  'schemaVersion',
  'id',
  'projectId',
  'currentRevision',
  'status',
  'versions',
  'createdAt',
  'updatedAt'
] as const;

const versionBaseKeys = [
  'schemaVersion',
  'revision',
  'status',
  'sourceKindSchemaVersion',
  'sourceKind',
  'sourceStatus',
  'labels',
  'contentSnapshot',
  'registeredAt',
  'createdAt'
] as const;

const conversationVersionKeys = [
  ...versionBaseKeys,
  'sourceConversationId',
  'sourceFragments'
] as const;

const imageAnalysisVersionKeys = [
  ...versionBaseKeys,
  'sourceImageDraftId',
  'sourceImageResultRevision'
] as const;

export function createProjectContextDraft(
  input: CreateProjectContextDraftInput
): ConversationSelectionProjectContextDraftV1 {
  return parseProjectContextDraft({
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    projectId: input.projectId,
    sourceKindSchemaVersion: 1,
    sourceKind: 'conversation_selection',
    conversationId: input.conversationId,
    labels: [],
    fragments: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  }) as ConversationSelectionProjectContextDraftV1;
}

export function createImageAnalysisProjectContextDraft(input: {
  readonly id: ProjectContextDraftId;
  readonly projectId: ProjectId;
  readonly sourceImageDraftId: DraftId;
  readonly sourceImageResultRevision: number;
  readonly contentSnapshot: string;
  readonly labels?: readonly string[];
  readonly createdAt: IsoTimestamp;
}): ImageAnalysisProjectContextDraftV1 {
  return parseProjectContextDraft({
    schemaVersion: 1,
    id: input.id,
    revision: 0,
    projectId: input.projectId,
    sourceKindSchemaVersion: 1,
    sourceKind: 'image_analysis',
    sourceImageDraftId: input.sourceImageDraftId,
    sourceImageResultRevision: input.sourceImageResultRevision,
    labels: input.labels ?? [],
    contentSnapshot: input.contentSnapshot,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  }) as ImageAnalysisProjectContextDraftV1;
}

export function addProjectContextDraftFragment(
  draft: ConversationSelectionProjectContextDraftV1,
  input: CreateProjectContextFragmentInput,
  updatedAt: IsoTimestamp
): ConversationSelectionProjectContextDraftV1 {
  if (input.conversationId !== draft.conversationId) {
    throw new InvariantViolationError(
      'project context draft cannot contain multiple conversations'
    );
  }
  if (draft.fragments.some((fragment) => fragment.id === input.id)) {
    throw new InvariantViolationError(`project context fragment ${input.id} already exists`);
  }
  const fragment = parseProjectContextFragment({
    schemaVersion: 1,
    ...input,
    selectionOrder: draft.fragments.length
  });
  return parseProjectContextDraft({
    ...draft,
    revision: draft.revision + 1,
    fragments: [...draft.fragments, fragment],
    updatedAt
  }) as ConversationSelectionProjectContextDraftV1;
}

export function removeProjectContextDraftFragment(
  draft: ConversationSelectionProjectContextDraftV1,
  fragmentId: ProjectContextFragmentId,
  updatedAt: IsoTimestamp
): ConversationSelectionProjectContextDraftV1 {
  if (!draft.fragments.some((fragment) => fragment.id === fragmentId)) {
    throw new InvariantViolationError(`project context fragment ${fragmentId} does not exist`);
  }
  const fragments = draft.fragments
    .filter((fragment) => fragment.id !== fragmentId)
    .map((fragment, selectionOrder) => ({ ...fragment, selectionOrder }));
  return parseProjectContextDraft({
    ...draft,
    revision: draft.revision + 1,
    fragments,
    updatedAt
  }) as ConversationSelectionProjectContextDraftV1;
}

export function replaceProjectContextDraftLabels<TDraft extends ProjectContextDraftV1>(
  draft: TDraft,
  labels: readonly string[],
  updatedAt: IsoTimestamp
): TDraft {
  return parseProjectContextDraft({
    ...draft,
    revision: draft.revision + 1,
    labels,
    updatedAt
  }) as TDraft;
}

export function registerProjectContextDraft(
  draft: ProjectContextDraftV1,
  contextId: ProjectContextId,
  registeredAt: IsoTimestamp
): ProjectContextV1 {
  if (draft.sourceKind === 'conversation_selection' && draft.fragments.length === 0) {
    throw new InvariantViolationError(
      'project context draft must contain at least one message fragment'
    );
  }
  const contentSnapshot = draft.sourceKind === 'conversation_selection'
    ? createProjectContextContentSnapshot(draft.fragments)
    : draft.contentSnapshot;
  const source: ProjectContextVersionSourceV1 =
    draft.sourceKind === 'conversation_selection'
      ? {
          sourceKind: draft.sourceKind,
          sourceConversationId: draft.conversationId,
          sourceFragments: draft.fragments
        }
      : {
          sourceKind: draft.sourceKind,
          sourceImageDraftId: draft.sourceImageDraftId,
          sourceImageResultRevision: draft.sourceImageResultRevision
        };
  const version: ActiveProjectContextVersionV1 = {
    schemaVersion: 1,
    revision: 1,
    status: 'active',
    sourceKindSchemaVersion: 1,
    sourceStatus: 'available',
    ...source,
    labels: draft.labels,
    contentSnapshot,
    registeredAt,
    createdAt: registeredAt
  };
  return parseProjectContext({
    schemaVersion: 1,
    id: contextId,
    projectId: draft.projectId,
    currentRevision: 1,
    status: 'active',
    versions: [version],
    createdAt: registeredAt,
    updatedAt: registeredAt
  });
}

export function updateProjectContextContent(
  context: ProjectContextV1,
  contentSnapshot: string,
  labels: readonly string[],
  updatedAt: IsoTimestamp
): ProjectContextV1 {
  const current = requireActiveCurrentVersion(context);
  return appendProjectContextVersion(context, {
    ...current,
    revision: context.currentRevision + 1,
    contentSnapshot: normalizeProjectContextSelection(contentSnapshot),
    labels: parseProjectContextLabels(labels),
    createdAt: updatedAt
  }, updatedAt);
}

export function updateProjectContextSourceStatus(
  context: ProjectContextV1,
  sourceStatus: ProjectContextSourceStatus,
  updatedAt: IsoTimestamp
): ProjectContextV1 {
  const current = requireActiveCurrentVersion(context);
  if (current.sourceStatus === sourceStatus) return context;
  return appendProjectContextVersion(context, {
    ...current,
    revision: context.currentRevision + 1,
    sourceStatus,
    createdAt: updatedAt
  }, updatedAt);
}

export function deleteProjectContext(
  context: ProjectContextV1,
  deletedAt: IsoTimestamp
): ProjectContextV1 {
  const current = requireActiveCurrentVersion(context);
  return appendProjectContextVersion(context, {
    ...current,
    revision: context.currentRevision + 1,
    status: 'deleted',
    deletedAt,
    createdAt: deletedAt
  }, deletedAt);
}

export function getCurrentProjectContextVersion(
  context: ProjectContextV1
): ProjectContextVersionV1 {
  const current = context.versions.find(
    (version) => version.revision === context.currentRevision
  );
  if (!current) {
    throw new InvariantViolationError('project context current revision is missing');
  }
  return current;
}

export function getProjectContextRevision(
  context: ProjectContextV1,
  revision: number
): ProjectContextVersionV1 | undefined {
  return context.versions.find((version) => version.revision === revision);
}

export function createProjectContextContentSnapshot(
  fragments: readonly ProjectContextMessageFragmentV1[]
): string {
  if (fragments.length === 0) {
    throw new InvariantViolationError('project context content requires a fragment');
  }
  return fragments
    .slice()
    .sort((left, right) => left.selectionOrder - right.selectionOrder)
    .map((fragment) => fragment.contentSnapshot)
    .join('\n\n');
}

export function normalizeProjectContextSelection(value: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (normalized.length === 0) {
    throw new InvariantViolationError('project context selection cannot be empty');
  }
  if (normalized.length > 1_000_000) {
    throw new InvariantViolationError('project context selection is too large');
  }
  return normalized;
}

export function parseProjectContextDraft(value: unknown): ProjectContextDraftV1 {
  const initial = record(value, 'project context draft');
  const sourceKind = oneOf(
    initial.sourceKind,
    ['conversation_selection', 'image_analysis'] as const,
    'draft.sourceKind'
  );
  const item = exactRecord(
    value,
    sourceKind === 'conversation_selection'
      ? conversationDraftKeys
      : imageAnalysisDraftKeys,
    'project context draft'
  );
  requireVersionOne(item.schemaVersion, 'draft.schemaVersion');
  requireVersionOne(
    item.sourceKindSchemaVersion,
    'draft.sourceKindSchemaVersion'
  );
  const id = toProjectContextDraftId(nonBlank(item.id, 'draft.id'));
  const revision = nonNegativeInteger(item.revision, 'draft.revision');
  const projectId = toProjectId(nonBlank(item.projectId, 'draft.projectId'));
  const labels = parseProjectContextLabels(item.labels);
  const createdAt = toIsoTimestamp(string(item.createdAt, 'draft.createdAt'));
  const updatedAt = toIsoTimestamp(string(item.updatedAt, 'draft.updatedAt'));
  assertTimestampNotBefore(updatedAt, createdAt, 'draft.updatedAt');

  if (sourceKind === 'image_analysis') {
    return {
      schemaVersion: 1,
      id,
      revision,
      projectId,
      sourceKindSchemaVersion: 1,
      sourceKind,
      sourceImageDraftId: toDraftId(
        nonBlank(item.sourceImageDraftId, 'draft.sourceImageDraftId')
      ),
      sourceImageResultRevision: positiveInteger(
        item.sourceImageResultRevision,
        'draft.sourceImageResultRevision'
      ),
      labels,
      contentSnapshot: normalizeProjectContextSelection(
        string(item.contentSnapshot, 'draft.contentSnapshot')
      ),
      createdAt,
      updatedAt
    };
  }
  const conversationId = toConversationId(
    nonBlank(item.conversationId, 'draft.conversationId')
  );
  if (!Array.isArray(item.fragments)) {
    throw new TypeError('draft.fragments must be an array');
  }
  const fragmentIds = new Set<string>();
  const orders = new Set<number>();
  const fragments = item.fragments.map((value) => {
    const fragment = parseProjectContextFragment(value);
    if (fragment.conversationId !== conversationId) {
      throw new TypeError('draft cannot contain fragments from another conversation');
    }
    if (fragmentIds.has(fragment.id) || orders.has(fragment.selectionOrder)) {
      throw new TypeError('draft fragment identifiers and orders must be unique');
    }
    fragmentIds.add(fragment.id);
    orders.add(fragment.selectionOrder);
    return fragment;
  });
  fragments.forEach((fragment, index) => {
    if (fragment.selectionOrder !== index) {
      throw new TypeError('draft fragment orders must be contiguous');
    }
  });
  return {
    schemaVersion: 1,
    id,
    revision,
    projectId,
    sourceKindSchemaVersion: 1,
    sourceKind: 'conversation_selection',
    conversationId,
    labels,
    fragments,
    createdAt,
    updatedAt
  };
}

export function parseProjectContext(value: unknown): ProjectContextV1 {
  const record = exactRecord(value, contextKeys, 'project context');
  requireVersionOne(record.schemaVersion, 'context.schemaVersion');
  const id = toProjectContextId(nonBlank(record.id, 'context.id'));
  const projectId = toProjectId(nonBlank(record.projectId, 'context.projectId'));
  const currentRevision = positiveInteger(
    record.currentRevision,
    'context.currentRevision'
  );
  const status = oneOf(
    record.status,
    projectContextStatuses,
    'context.status'
  );
  if (!Array.isArray(record.versions) || record.versions.length === 0) {
    throw new TypeError('context.versions must contain at least one version');
  }
  const versions = record.versions.map(parseProjectContextVersion);
  versions.forEach((version, index) => {
    if (version.revision !== index + 1) {
      throw new TypeError('context revisions must be contiguous and start at 1');
    }
  });
  const current = versions.at(-1);
  if (!current || currentRevision !== current.revision || status !== current.status) {
    throw new TypeError('context current revision or status is inconsistent');
  }
  const registeredAt = versions[0].registeredAt;
  if (versions.some((version) => version.registeredAt !== registeredAt)) {
    throw new TypeError('context registeredAt must remain immutable');
  }
  const sourceIdentity = projectContextSourceIdentity(versions[0]);
  if (versions.some((version) =>
    version.sourceKindSchemaVersion !== 1 ||
    projectContextSourceIdentity(version) !== sourceIdentity
  )) {
    throw new TypeError('context source identity must remain immutable');
  }
  versions.forEach((version, index) => {
    if (version.status !== 'deleted') return;
    const previous = versions[index - 1];
    if (
      !previous ||
      version.contentSnapshot !== previous.contentSnapshot ||
      JSON.stringify(version.labels) !== JSON.stringify(previous.labels) ||
      version.sourceStatus !== previous.sourceStatus
    ) {
      throw new TypeError('deleted context revision must be a pure tombstone');
    }
  });
  const createdAt = toIsoTimestamp(string(record.createdAt, 'context.createdAt'));
  const updatedAt = toIsoTimestamp(string(record.updatedAt, 'context.updatedAt'));
  assertTimestampNotBefore(updatedAt, createdAt, 'context.updatedAt');
  if (createdAt !== registeredAt || current.createdAt !== updatedAt) {
    throw new TypeError('context timestamps are inconsistent with revision history');
  }
  return {
    schemaVersion: 1,
    id,
    projectId,
    currentRevision,
    status,
    versions,
    createdAt,
    updatedAt
  };
}

export function parseProjectContextVersion(
  value: unknown
): ProjectContextVersionV1 {
  const initial = record(value, 'project context version');
  const status = oneOf(
    initial.status,
    projectContextStatuses,
    'context version status'
  );
  const sourceKind = oneOf(
    initial.sourceKind,
    ['conversation_selection', 'image_analysis'] as const,
    'context version sourceKind'
  );
  const sourceKeys = sourceKind === 'conversation_selection'
    ? conversationVersionKeys
    : imageAnalysisVersionKeys;
  const item = exactRecord(
    value,
    status === 'deleted'
      ? [...sourceKeys, 'deletedAt']
      : sourceKeys,
    'project context version'
  );
  requireVersionOne(item.schemaVersion, 'context version schemaVersion');
  requireVersionOne(
    item.sourceKindSchemaVersion,
    'context version sourceKindSchemaVersion'
  );
  const revision = positiveInteger(item.revision, 'context version revision');
  const sourceStatus = oneOf(
    item.sourceStatus,
    projectContextSourceStatuses,
    'context version sourceStatus'
  );
  const labels = parseProjectContextLabels(item.labels);
  const contentSnapshot = normalizeProjectContextSelection(
    string(item.contentSnapshot, 'context version contentSnapshot')
  );
  const registeredAt = toIsoTimestamp(
    string(item.registeredAt, 'context version registeredAt')
  );
  const createdAt = toIsoTimestamp(
    string(item.createdAt, 'context version createdAt')
  );
  assertTimestampNotBefore(createdAt, registeredAt, 'context version createdAt');
  const source: ProjectContextVersionSourceV1 =
    sourceKind === 'conversation_selection'
      ? parseConversationVersionSource(item)
      : {
          sourceKind,
          sourceImageDraftId: toDraftId(
            nonBlank(
              item.sourceImageDraftId,
              'context version sourceImageDraftId'
            )
          ),
          sourceImageResultRevision: positiveInteger(
            item.sourceImageResultRevision,
            'context version sourceImageResultRevision'
          )
        };
  const base: ProjectContextVersionBaseV1 & ProjectContextVersionSourceV1 = {
    schemaVersion: 1 as const,
    revision,
    status,
    sourceKindSchemaVersion: 1 as const,
    sourceStatus,
    ...source,
    labels,
    contentSnapshot,
    registeredAt,
    createdAt
  };
  if (status === 'active') {
    return { ...base, status } as ActiveProjectContextVersionV1;
  }
  const deletedAt = toIsoTimestamp(
    string(item.deletedAt, 'context version deletedAt')
  );
  if (deletedAt !== createdAt) {
    throw new TypeError('deleted context version timestamps are inconsistent');
  }
  return { ...base, status, deletedAt } as DeletedProjectContextVersionV1;
}

export function parseProjectContextFragment(
  value: unknown
): ProjectContextMessageFragmentV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'id',
    'conversationId',
    'messageId',
    'messageRevision',
    'messageRole',
    'selectionOrder',
    'selection',
    'contentSnapshot'
  ], 'project context fragment');
  requireVersionOne(item.schemaVersion, 'fragment.schemaVersion');
  const messageRole = oneOf(
    item.messageRole,
    ['user', 'assistant'] as const,
    'fragment.messageRole'
  );
  return {
    schemaVersion: 1,
    id: toProjectContextFragmentId(nonBlank(item.id, 'fragment.id')),
    conversationId: toConversationId(
      nonBlank(item.conversationId, 'fragment.conversationId')
    ),
    messageId: toMessageId(nonBlank(item.messageId, 'fragment.messageId')),
    messageRevision: nonNegativeInteger(
      item.messageRevision,
      'fragment.messageRevision'
    ),
    messageRole,
    selectionOrder: nonNegativeInteger(
      item.selectionOrder,
      'fragment.selectionOrder'
    ),
    selection: parseSelectionRange(item.selection),
    contentSnapshot: normalizeProjectContextSelection(
      string(item.contentSnapshot, 'fragment.contentSnapshot')
    )
  };
}

function parseConversationVersionSource(
  item: Record<string, unknown>
): ConversationSelectionProjectContextSourceV1 {
  const sourceConversationId = toConversationId(
    nonBlank(item.sourceConversationId, 'context version sourceConversationId')
  );
  if (!Array.isArray(item.sourceFragments) || item.sourceFragments.length === 0) {
    throw new TypeError('context version sourceFragments cannot be empty');
  }
  const sourceFragments = item.sourceFragments.map(parseProjectContextFragment);
  sourceFragments.forEach((fragment, index) => {
    if (
      fragment.conversationId !== sourceConversationId ||
      fragment.selectionOrder !== index
    ) {
      throw new TypeError('context version source fragments are inconsistent');
    }
  });
  return {
    sourceKind: 'conversation_selection',
    sourceConversationId,
    sourceFragments
  };
}

function projectContextSourceIdentity(version: ProjectContextVersionV1): string {
  return version.sourceKind === 'conversation_selection'
    ? JSON.stringify({
        sourceKind: version.sourceKind,
        sourceConversationId: version.sourceConversationId,
        sourceFragments: version.sourceFragments
      })
    : JSON.stringify({
        sourceKind: version.sourceKind,
        sourceImageDraftId: version.sourceImageDraftId,
        sourceImageResultRevision: version.sourceImageResultRevision
      });
}

export function parseProjectContextLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError('project context labels must be an array of at most 20 items');
  }
  const keys = new Set<string>();
  return value.map((item) => {
    const label = nonBlank(item, 'project context label').normalize('NFC');
    if (label.length > 40) {
      throw new TypeError('project context label exceeds the maximum length');
    }
    const key = label.toLocaleLowerCase('en-US');
    if (keys.has(key)) {
      throw new TypeError('project context labels must be unique');
    }
    keys.add(key);
    return label;
  });
}

function appendProjectContextVersion(
  context: ProjectContextV1,
  version: ProjectContextVersionV1,
  updatedAt: IsoTimestamp
): ProjectContextV1 {
  return parseProjectContext({
    ...context,
    currentRevision: version.revision,
    status: version.status,
    versions: [...context.versions, version],
    updatedAt
  });
}

function requireActiveCurrentVersion(
  context: ProjectContextV1
): ActiveProjectContextVersionV1 {
  const current = getCurrentProjectContextVersion(context);
  if (current.status !== 'active') {
    throw new InvariantViolationError('deleted project context cannot be modified');
  }
  return current;
}

function parseSelectionRange(value: unknown): ProjectContextSelectionRangeV1 {
  const item = exactRecord(
    value,
    ['schemaVersion', 'startUtf16', 'endUtf16'],
    'project context selection range'
  );
  requireVersionOne(item.schemaVersion, 'selection.schemaVersion');
  const startUtf16 = nonNegativeInteger(item.startUtf16, 'selection.startUtf16');
  const endUtf16 = positiveInteger(item.endUtf16, 'selection.endUtf16');
  if (endUtf16 <= startUtf16) {
    throw new TypeError('selection.endUtf16 must be after startUtf16');
  }
  return { schemaVersion: 1, startUtf16, endUtf16 };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const item = record(value, label);
  const allowed = new Set(keys);
  const actual = Object.keys(item);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unexpected or missing fields`);
  }
  return item;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
}

function nonBlank(value: unknown, field: string): string {
  const result = string(value, field).trim();
  if (result.length === 0) throw new TypeError(`${field} cannot be empty`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function requireVersionOne(value: unknown, field: string): void {
  if (value !== 1) throw new TypeError(`${field} must be 1`);
}

function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string
): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as T;
}
