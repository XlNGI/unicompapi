import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, ConversationResponseDraftV1, DocumentMessageResult, MessageId, ProjectId } from '../../domain';
import { estimateConversationTokens, type ConversationContextReference } from '../../application/conversation-context-builder';
import { JsonFileReferenceRepository, JsonWorkRepository } from '../repositories/json-repositories';
import { NodeProjectStorage } from '../storage';
import { resolveFileReferencePathSafely } from '../files/file-paths';
import { readPptxPage } from './pptx-page-reader';

export type ConversationDocumentPageErrorCode =
  | 'document_page_unavailable'
  | 'document_page_out_of_range'
  | 'document_page_ambiguous'
  | 'document_page_scope_exceeded';

export class ConversationDocumentPageError extends Error {
  constructor(readonly code: ConversationDocumentPageErrorCode, message: string) {
    super(message);
    this.name = 'ConversationDocumentPageError';
  }
}

const maxFileBytes = 20 * 1024 * 1024;
const maxReferenceTokens = 12_000;
const numeral = '[0-9零〇一二两三四五六七八九十百千]+';

/** Older ordinary-response drafts have no pinned page query; derive it only from trusted user text. */
export async function resolveConversationResponseDocumentPages(input: {
  readonly conversation: Conversation;
  readonly draft: ConversationResponseDraftV1;
  readonly service?: Pick<ConversationDocumentPageContextService, 'resolve'>;
}): Promise<readonly ConversationContextReference[]> {
  const index = input.conversation.messages.findIndex((message) => message.id === input.draft.userMessageId);
  const message = input.conversation.messages[index];
  if (!message || message.role !== 'user' || message.state !== 'completed') throw unavailable();
  // Legacy generation stored the internal prompt in content and the user's request in displayContent.
  const usesUserText = message.displayContent === undefined || message.displayContent === message.content ||
    input.draft.promptContent === message.displayContent;
  const ordinaryResponse = usesUserText && (input.draft.promptContent === undefined ||
    input.draft.promptContent === message.content || input.draft.promptContent === message.displayContent);
  const query = input.draft.documentPageQuery ?? (ordinaryResponse
    ? input.draft.attachmentQuery ?? message.displayContent ?? message.content : undefined);
  const expectsPage = query !== undefined && (input.draft.documentPageQuery !== undefined ||
    (hasPageRequest(query) && input.conversation.messages.slice(0, index).some((prior) =>
      prior.role === 'assistant' && prior.state === 'completed' && prior.documentResult?.kind === 'ppt')));
  if (!expectsPage || query === undefined) return [];
  if (!input.service) throw unavailable();
  const references = await input.service.resolve({
    conversation: input.conversation, currentUserMessageId: message.id, query
  });
  if (references.length !== 1) throw unavailable();
  return references;
}

/** Resolves physical pages only from registered PPT works in this conversation. */
export class ConversationDocumentPageContextService {
  private readonly works: JsonWorkRepository;
  private readonly files: JsonFileReferenceRepository;

  constructor(private readonly options: {
    readonly rootDirectory: string;
    readonly projectId: ProjectId;
  }) {
    const storage = new NodeProjectStorage(options.rootDirectory);
    this.works = new JsonWorkRepository(storage, options.projectId);
    this.files = new JsonFileReferenceRepository(storage, options.projectId);
  }

