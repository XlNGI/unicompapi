import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { NodeImageInspector } from '../files/node-image-inspector';
import { conversationImageMaxBytes, parseConversationImageInput, type ConversationImageInput } from '../providers/conversation-image-input';
import {
  toFileReferenceId,
  type Conversation,
  type ConversationAttachmentReference,
  type FileReference,
  type MessageId,
  type ProjectId
} from '../../domain';
import { estimateConversationTokens, type ConversationContextReference } from '../../application/conversation-context-builder';
import { JsonFileReferenceRepository } from '../repositories/json-repositories';
import { NodeProjectStorage } from '../storage';
import { NodeFileStatusProbe } from '../files/node-file-status-probe';
import { resolveFileReferencePathSafely } from '../files/file-paths';
import { FileExtractionService, defaultFileExtractionLimits } from './file-extraction-service';
import { ConversationControlledTextError, type ConversationSemanticClassifier } from '../providers/conversation-semantic-classifier';
import { AttachmentSummaryCacheBlockedError, ConversationAttachmentSummaryStore, summaryHash,
  type AttachmentSummaryCacheRecord, type AttachmentSummaryPart } from './conversation-attachment-summary-store';
import type { ConversationSemanticCandidate } from '../../shared/chat-context-ipc';
import { emitProductionEvent } from '../conversation-production-trace';

export type ConversationAttachmentErrorCode =
  | 'attachment_unavailable' | 'attachment_changed'
  | 'attachment_unsupported' | 'attachment_scope_exceeded';

export class ConversationAttachmentError extends Error {
  constructor(readonly code: ConversationAttachmentErrorCode, message: string) {
    super(message);
    this.name = 'ConversationAttachmentError';
  }
}

type PinnedFile = Extract<ConversationAttachmentReference, { kind: 'file_reference' }>;

/** Only the latest explicitly selected batch in this conversation is eligible. */
export function conversationAttachmentBatch(conversation: Conversation): readonly PinnedFile[] {
  const latest = [...conversation.messages].reverse().find((message) =>
    message.role === 'user' && message.state === 'completed' &&
    (message.attachmentSelection === 'replace' || message.attachments.length > 0));
  return latest?.attachments.filter((item): item is PinnedFile => item.kind === 'file_reference') ?? [];
}

export class ConversationAttachmentContextService {
  private readonly files: JsonFileReferenceRepository;
  private readonly probe: NodeFileStatusProbe;
  private readonly extraction: FileExtractionService;
  private readonly maxReferenceTokens: number;
  private readonly summaries: ConversationAttachmentSummaryStore;

  constructor(private readonly options: {
    readonly rootDirectory: string;
    readonly projectId: ProjectId;
    readonly maxReferenceTokens?: number;
    readonly summarizer?: Pick<ConversationSemanticClassifier, 'summarizeSource'>;
  }) {
    this.files = new JsonFileReferenceRepository(new NodeProjectStorage(options.rootDirectory), options.projectId);
    this.probe = new NodeFileStatusProbe(options.rootDirectory);
    this.extraction = new FileExtractionService(options);
    this.summaries = new ConversationAttachmentSummaryStore(new NodeProjectStorage(options.rootDirectory), options.projectId);
    this.maxReferenceTokens = options.maxReferenceTokens ?? 12_000;
    if (!Number.isSafeInteger(this.maxReferenceTokens) || this.maxReferenceTokens < 256 || this.maxReferenceTokens > 12_000) {
      throw new TypeError('Attachment context budget is invalid');
    }
  }

