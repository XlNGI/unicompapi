import { createHash } from 'node:crypto';
import type { ProjectId } from '../../domain';
import type {
  RagContextChunkDto,
  RagSourceKind
} from '../../shared/document-attachment-ipc';
import { FileExtractionService } from '../documents';
import { JsonFileReferenceRepository } from '../repositories';
import { NodeProjectStorage } from '../storage';
import { retrieveTopK, type Bm25Document } from './bm25';

export const documentRetrievalIndexVersion = 'document-bm25-v2';

export interface DocumentRetrievalSource {
  readonly sourceId: string;
  readonly sourceKind: RagSourceKind;
  readonly sourceName: string;
  readonly content: string;
  readonly fileId?: string;
  readonly page?: number;
  readonly sheet?: string;
  readonly section?: string;
}

export interface DocumentRetrievalSourceProvider {
  listSources(input: {
    readonly projectId: ProjectId;
  }): Promise<readonly DocumentRetrievalSource[]>;
}

export interface DocumentRetrievalIndexChunk {
  readonly projectId: ProjectId;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceKind: RagSourceKind;
  readonly sourceName: string;
  readonly text: string;
  readonly contentHash: string;
  readonly indexVersion: string;
  readonly fileId?: string;
  readonly page?: number;
  readonly sheet?: string;
  readonly section?: string;
}

export interface DocumentRetrievalSourceFailure {
  readonly sourceId: string;
  readonly sourceKind?: RagSourceKind;
  readonly sourceName: string;
  readonly code: 'source_unavailable' | 'extraction_failed' | 'provider_failed';
}

export interface DocumentRetrievalIndexSnapshot {
  readonly projectId: ProjectId;
  readonly indexVersion: string;
  readonly builtAt: string;
  readonly chunks: readonly DocumentRetrievalIndexChunk[];
  readonly failures: readonly DocumentRetrievalSourceFailure[];
}

export type RagChunk = RagContextChunkDto;

const chunkCharacters = 500;

export class RagRetrievalService {
  constructor(
    private readonly options: {
      readonly rootDirectory: string;
      readonly projectId: ProjectId;
      readonly sourceProviders?: readonly DocumentRetrievalSourceProvider[];
      readonly now?: () => string;
    }
  ) {}

  async retrieve(input: {
    readonly query: string;
    readonly k?: number;
  }): Promise<readonly RagChunk[]> {
    const query = input.query.trim();
    if (!query) return [];
    const k = input.k ?? 3;
    if (!Number.isSafeInteger(k) || k < 1 || k > 10) {
      throw new TypeError('k must be an integer between 1 and 10');
    }

    const snapshot = await this.buildIndexSnapshot();
    const documents: Bm25Document[] = snapshot.chunks.map((chunk) => ({
      id: chunk.chunkId,
      text: chunk.text
    }));
    const chunksById = new Map(
      snapshot.chunks.map((chunk) => [chunk.chunkId, chunk] as const)
    );
    return retrieveTopK(documents, query, k).flatMap((match, index) => {
      const chunk = chunksById.get(match.id);
      if (!chunk) return [];
      return [{
        chunkId: chunk.chunkId,
        sourceId: chunk.sourceId,
        sourceKind: chunk.sourceKind,
        source: chunk.sourceName,
        text: chunk.text,
        contentHash: chunk.contentHash,
        indexVersion: chunk.indexVersion,
        score: match.score,
        rank: index + 1,
        ...(chunk.fileId !== undefined ? { fileId: chunk.fileId } : {}),
        ...(chunk.page !== undefined ? { page: chunk.page } : {}),
        ...(chunk.sheet !== undefined ? { sheet: chunk.sheet } : {}),
        ...(chunk.section !== undefined ? { section: chunk.section } : {})
      }];
    });
  }

