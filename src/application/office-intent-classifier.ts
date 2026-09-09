import type {
  DocumentDraftId,
  DocumentWorkspaceKind
} from '../domain';
import type {
  OfficeIntentV2,
  OfficeRequestContextV2,
  DocumentDraftContext,
  OfficeDocumentContext
} from './office-request-intent-v2';

export interface OfficeIntentClassifierPort {
  classify(
    text: string,
    context: OfficeRequestContextV2
  ): Promise<OfficeIntentV2>;
}

interface ClassificationInput {
  readonly text: string;
  readonly recentMessages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly drafts: readonly {
    readonly summary: string;
    readonly format: DocumentWorkspaceKind;
  }[];
  readonly documents: readonly {
    readonly kind: DocumentWorkspaceKind;
    readonly fileName: string;
  }[];
}

interface ClassificationOutput {
  readonly kind: 'chat' | 'document';
  readonly action?: 'create' | 'revise';
  readonly format?: DocumentWorkspaceKind;
  readonly useDraft?: boolean;
  readonly useDocument?: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly rationale: string;
}

const CLASSIFICATION_SYSTEM_PROMPT = `你是一个办公意图分类器。用户在聊天界面发送请求，你需要判断：
1. 这是普通聊天（chat），还是要生成/修改办公文档（document）
2. 如果是 document：
   - action: create（新建）还是 revise（修改上一版）
   - format: word / excel / ppt
   - useDraft: 是否引用聊天里刚出现的结构化数据（draft）
   - useDocument: 是否修改已有的上一版文档

**判断规则**：
- 包含"怎么/如何/为什么/是否/看看/检查/分析"且无"生成/做/写"动词 → chat
- 包含"生成/制作/做/新建/写/导出" + 明确文档类型（Word/Excel/PPT/表格/文档/演示） → document/create
- 包含"修改/更新/调整/加/删/改" + 存在上一版文档 → document/revise
- 包含"上面/刚才/这些/那份" + 存在 draft → useDraft=true
- 包含"上一版/当前/这个" + 存在 document → useDocument=true

返回 JSON，格式：
{
  "kind": "chat" | "document",
  "action": "create" | "revise",
  "format": "word" | "excel" | "ppt",
  "useDraft": boolean,
  "useDocument": boolean,
  "confidence": "high" | "medium" | "low",
  "rationale": "判断理由（一句话）"
}`;

export async function classifyWithLlm(
  input: ClassificationInput,
  modelInvoker: (prompt: string) => Promise<string>,
  timeoutMs: number = 1200
): Promise<ClassificationOutput | undefined> {
  const prompt = buildPrompt(input);
  try {
    const responseText = await Promise.race([
      modelInvoker(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM classification timeout')), timeoutMs)
      )
    ]);
    return parseClassificationResponse(responseText);
  } catch (error) {
    return undefined;
  }
}

function buildPrompt(input: ClassificationInput): string {
  const { text, recentMessages, drafts, documents } = input;
  let prompt = `${CLASSIFICATION_SYSTEM_PROMPT}\n\n`;
  prompt += `**用户当前请求**：${text}\n\n`;
  if (recentMessages.length > 0) {
    prompt += `**最近3条消息**：\n`;
    recentMessages.slice(-3).forEach((msg, idx) => {
      const content = msg.content.slice(0, 800);
      prompt += `${idx + 1}. ${msg.role}: ${content}\n`;
    });
    prompt += '\n';
  }
  if (drafts.length > 0) {
    prompt += `**可引用的结构化草稿**：\n`;
    drafts.slice(-2).forEach((draft, idx) => {
      prompt += `${idx + 1}. ${draft.summary} (${draft.format})\n`;
    });
    prompt += '\n';
  }
  if (documents.length > 0) {
    prompt += `**可修改的上一版文档**：\n`;
    documents.slice(-2).forEach((doc, idx) => {
      prompt += `${idx + 1}. ${doc.fileName} (${doc.kind})\n`;
    });
    prompt += '\n';
  }
  prompt += `请返回 JSON 分类结果。`;
  return prompt;
}

function parseClassificationResponse(
  responseText: string
): ClassificationOutput | undefined {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return undefined;
    const parsed = JSON.parse(jsonMatch[0]);
    if (
      typeof parsed.kind !== 'string' ||
      !['chat', 'document'].includes(parsed.kind)
    ) {
      return undefined;
    }
    return {
      kind: parsed.kind,
      action: parsed.action,
      format: parsed.format,
      useDraft: parsed.useDraft === true,
      useDocument: parsed.useDocument === true,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence)
        ? parsed.confidence
        : 'medium',
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'LLM分类'
    };
  } catch {
    return undefined;
  }
}

export function convertClassificationToIntent(
  classification: ClassificationOutput,
  context: OfficeRequestContextV2
): OfficeIntentV2 {
  if (classification.kind === 'chat') {
    return {
      kind: 'chat',
      confidence: classification.confidence,
      rationale: classification.rationale
    };
  }

  const action = classification.action ?? 'create';
  const format = classification.format ?? inferDefaultFormat(context);
  const drafts = context.drafts ?? [];
  const documents = context.documents ?? [];

  const sourceDraftId =
    classification.useDraft && drafts.length > 0
      ? drafts[drafts.length - 1].draftId
      : undefined;
  const sourceMessageId =
    classification.useDocument && documents.length > 0
      ? documents[documents.length - 1].messageId
      : undefined;

  return {
    kind: 'document',
    action,
    format,
    sourceDraftId,
    sourceMessageId,
    confidence: classification.confidence,
    needsConfirmation: classification.confidence !== 'high',
    missingFields: [],
    rationale: classification.rationale
  };
}

function inferDefaultFormat(
  context: OfficeRequestContextV2
): DocumentWorkspaceKind {
  if (context.latestDocumentKind) return context.latestDocumentKind;
  const drafts = context.drafts ?? [];
  if (drafts.length > 0) return drafts[drafts.length - 1].format;
  return 'word';
}