  /** Called only in the cancellable planning operation; resolve never calls a provider. */
  async prepareSummary(input: {
    readonly conversation: Conversation;
    readonly query: string;
    readonly selection?: ConversationSemanticCandidate;
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (!isSummaryRequest(input.query)) return;
    if (input.conversation.projectId !== this.options.projectId) throw new ConversationAttachmentError('attachment_unavailable', '附件不属于当前项目。');
    const batch = conversationAttachmentBatch(input.conversation);
    if (!batch.length) return;
    const texts = new Map<string, string>();
    const parts: AttachmentSummaryPart[] = [];
    let needsSummary = false;
    const budgetPerFile = Math.floor(this.maxReferenceTokens / batch.length);
    for (const attachment of batch) {
      input.signal.throwIfAborted();
      const file = await this.requireFile(attachment.fileReferenceId);
      await this.verify(file, attachment.checksumSha256);
      const fileName = attachment.fileName ?? (file.locator.kind === 'project' ? file.locator.relativePath : '');
      if (isImageAttachment(fileName)) continue;
      const text = await this.readText(file, attachment);
      texts.set(file.id, text);
      needsSummary ||= estimateConversationTokens(text) > budgetPerFile - 160;
      for (let start = 0; start < text.length; start += 8_000) {
        parts.push({ sourceId: file.id, sourceHash: attachment.checksumSha256!, start, end: Math.min(text.length, start + 8_000) });
      }
    }
    if (!needsSummary) return;
    if (parts.length > 4) throw new ConversationAttachmentError('attachment_scope_exceeded', '全文资料超过本次最多 4 段、每段 8000 字符的分析预算，请按章节拆分。');
    const key = this.summaryKey(input.conversation);
    const cached = await this.summaries.get(key);
    if (cached?.status === 'completed') {
      for (const [sourceId, text] of texts) requireCompleteSummary(cached.parts.filter((part) => part.sourceId === sourceId), text.length);
      return;
    }
    if (!input.selection || !this.options.summarizer) throw new ConversationAttachmentError('attachment_unavailable', '长资料全文摘要需要选择可用且已授权的文本模型。');
    let record: AttachmentSummaryCacheRecord;
    try {
      record = await this.summaries.acquire({ key, projectId: this.options.projectId, conversationId: input.conversation.id, status: 'running', parts });
    } catch (error) {
      if (error instanceof AttachmentSummaryCacheBlockedError) throw new ConversationAttachmentError('attachment_unavailable', '上次分段分析仍在运行或外部结果未知，未重复调用；请先核对调用记录，或指定资料章节读取。');
      throw error;
    }
    if (record.status === 'completed') return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) controller.abort();
    const timer = setTimeout(abort, 120_000);
    let inFlight = false;
    try {
      for (let index = 0; index < record.parts.length; index += 1) {
        controller.signal.throwIfAborted();
        const part = record.parts[index];
        if (part.summary !== undefined) continue;
        inFlight = true;
        const summary = await abortable(this.options.summarizer.summarizeSource({
          text: texts.get(part.sourceId)!.slice(part.start, part.end), sourceId: part.sourceId, sourceHash: part.sourceHash,
          part: index + 1, parts: record.parts.length, selection: input.selection, signal: controller.signal
        }), controller.signal);
        inFlight = false;
        controller.signal.throwIfAborted();
        record = { ...record, parts: record.parts.map((item, partIndex) => partIndex === index ? { ...item, summary, summaryHash: summaryHash(summary) } : item) };
        await this.summaries.save(record);
      }
      // Do not publish summaries of a source replaced while analysis was running.
      for (const attachment of batch) await this.verify(await this.requireFile(attachment.fileReferenceId), attachment.checksumSha256);
      await this.summaries.save({ ...record, status: 'completed' });
    } catch (error) {
      const failureOutcome = error instanceof ConversationControlledTextError ? error.outcome : inFlight ? 'unknown' : 'not_sent';
      await this.summaries.save({ ...record, status: 'failed', failureOutcome });
      if (input.signal.aborted) throw error;
      if (controller.signal.aborted) throw new ConversationAttachmentError('attachment_unavailable', '分段资料分析已达到时间上限并停止，已保留成功片段，未自动重试。');
      throw new ConversationAttachmentError('attachment_unavailable', failureOutcome === 'unknown'
        ? '分段资料分析的外部结果未知，未自动重发；请核对调用记录后继续。'
        : '分段资料分析未完成，已保留成功片段，未自动重试。');
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
    }
  }

