import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationId, ConversationIntentPlan, ConversationWorkflowV1, DocumentOutline, MessageId, ProjectId, WorkId } from '../../domain';
import { toConversationId } from '../../domain';
import { DocumentGenerationApplicationError } from '../../application/document-generation-service';
import { mappedPresentationTarget, type PresentationRevisionMap } from '../../application/presentation-revision-map';
import { JsonExecutionRepository, JsonFileReferenceRepository, JsonTaskRepository, JsonWorkRepository } from '../repositories/json-repositories';
import { JsonConversationWorkflowRepository } from '../repositories/json-conversation-workflow-repository';
import { JsonConversationResponseExecutionRepository } from '../repositories/json-conversation-response-execution-repository';
import type { GenerateDocumentFromMessageInput } from '../../application/document-generation-service';
import { JsonProjectConversationRepository } from '../repositories/json-project-conversation-repository';
import { parseDocumentOutline } from './document-outline-parser';
import { ConversationDocumentPageError } from './conversation-document-page-context';
import { NodeProjectStorage, toProjectRelativePath } from '../storage';
import { resolveFileReferencePathSafely } from '../files/file-paths';
import { readPptxDocument, type PptxPhysicalPage } from './pptx-page-reader';

export function buildPresentationRevisionMap(pages: readonly PptxPhysicalPage[], outline: DocumentOutline, checksumSha256: string): PresentationRevisionMap {
  if (outline.kind !== 'ppt') throw scopeError();
  const headings = outline.sections.map((section) => section.heading.trim());
  if (new Set(headings).size !== headings.length) throw scopeError();
  const sections = outline.sections.map((section, sectionIndex) => {
    const matches = pages.filter((page) => page.pageNumber > 1 &&
      (page.heading === section.heading.trim() || page.heading.startsWith(`${section.heading.trim()}（续`)));
    if (!matches.length || matches.some((page, index) => index > 0 && page.pageNumber !== matches[index - 1].pageNumber + 1)) throw scopeError();
    return { sectionIndex, heading: section.heading, pages: matches.map((page) => page.pageNumber) };
  });
  if (new Set(sections.flatMap((section) => section.pages)).size !== sections.reduce((sum, section) => sum + section.pages.length, 0)) throw scopeError();
  return { checksumSha256, totalPages: pages.length, sections };
}

export class RegisteredPresentationReader {
  private readonly storage: NodeProjectStorage;
  constructor(private readonly options: { rootDirectory: string; projectId: ProjectId }) {
    this.storage = new NodeProjectStorage(options.rootDirectory);
  }

  async read(workId: WorkId, outline?: DocumentOutline) {
    try {
      const work = await new JsonWorkRepository(this.storage, this.options.projectId).get(workId);
      if (!work || work.projectId !== this.options.projectId || work.mediaKind !== 'document') throw sourceError();
      const file = await new JsonFileReferenceRepository(this.storage, this.options.projectId).get(work.fileId);
      if (!file || file.projectId !== this.options.projectId || file.sourceExecutionId !== work.sourceExecutionId ||
        file.state !== 'available' || file.locator.kind !== 'project' ||
        !file.locator.relativePath.replace(/\\/g, '/').startsWith('files/documents/') ||
        path.extname(file.locator.relativePath).toLowerCase() !== '.pptx' || !file.checksumSha256) throw sourceError();
      const absolutePath = await resolveFileReferencePathSafely(this.options.rootDirectory, file);
      const metadata = await stat(absolutePath);
      if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024) throw sourceError();
      const buffer = await readFile(absolutePath, { signal: AbortSignal.timeout(5_000) });
      const checksum = createHash('sha256').update(buffer).digest('hex');
      if (buffer.length > 20 * 1024 * 1024 || buffer.length !== file.sizeBytes || checksum !== file.checksumSha256) throw sourceError();
      const pages = await readPptxDocument(buffer);
      const map = outline ? buildPresentationRevisionMap(pages, outline, checksum) : undefined;
      if (map) {
        // A rebuildable index; never trusted without rereading and hashing the actual file.
        const key = createHash('sha256').update(work.id).digest('hex');
        await this.storage.writeJsonAtomically(toProjectRelativePath(`entities/presentation-page-maps/${key}.json`), {
          schemaVersion: 1, workId: work.id, outlineHash: createHash('sha256').update(JSON.stringify(outline)).digest('hex'),
          ...map, slides: pages.map((page) => ({ pageNumber: page.pageNumber, partName: page.partName, hidden: page.hidden }))
        }).catch(() => undefined);
      }
      return { work, file, fileName: path.basename(file.locator.relativePath), buffer, pages, map };
    } catch (error) {
      if (error instanceof DocumentGenerationApplicationError) throw error;
      throw sourceError();
    }
  }
}