  async resolve(input: {
    readonly conversation: Conversation;
    readonly currentUserMessageId: MessageId;
    readonly query: string;
  }): Promise<readonly ConversationContextReference[]> {
    if (!hasPageRequest(input.query)) return [];
    if (input.conversation.projectId !== this.options.projectId) throw unavailable();
    const currentIndex = input.conversation.messages.findIndex((message) =>
      message.id === input.currentUserMessageId && message.role === 'user' && message.state === 'completed');
    if (currentIndex < 0) throw unavailable();
    const documents: DocumentMessageResult[] = [];
    const seen = new Set<string>();
    for (const message of input.conversation.messages.slice(0, currentIndex).reverse()) {
      const result = message.documentResult;
      if (message.role !== 'assistant' || message.state !== 'completed' || !result || seen.has(result.workId)) continue;
      seen.add(result.workId);
      documents.push(result);
    }
    // An attachment page question must keep using the attachment resolver.
    if (!documents.some((document) => document.kind === 'ppt')) return [];
    const document = selectDocument(documents, input.query);
    const pageNumber = requestedPage(withoutDocumentNames(documents, input.query));
    try {
      const work = await this.works.get(document.workId);
      if (!work || work.projectId !== this.options.projectId || work.mediaKind !== 'document') throw unavailable();
      const file = await this.files.get(work.fileId);
      if (!file || file.projectId !== this.options.projectId || file.state !== 'available' ||
          file.sourceExecutionId !== work.sourceExecutionId || file.locator.kind !== 'project' ||
          !file.locator.relativePath.replace(/\\/g, '/').startsWith('files/documents/') ||
          path.extname(file.locator.relativePath).toLowerCase() !== '.pptx' ||
          !file.checksumSha256 || !/^[a-f0-9]{64}$/u.test(file.checksumSha256) ||
          path.basename(file.locator.relativePath) !== document.fileName) throw unavailable();
      const absolutePath = await resolveFileReferencePathSafely(this.options.rootDirectory, file);
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) throw unavailable();
      if (metadata.size > maxFileBytes) throw scopeExceeded();
      const buffer = await readFile(absolutePath, { signal: AbortSignal.timeout(5_000) });
      if (buffer.length > maxFileBytes) throw scopeExceeded();
      const checksum = createHash('sha256').update(buffer).digest('hex');
      if (checksum !== file.checksumSha256 || buffer.length !== file.sizeBytes || buffer.length !== document.sizeBytes) {
        throw new ConversationDocumentPageError('document_page_unavailable', '这份 PPT 的本地文件与已登记版本不一致，无法确认指定页内容。');
      }
      const page = await readPptxPage(buffer, pageNumber);
      const location = `${document.fileName} · 第 ${pageNumber} 页`;
      const excerpt = [
        `已登记作品：${document.fileName}`,
        `读取范围：实际 PPT 第 ${pageNumber} 页，共 ${page.totalPages} 页。物理页码从封面起按文件中的幻灯片顺序计数，封面为第 1 页，包含隐藏页。`,
        `当前页${page.hidden ? '为隐藏页' : '不是隐藏页'}。以下仅为该页可提取文字；图片、图形和图表视觉内容未分析。`,
        '该页内容与历史生成大纲的章节序号没有一一对应关系。',
        `[第 ${pageNumber} 页文字开始]`,
        page.text.trim() || '本页没有可提取文字，无法据此判断图片或图形中的内容。',
        `[第 ${pageNumber} 页文字结束]`
      ].join('\n');
      if (estimateConversationTokens(excerpt) > maxReferenceTokens) throw scopeExceeded();
      return [{
        sourceId: work.id,
        sourceType: 'project',
        contentHash: createHash('sha256').update(`${checksum}\npage:${pageNumber}`).digest('hex'),
        location,
        excerpt
      }];
    } catch (error) {
      if (error instanceof ConversationDocumentPageError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'page_out_of_range') {
          throw new ConversationDocumentPageError('document_page_out_of_range', '这份 PPT 没有指定的页码，请核对实际页数。');
        }
        if (error.code === 'scope_exceeded') throw scopeExceeded();
      }
      throw unavailable();
    }
  }
}

function hasPageRequest(query: string): boolean {
  return new RegExp(`(?:第\\s*${numeral}[\\s、,，和与及至到—–~～-]*|倒数|最后)`, 'u').test(query) && /页|张/u.test(query);
}