  async pin(fileIds: readonly string[]): Promise<readonly PinnedFile[]> {
    if (fileIds.length > 8 || new Set(fileIds).size !== fileIds.length) throw new TypeError('Attachment selection is invalid');
    const pinned: PinnedFile[] = [];
    for (const fileId of fileIds) {
      const file = await this.requireFile(fileId);
      const checksumSha256 = await this.verify(file, file.checksumSha256);
      const fileName = path.basename(file.locator.kind === 'project' ? file.locator.relativePath : '').slice(0, 256);
      pinned.push({ kind: 'file_reference', projectId: this.options.projectId, fileReferenceId: file.id, checksumSha256, fileName });
    }
    return pinned;
  }

  async resolve(input: {
    readonly conversation: Conversation;
    readonly currentUserMessageId: MessageId;
    readonly query: string;
    readonly imageFileId?: string;
  }): Promise<readonly ConversationContextReference[]> {
    if (input.conversation.projectId !== this.options.projectId ||
      !input.conversation.messages.some((message) => message.id === input.currentUserMessageId && message.role === 'user')) {
      throw new ConversationAttachmentError('attachment_unavailable', '附件不属于当前项目会话。');
    }
    const attachments = conversationAttachmentBatch(input.conversation);
    if (!attachments.length) return [];
    await emitProductionEvent({ code: 'source_context', status: 'started',
      facts: { tool: 'read_sources', count: attachments.length } });
    try {
    const summaryCache = isSummaryRequest(input.query) ? await this.summaries.get(this.summaryKey(input.conversation)) : undefined;
    const references: ConversationContextReference[] = [];
    const budgetPerFile = Math.floor(this.maxReferenceTokens / attachments.length);
    for (const attachment of attachments) {
      if (attachment.projectId !== this.options.projectId) {
        throw new ConversationAttachmentError('attachment_unavailable', '附件不属于当前项目，不能读取。');
      }
      const file = await this.requireFile(attachment.fileReferenceId);
      if (!attachment.checksumSha256) {
        throw new ConversationAttachmentError('attachment_changed', '旧附件未保存版本校验，请重新选择附件。');
      }
      await this.verify(file, attachment.checksumSha256);
      const fileName = attachment.fileName ?? path.basename(file.locator.kind === 'project' ? file.locator.relativePath : '附件');
      if (isImageAttachment(fileName)) {
        if (input.imageFileId === file.id) continue;
        references.push({ sourceId: file.id, sourceType: 'attachment', contentHash: attachment.checksumSha256,
          location: fileName, excerpt: `附件：${fileName}\n该附件为图片，仅可作为文档插图。当前会话没有读取其图像内容，不能据此描述或分析图片。` });
        continue;
      }
      const text = await this.readText(file, attachment);
      const summaries = summaryCache?.status === 'completed' ? summaryCache.parts.filter((part) => part.sourceId === file.id && part.sourceHash === attachment.checksumSha256) : [];
      if (summaryCache?.status === 'completed') requireCompleteSummary(summaries, text.length);
      const excerpt = summaries.length
        ? `读取范围：已逐段处理全文 ${text.length} 字符，以下是各片段的事实摘要，不是原文；请综合所有片段作答并说明摘要依据。\n${summaries.map((part) => `【原文字符 ${part.start + 1}—${part.end}】\n${part.summary}`).join('\n\n')}`
        : selectAttachmentText(text, input.query, budgetPerFile, fileName);
      references.push({ sourceId: file.id, sourceType: 'attachment', location: fileName,
        contentHash: createHash('sha256').update(`${attachment.checksumSha256}\n${excerpt}`).digest('hex'),
        excerpt: `附件：${fileName}\n原文件 SHA-256：${attachment.checksumSha256}\n${excerpt}` });
    }
    await emitProductionEvent({ code: 'source_context', status: 'completed',
      facts: { tool: 'read_sources', count: references.length } });
    return references;
    } catch (error) {
      await emitProductionEvent({ code: 'source_context', status: 'failed', facts: { tool: 'read_sources' } });
      throw error;
    }
  }

