import {
  createDocumentDraft,
  documentWorkspaceKinds,
  toIsoTimestamp,
  type ConversationId,
  type DocumentDraft,
  type DocumentDraftId,
  type DocumentDraftRepository,
  type DocumentDraftSource,
  type DocumentWorkspaceKind,
  type MessageId,
  type ProjectId
} from '../domain';

export interface DocumentDraftIdFactory {
  nextDocumentDraftId(): DocumentDraftId;
}

export interface RegisterFromMessageInput {
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly messageContent: string;
  readonly source?: DocumentDraftSource;
  readonly supersedes?: DocumentDraftId;
}

export interface DraftPayloadShape {
  readonly format: DocumentWorkspaceKind;
  readonly summary: string;
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly rawJson: string;
}

export class DocumentDraftRegistryService {
  constructor(
    private readonly repository: DocumentDraftRepository,
    private readonly ids: DocumentDraftIdFactory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async registerFromMessage(
    input: RegisterFromMessageInput
  ): Promise<DocumentDraft | undefined> {
    const payload = extractDraftPayload(input.messageContent);
    if (!payload) return undefined;
    const existing = await this.findExisting(input.projectId, input.messageId);
    if (existing) return existing;
    const draft = createDocumentDraft({
      id: this.ids.nextDocumentDraftId(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      source: input.source ?? 'assistant_json',
      format: payload.format,
      summary: payload.summary,
      rawJson: payload.rawJson,
      ...(payload.rowCount !== undefined
        ? { rowCount: payload.rowCount }
        : {}),
      ...(payload.columnCount !== undefined
        ? { columnCount: payload.columnCount }
        : {}),
      ...(input.supersedes !== undefined
        ? { supersedes: input.supersedes }
        : {}),
      createdAt: toIsoTimestamp(this.now())
    });
    await this.repository.save(draft);
    return draft;
  }

  async list(projectId: ProjectId): Promise<readonly DocumentDraft[]> {
    return this.repository.list(projectId);
  }

  async get(id: DocumentDraftId): Promise<DocumentDraft | undefined> {
    return this.repository.get(id);
  }

  async listByConversation(
    projectId: ProjectId,
    conversationId: ConversationId
  ): Promise<readonly DocumentDraft[]> {
    const all = await this.repository.list(projectId);
    return all.filter((draft) => draft.conversationId === conversationId);
  }

  private async findExisting(
    projectId: ProjectId,
    messageId: MessageId
  ): Promise<DocumentDraft | undefined> {
    const all = await this.repository.list(projectId);
    return all.find((draft) => draft.messageId === messageId);
  }
}

export function extractDraftPayload(
  rawText: string
): DraftPayloadShape | undefined {
  const text = stripCodeFences(rawText.trim());
  if (!text) return undefined;
  const parsed = tryParseJson(text);
  if (parsed === undefined) return undefined;
  const shape = classifyPayload(parsed);
  if (!shape) return undefined;
  return {
    ...shape,
    rawJson: text
  };
}

function stripCodeFences(text: string): string {
  const fence = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n```\s*$/;
  const match = text.match(fence);
  if (match) return match[1].trim();
  const firstBrace = text.search(/[{[]/);
  if (firstBrace <= 0) return text;
  return text.slice(firstBrace).trim();
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function classifyPayload(
  parsed: unknown
): Omit<DraftPayloadShape, 'rawJson'> | undefined {
  if (Array.isArray(parsed)) return classifyObjectArray(parsed);
  if (!isRecord(parsed)) return undefined;
  const outlineHit = classifyOutlineLike(parsed);
  if (outlineHit) return outlineHit;
  const tableHit = classifyTableLike(parsed);
  if (tableHit) return tableHit;
  return undefined;
}

function classifyObjectArray(
  items: readonly unknown[]
): Omit<DraftPayloadShape, 'rawJson'> | undefined {
  if (items.length === 0) return undefined;
  const first = items[0];
  if (!isRecord(first)) return undefined;
  const keys = Object.keys(first);
  if (keys.length === 0) return undefined;
  const allObjects = items.every((entry) => isRecord(entry));
  if (!allObjects) return undefined;
  return {
    format: 'excel',
    summary: buildSummary('数据表', items.length, keys.length),
    rowCount: items.length,
    columnCount: keys.length
  };
}

function classifyOutlineLike(
  value: Record<string, unknown>
): Omit<DraftPayloadShape, 'rawJson'> | undefined {
  const kind = value.kind;
  if (
    typeof kind === 'string' &&
    (documentWorkspaceKinds as readonly string[]).includes(kind)
  ) {
    const format = kind as DocumentWorkspaceKind;
    const title = typeof value.title === 'string' ? value.title : '文档草稿';
    const { rowCount, columnCount } = countOutlineTables(value);
    const summary =
      rowCount !== undefined && columnCount !== undefined
        ? buildSummary(title, rowCount, columnCount)
        : title;
    return {
      format,
      summary,
      ...(rowCount !== undefined ? { rowCount } : {}),
      ...(columnCount !== undefined ? { columnCount } : {})
    };
  }
  return undefined;
}

function classifyTableLike(
  value: Record<string, unknown>
): Omit<DraftPayloadShape, 'rawJson'> | undefined {
  const rows = value.rows;
  const columns = value.columns ?? value.header ?? value.headers;
  if (!Array.isArray(rows) || !Array.isArray(columns)) return undefined;
  const rowCount = rows.length;
  const columnCount = columns.length;
  const title = typeof value.title === 'string' ? value.title : '数据表';
  return {
    format: 'excel',
    summary: buildSummary(title, rowCount, columnCount),
    rowCount,
    columnCount
  };
}

function countOutlineTables(value: Record<string, unknown>): {
  rowCount?: number;
  columnCount?: number;
} {
  const sections = value.sections;
  if (!Array.isArray(sections)) return {};
  let rows = 0;
  let cols = 0;
  for (const section of sections) {
    if (!isRecord(section) || !Array.isArray(section.blocks)) continue;
    for (const block of section.blocks) {
      if (!isRecord(block) || block.type !== 'table') continue;
      const blockRows = Array.isArray(block.rows) ? block.rows.length : 0;
      const blockCols = Array.isArray(block.header)
        ? block.header.length
        : Array.isArray(block.columns)
          ? block.columns.length
          : 0;
      rows += blockRows;
      cols = Math.max(cols, blockCols);
    }
  }
  if (rows === 0 && cols === 0) return {};
  return {
    ...(rows > 0 ? { rowCount: rows } : {}),
    ...(cols > 0 ? { columnCount: cols } : {})
  };
}

function buildSummary(
  label: string,
  rows: number,
  cols: number
): string {
  return `${label} · ${rows} 行 · ${cols} 列`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
