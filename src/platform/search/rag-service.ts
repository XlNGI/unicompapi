import type { ProjectId } from '../../domain';
import { FileExtractionService } from '../documents';
import {
  JsonFileReferenceRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import { retrieveTopK, type Bm25Document } from './bm25';

export interface RagChunk {
  readonly source: string;
  readonly text: string;
}

const CHUNK_CHARACTERS = 500;

export class RagRetrievalService {
  constructor(
    private readonly options: {
      readonly rootDirectory: string;
      readonly projectId: ProjectId;
    }
  ) {}

  async retrieve(input: {
    readonly query: string;
    readonly k?: number;
  }): Promise<readonly RagChunk[]> {
    const storage = new NodeProjectStorage(this.options.rootDirectory);
    const files = new JsonFileReferenceRepository(
      storage,
      this.options.projectId
    );
    const extraction = new FileExtractionService({
      rootDirectory: this.options.rootDirectory,
      projectId: this.options.projectId
    });
    const documents: Bm25Document[] = [];
    const sources = new Map<string, string>();
    const fileReferences = await files.list(this.options.projectId);
    for (const file of fileReferences) {
      if (
        file.locator.kind !== 'project' ||
        !file.locator.relativePath.startsWith('files/attachments/')
      ) {
        continue;
      }
      const text = await extraction.extractFullText(file.id);
      if (!text) continue;
      const source = pathBasename(file.locator.relativePath);
      chunkText(text, CHUNK_CHARACTERS).forEach((chunk, index) => {
        const id = `${file.id}:${index}`;
        documents.push({ id, text: chunk });
        sources.set(id, source);
      });
    }
    const matches = retrieveTopK(documents, input.query, input.k ?? 3);
    return matches.map((match) => ({
      source: sources.get(match.id) ?? '未知来源',
      text: documents.find((doc) => doc.id === match.id)?.text ?? ''
    }));
  }
}

function chunkText(text: string, size: number): readonly string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\r?\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (current.length + trimmed.length + 1 > size && current) {
      chunks.push(current);
      current = trimmed;
    } else {
      current = current ? `${current}\n${trimmed}` : trimmed;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function pathBasename(value: string): string {
  return value.split('/').pop() ?? value;
}