  async resolveImage(input: {
    readonly conversation: Conversation;
    readonly currentUserMessageId: MessageId;
  }): Promise<{ readonly fileId: string; readonly image: ConversationImageInput }> {
    if (input.conversation.projectId !== this.options.projectId ||
      !input.conversation.messages.some(message => message.id === input.currentUserMessageId && message.role === 'user')) {
      throw new ConversationAttachmentError('attachment_unavailable', '图片不属于当前项目会话。');
    }
    const images = conversationAttachmentBatch(input.conversation).filter(item => isImageAttachment(item.fileName ?? ''));
    if (images.length !== 1) throw new ConversationAttachmentError('attachment_scope_exceeded', images.length
      ? '请保留一张要分析的图片后发送。' : '请先拖入或粘贴一张要分析的图片。');
    const attachment = images[0];
    if (attachment.projectId !== this.options.projectId) throw new ConversationAttachmentError('attachment_unavailable', '图片不属于当前项目。');
    const file = await this.requireFile(attachment.fileReferenceId);
    await this.verify(file, attachment.checksumSha256);
    const target = await resolveFileReferencePathSafely(this.options.rootDirectory, file);
    const inspected = await new NodeImageInspector().inspect(target).catch(() => undefined);
    if (!inspected || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(inspected.mimeType)) {
      throw new ConversationAttachmentError('attachment_unsupported', '请使用有效的 PNG、JPEG、WebP 或 GIF 图片。');
    }
    if (inspected.sizeBytes > conversationImageMaxBytes || inspected.width * inspected.height > 40_000_000) {
      throw new ConversationAttachmentError('attachment_scope_exceeded', '图片超过本次读取上限（8 MB、4000 万像素），请压缩后发送。');
    }
    const handle = await open(target, 'r');
    try {
      const bytes = Buffer.alloc(conversationImageMaxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== inspected.sizeBytes || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== attachment.checksumSha256) {
        throw new ConversationAttachmentError('attachment_changed', '图片内容发生变化，请重新导入后发送。');
      }
      const image = parseConversationImageInput({ mimeType: inspected.mimeType, base64: bytes.subarray(0, length).toString('base64'), checksumSha256: attachment.checksumSha256 });
      return { fileId: file.id, image };
    } finally {
      await handle.close();
    }
  }

  private summaryKey(conversation: Conversation): string {
    return summaryHash(JSON.stringify(['attachment-summary-v1', this.options.projectId, conversation.id,
      conversationAttachmentBatch(conversation).map((item) => [item.fileReferenceId, item.checksumSha256])]));
  }

  private async readText(file: FileReference, attachment: PinnedFile): Promise<string> {
    const fileName = attachment.fileName ?? '附件';
    const extraction = await this.extraction.extractContent(file.id);
    await this.verify(file, attachment.checksumSha256);
    if (extraction.status !== 'extracted' || !extraction.text.trim()) {
      const reason = extraction.status === 'scanned_pdf' ? '扫描 PDF 没有文本层，当前未启用 OCR' :
        extraction.status === 'encrypted' ? '文档已加密' :
        extraction.status === 'too_large' ? '文件超过本地读取上限' : '当前无法读取该文件格式或内容';
      throw new ConversationAttachmentError('attachment_unsupported', `无法读取附件“${fileName}”：${reason}。`);
    }
    if (extraction.text.length >= defaultFileExtractionLimits.maxAssembledCharacters ||
      extraction.warnings.some((warning) => !warning.startsWith('预览') && /截断|超过|上限|限制/.test(warning))) {
      throw new ConversationAttachmentError('attachment_scope_exceeded', `附件“${fileName}”超过完整提取范围，请拆分资料后继续，尚未按全文处理。`);
    }
    return extraction.text;
  }

  private async requireFile(fileId: string): Promise<FileReference> {
    const file = await this.files.get(toFileReferenceId(fileId));
    if (!file || file.projectId !== this.options.projectId || file.locator.kind !== 'project' ||
      !file.locator.relativePath.replace(/\\/g, '/').startsWith('files/attachments/')) {
      throw new ConversationAttachmentError('attachment_unavailable', '所选附件在当前项目中不存在，请重新选择资料。');
    }
    try {
      const metadata = await stat(await resolveFileReferencePathSafely(this.options.rootDirectory, file));
      if (!metadata.isFile()) throw new Error('Not a regular file');
      if (metadata.size > defaultFileExtractionLimits.maxFileBytes) {
        throw new ConversationAttachmentError('attachment_scope_exceeded', '附件超过本地读取大小上限，请拆分资料后继续。');
      }
    } catch (error) {
      if (error instanceof ConversationAttachmentError) throw error;
      throw new ConversationAttachmentError('attachment_unavailable', '附件已删除或当前不可读，请重新选择资料。');
    }
    return file;
  }