function requestedPage(query: string): number {
  const matches = [...query.matchAll(new RegExp(`第\\s*(${numeral})\\s*(?:页|张(?:幻灯片)?)`, 'gu'))];
  if (matches.length !== 1 || /倒数|最后|末页|前\s*\d+\s*页|后\s*\d+\s*页/u.test(query) ||
      new RegExp(`${numeral}\\s*(?:页|张)?\\s*(?:到|至|—|–|-|~|～|、|,|，|和|与|及)\\s*(?:第\\s*)?${numeral}\\s*(?:页|张)`, 'u').test(query)) {
    throw ambiguous('请明确指定一份 PPT 的单个物理页码；当前请求包含多个页码、范围或倒数页。');
  }
  const token = matches[0][1];
  if (token.length > 6) throw outOfRange();
  const page = parseOrdinal(token);
  if (!Number.isSafeInteger(page) || page < 1 || page > 999) throw outOfRange();
  return page;
}

function parseOrdinal(token: string): number {
  if (/^\d+$/u.test(token)) return Number(token);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]+$/u.test(token)) return Number([...token].map((item) => digits[item]).join(''));
  if (!/^(?:[一二两三四五六七八九]百(?:[零〇]?[一二两三四五六七八九])?(?:十[一二两三四五六七八九]?)?|[一二两三四五六七八九]?十[一二两三四五六七八九]?)$/u.test(token)) return Number.NaN;
  let total = 0;
  let digit = 0;
  for (const item of token) {
    if (item === '百' || item === '十') {
      total += (digit || 1) * (item === '百' ? 100 : 10);
      digit = 0;
    } else {
      digit = digits[item];
    }
  }
  return total + digit;
}

function selectDocument(documents: readonly DocumentMessageResult[], query: string): DocumentMessageResult {
  const withoutKnownNames = withoutDocumentNames(documents, query);
  if (/(?:上一|前一|第一|第[二三四五六七八九十\d]+|倒数|最早)(?:个版本|个|份|版)|其他(?:文件|文档|PPT)|另一(?:份|个)|另外(?:一份|的)/iu.test(withoutKnownNames) ||
      /(?:[A-Za-z]:[\\/]|\.\.[\\/]|(?:^|\s)[/\\])/u.test(query)) {
    throw ambiguous('请明确写出当前会话中要查看的 PPT 文件名。');
  }
  const named = documents.filter((document) => query.toLocaleLowerCase().includes(document.fileName.toLocaleLowerCase()));
  if (named.length > 1 || (named.length === 1 && named[0].kind !== 'ppt')) {
    throw ambiguous('请明确指定一份当前会话生成的 PPT 文件。');
  }
  if (/\.(?:pptx?|docx?|pdf|xlsx?)\b/iu.test(withoutKnownNames) || /(?:附件|上传|Word|Excel|PDF)/iu.test(withoutKnownNames)) {
    throw ambiguous('当前页码指向的文件不明确，请写出要查看的 PPT 文件名。');
  }
  return named[0] ?? documents.find((document) => document.kind === 'ppt')!;
}

function withoutDocumentNames(documents: readonly DocumentMessageResult[], query: string): string {
  return documents.reduce((text, document) => text.split(document.fileName.toLocaleLowerCase()).join(''), query.toLocaleLowerCase());
}

function unavailable(): ConversationDocumentPageError {
  return new ConversationDocumentPageError('document_page_unavailable', '无法读取当前会话中已登记的 PPT 指定页，请确认作品文件仍可用。');
}

function scopeExceeded(): ConversationDocumentPageError {
  return new ConversationDocumentPageError('document_page_scope_exceeded', '这份 PPT 或指定页超过本地读取范围，本次未截断或猜测页内容。');
}

function ambiguous(message: string): ConversationDocumentPageError {
  return new ConversationDocumentPageError('document_page_ambiguous', message);
}

function outOfRange(): ConversationDocumentPageError {
  return new ConversationDocumentPageError('document_page_out_of_range', '请使用 1 至 999 之间的单个物理页码。');
}