function sourceError() {
  return new DocumentGenerationApplicationError('revision_scope_violation', '原 PPT 文件不可读取或已发生变化，请核对作品版本后重新发起修改。');
}
function scopeError() {
  return new DocumentGenerationApplicationError('revision_scope_violation', '无法将章节唯一对应到 PPT 的实际页面，请核对目标范围后重新发起修改。');
}

export function createPresentationWorkflowScope(options: { rootDirectory: string; projectId: ProjectId }) {
  const storage = new NodeProjectStorage(options.rootDirectory);
  const conversations = new JsonProjectConversationRepository(storage, options.projectId);
  const reader = new RegisteredPresentationReader(options);
  async function canRetryMessage(conversationId: ConversationId, messageId: MessageId): Promise<boolean> {
    const conversation = await conversations.get(conversationId);
    const status = conversation?.messages.find((item) => item.id === messageId)?.documentGenerationStatus;
    if (status?.state === 'interrupted') return true;
    if (status?.state !== 'failed') return false;
    if (['write_failed', 'storage_error', 'registration_failed', 'result_sync_pending'].includes(status.errorCode)) return true;
    if (status.errorCode !== 'generation_failed') return false;
    const tasks = (await new JsonTaskRepository(storage, options.projectId).list(options.projectId))
      .filter((task) => task.sourceDraftId === `message-${messageId}`);
    const executions = (await Promise.all(tasks.map((task) => new JsonExecutionRepository(storage).list(task.id))))
      .flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return executions[0]?.failure?.retryability === 'retryable';
  }
  return {
    canRetryMessage,
    async validatePresentationSelection(input: GenerateDocumentFromMessageInput, map: PresentationRevisionMap, target: { unit: 'page' | 'section'; ordinal: number }) {
      const executions = await new JsonConversationResponseExecutionRepository(storage, options.projectId).list(input.conversationId);
      const execution = executions.find((item) => item.snapshot.assistantMessageId === input.messageId);
      const workflows = await new JsonConversationWorkflowRepository(storage, options.projectId).list(input.conversationId);
      const workflow = workflows.find((item) => item.plan.action === 'revise' &&
        (item.deliveries?.some((delivery) => delivery.resultMessageId === input.messageId) || (execution && item.executionId === execution.id)));
      const selected = workflow?.resolvedTarget?.presentation;
      const actual = (() => { try { return mappedPresentationTarget(map, target); } catch { throw scopeError(); } })();
      if (!selected || selected.workId !== input.parentWorkId || selected.checksumSha256 !== map.checksumSha256 ||
        selected.unit !== target.unit || selected.ordinal !== target.ordinal || selected.heading !== actual.sectionHeading ||
        JSON.stringify(selected.pages) !== JSON.stringify(actual.pages)) throw scopeError();
    },
    async resolve(conversationId: ConversationId, artifactRef: string, plan: ConversationIntentPlan) {
      if (plan.kind !== 'document' || plan.action !== 'revise' || !plan.targetHint?.ordinal ||
        !['page', 'section'].includes(plan.targetHint.unit)) return undefined;
      const conversation = await conversations.get(toConversationId(conversationId));
      const message = conversation?.messages.find((item) => item.id === artifactRef && item.role === 'assistant' && item.state === 'completed');
      const result = message?.documentResult;
      if (result?.kind !== 'ppt') return undefined;
      try {
        if (!result.validatedContent) throw scopeError();
        const { map } = await reader.read(result.workId, parseDocumentOutline(result.validatedContent));
        const target = { unit: plan.targetHint.unit as 'page' | 'section', ordinal: plan.targetHint.ordinal };
        const resolved = mappedPresentationTarget(map!, target);
        return { workId: result.workId, checksumSha256: map!.checksumSha256, ...target,
          heading: resolved.sectionHeading, pages: resolved.pages };
      } catch {
        throw new ConversationDocumentPageError('document_page_ambiguous', '无法确认目标与实际 PPT 页面的对应关系，请核对文件版本、页码或章节。');
      }
    },
    async canRetry(workflow: ConversationWorkflowV1): Promise<boolean> {
      const delivery = workflow.deliveries?.find((item) => item.status === 'failed' && item.kind === workflow.plan.documentKind);
      if (!delivery?.resultMessageId) return delivery?.failureReason === 'execution_failed';
      return canRetryMessage(workflow.conversationId, delivery.resultMessageId as MessageId);
    }
  };
}