  private async verify(file: FileReference, checksumSha256?: string): Promise<string> {
    if (!checksumSha256) throw new ConversationAttachmentError('attachment_changed', '附件尚未完成版本校验，请重新导入。');
    const result = await this.probe.inspect(file, { expectedChecksum: checksumSha256 });
    if (result.issues.includes('checksum_mismatch')) {
      throw new ConversationAttachmentError('attachment_changed', '附件内容已发生变化，请重新选择并确认最新版本。');
    }
    if (!result.verification || result.recommendedState !== 'available') {
      throw new ConversationAttachmentError('attachment_unavailable', '附件已删除或当前不可读，请重新选择资料。');
    }
    if (result.verification.sizeBytes > defaultFileExtractionLimits.maxFileBytes) {
      throw new ConversationAttachmentError('attachment_scope_exceeded', '附件超过本地读取大小上限，请拆分资料后继续。');
    }
    return result.verification.checksumSha256;
  }
}

function selectAttachmentText(text: string, query: string, budget: number, fileName: string): string {
  if (estimateConversationTokens(text) <= budget - 160) return `读取范围：全文，共 ${text.length} 字符。\n${text}`;
  const tailRequested = /最后|末节|末尾|结尾|最后一[页章节]/.test(query);
  const targeted = tailRequested || /第[一二三四五六七八九十\d]+[页章节]|哪些|哪里|多少|什么|风险|原因|关于/.test(query);
  if (!targeted || /全文|全部|整体|全表|总计|合计|平均|汇总|统计|总结|摘要|主要观点/.test(query)) {
    throw new ConversationAttachmentError('attachment_scope_exceeded', `附件“${fileName}”超出本次全文处理预算，请按章节拆分或指定问题；尚未生成不完整的全文结论。`);
  }
  const windowSize = Math.max(128, budget - 240);
  let start = Math.max(0, text.length - windowSize);
  if (!tailRequested) {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? [])];
    let best = 0;
    let bestScore = 0;
    for (let offset = 0; offset < text.length; offset += Math.max(64, Math.floor(windowSize / 2))) {
      const chunk = text.slice(offset, offset + windowSize).toLowerCase();
      const score = terms.reduce((sum, term) => sum + (chunk.includes(term) ? 1 : 0), 0);
      if (score > bestScore) { best = offset; bestScore = score; }
    }
    if (!bestScore) throw new ConversationAttachmentError('attachment_scope_exceeded', `未能在附件“${fileName}”中定位该问题，请指定章节或更具体的关键词。`);
    start = best;
  }
  const end = Math.min(text.length, start + windowSize);
  return `读取范围：问题相关片段，字符 ${start + 1}—${end} / ${text.length}。这是局部资料，不代表全文；回答需说明引用范围，无法从该片段证明的信息应明确缺失。\n${text.slice(start, end)}`;
}

function isSummaryRequest(query: string): boolean {
  return /摘要|总结|概述|主要观点|归纳|提炼/.test(query) && !/全表|总计|合计|平均|汇总|统计/.test(query);
}
export function isImageAttachment(name: string): boolean { return /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(name); }
function requireCompleteSummary(parts: readonly AttachmentSummaryPart[], textLength: number): void {
  let cursor = 0;
  for (const part of parts) {
    if (part.start !== cursor || !part.summary || part.summaryHash !== summaryHash(part.summary)) {
      throw new ConversationAttachmentError('attachment_unavailable', '资料摘要的全文覆盖校验未通过，请重新核对资料处理记录。');
    }
    cursor = part.end;
  }
  if (cursor !== textLength) throw new ConversationAttachmentError('attachment_unavailable', '资料摘要缺少完整原文范围，未将其作为全文结果使用。');
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('attachment_summary_cancelled'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
