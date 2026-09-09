import { createHash } from 'node:crypto';
import { toDocumentGenerationApplicationInput, type GenerateDocumentFromMessageInput } from '../../application/document-generation-service';
import type { ProjectId } from '../../domain';
import { documentGenerationRequestParsers } from '../../shared/document-generation-ipc';
import { toProjectRelativePath, type ProjectStorageAdapter } from '../storage';

/** Preserve the exact local render inputs so retries never regenerate paid illustrations. */
export class ConversationDocumentInputStore {
  constructor(private readonly storage: ProjectStorageAdapter, private readonly projectId: ProjectId) {}

  async resolve(input: GenerateDocumentFromMessageInput, reuse: boolean): Promise<GenerateDocumentFromMessageInput> {
    const key = createHash('sha256').update(`${input.conversationId}:${input.messageId}`).digest('hex');
    const relativePath = toProjectRelativePath(`entities/conversation-document-inputs/${key}.json`);
    let resolved = input;
    await this.storage.mutateJsonAtomically(relativePath, (current) => {
      if (reuse && current === undefined) {
        throw new Error('原文档生成参数已缺失，无法安全恢复模板、父作品和配图；请核对原作品后重新发起任务。');
      }
      if (reuse && current !== undefined) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new TypeError('Saved document generation input is invalid');
        const record = current as Record<string, unknown>;
        if (record.schemaVersion !== 1 || record.projectId !== this.projectId) throw new TypeError('Saved document generation input belongs to another project');
        const saved = documentGenerationRequestParsers.generateFromMessage(record.input);
        if (saved.conversationId !== input.conversationId || saved.messageId !== input.messageId || saved.kind !== input.kind) {
          throw new TypeError('Saved document generation input does not match this message');
        }
        resolved = toDocumentGenerationApplicationInput({ ...saved, expectedRevision: input.expectedRevision, images: saved.images ?? [] });
        return current;
      }
      const saved = documentGenerationRequestParsers.generateFromMessage(input);
      return { schemaVersion: 1, projectId: this.projectId, input: saved };
    });
    return resolved;
  }
}