  async buildIndexSnapshot(): Promise<DocumentRetrievalIndexSnapshot> {
    const failures: DocumentRetrievalSourceFailure[] = [];
    const sources = [
      ...(await this.loadAttachmentSources(failures)),
      ...(await this.loadInjectedSources(failures))
    ];
    const chunks = sources.flatMap((source) =>
      chunkText(source.content, chunkCharacters).map((text, index) => {
        const contentHash = sha256(text);
        return {
          projectId: this.options.projectId,
          chunkId: `${source.sourceId}:${index}:${contentHash.slice(0, 16)}`,
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          sourceName: source.sourceName,
          text,
          contentHash,
          indexVersion: documentRetrievalIndexVersion,
          ...(source.fileId !== undefined ? { fileId: source.fileId } : {}),
          ...(source.page !== undefined ? { page: source.page } : {}),
          ...(source.sheet !== undefined ? { sheet: source.sheet } : {}),
          ...(source.section !== undefined ? { section: source.section } : {})
        } satisfies DocumentRetrievalIndexChunk;
      })
    );
    return {
      projectId: this.options.projectId,
      indexVersion: documentRetrievalIndexVersion,
      builtAt: (this.options.now ?? (() => new Date().toISOString()))(),
      chunks,
      failures
    };
  }

  private async loadAttachmentSources(
    failures: DocumentRetrievalSourceFailure[]
  ): Promise<readonly DocumentRetrievalSource[]> {
    const storage = new NodeProjectStorage(this.options.rootDirectory);
    const files = new JsonFileReferenceRepository(
      storage,
      this.options.projectId
    );
    const extraction = new FileExtractionService({
      rootDirectory: this.options.rootDirectory,
      projectId: this.options.projectId
    });
    const sources: DocumentRetrievalSource[] = [];
    const fileReferences = await files.list(this.options.projectId);
    for (const file of [...fileReferences].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    )) {
      if (
        file.locator.kind !== 'project' ||
        !file.locator.relativePath.startsWith('files/attachments/')
      ) {
        continue;
      }
      const sourceName = pathBasename(file.locator.relativePath);
      const sourceId = `attachment:${file.id}`;
      try {
        const content = await extraction.extractFullText(file.id);
        if (typeof content !== 'string' || !content.trim()) continue;
        sources.push({
          sourceId,
          sourceKind: 'project_attachment',
          sourceName,
          content,
          fileId: file.id
        });
      } catch {
        failures.push({
          sourceId,
          sourceKind: 'project_attachment',
          sourceName,
          code: file.state === 'available'
            ? 'extraction_failed'
            : 'source_unavailable'
        });
      }
    }
    return sources;
  }

  private async loadInjectedSources(
    failures: DocumentRetrievalSourceFailure[]
  ): Promise<readonly DocumentRetrievalSource[]> {
    const sources: DocumentRetrievalSource[] = [];
    for (const [index, provider] of (this.options.sourceProviders ?? []).entries()) {
      try {
        const provided = await provider.listSources({
          projectId: this.options.projectId
        });
        for (const source of provided) {
          validateSource(source);
          if (source.content.trim()) sources.push(source);
        }
      } catch {
        failures.push({
          sourceId: `provider:${index}`,
          sourceName: `provider-${index + 1}`,
          code: 'provider_failed'
        });
      }
    }
    return sources;
  }
}

function validateSource(source: DocumentRetrievalSource): void {
  if (!source.sourceId.trim() || !source.sourceName.trim()) {
    throw new TypeError('retrieval source requires an id and name');
  }
  if (!source.content.trim()) {
    throw new TypeError('retrieval source content must not be blank');
  }
  if (
    source.page !== undefined &&
    (!Number.isSafeInteger(source.page) || source.page < 1)
  ) {
    throw new TypeError('retrieval source page must be a positive integer');
  }
}

function chunkText(text: string, size: number): readonly string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const paragraph of text.split(/\r?\n+/)) {
    let remaining = paragraph.trim();
    if (!remaining) continue;
    while (remaining.length > size) {
      flush();
      chunks.push(remaining.slice(0, size));
      remaining = remaining.slice(size);
    }
    if (!remaining) continue;
    if (current.length + remaining.length + 1 > size) flush();
    current = current ? `${current}\n${remaining}` : remaining;
  }
  flush();
  return chunks;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pathBasename(value: string): string {
  return value.split('/').pop() ?? value;
}
