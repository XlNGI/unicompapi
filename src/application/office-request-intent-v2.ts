import type { DocumentDraftId, DocumentWorkspaceKind } from '../domain';

export type OfficeAction = 'create' | 'revise' | 'append_column' | 'restyle';
export type OfficeFormat = DocumentWorkspaceKind;
export type OfficeConfidence = 'high' | 'medium' | 'low';

export interface OfficeDocumentContext {
  readonly messageId: string;
  readonly kind: DocumentWorkspaceKind;
  readonly fileName: string;
}

export interface DocumentDraftContext {
  readonly draftId: DocumentDraftId;
  readonly summary: string;
  readonly format: DocumentWorkspaceKind;
}

export interface OfficeRequestContextV2 {
  readonly documents?: readonly OfficeDocumentContext[];
  readonly drafts?: readonly DocumentDraftContext[];
  readonly latestDocumentKind?: DocumentWorkspaceKind;
}

export type OfficeIntentV2 =
  | {
      readonly kind: 'chat';
      readonly confidence: OfficeConfidence;
      readonly rationale: string;
    }
  | {
      readonly kind: 'document';
      readonly action: OfficeAction;
      readonly format: OfficeFormat;
      readonly sourceMessageId?: string;
      readonly sourceDraftId?: DocumentDraftId;
      readonly confidence: OfficeConfidence;
      readonly needsConfirmation: boolean;
      readonly missingFields: readonly string[];
      readonly rationale: string;
    };

const typePatterns: readonly {
  readonly kind: DocumentWorkspaceKind;
  readonly pattern: RegExp;
}[] = [
  { kind: 'ppt', pattern: /(?:ppt|pptx|PPT|演示文稿|幻灯片|slides?)/i },
  { kind: 'excel', pattern: /(?:excel|Excel|EXCEL|表格|xlsx|xls|清单|名单)/i },
  { kind: 'word', pattern: /(?:word|Word|WORD|文档|doc|docx|周报|日报|月报|总结|报告|方案|通知|公告)/i }
];

const tableDeliverablePattern = /(?:表格|清单|名单|统计表|数据表)/;
const genericDeliverablePattern = /(?:文档|报告|演示|PPT|Excel|Word)/i;
const createPattern = /(?:新建|生成|制作|做成?|创建|写|导出|给我.*(?:生成|做|写)|帮我.*(?:生成|做|写|整理成)|整理成|弄成)/;
const explicitNewDocumentPattern = /(?:新建|新的|新增|重新生成|从头|全新)/;
const revisionPattern = /(?:修改|更新|调整|优化|改|换|加|删|增加|减少)/;
const contextualAddPattern = /^(?:再|另外|还要|也|继续|接着)/;
const revisionTargetPattern = /(?:上一?版|前一?版|刚才|上面|这个|这份|当前)/;
const questionOrAnalysisPattern = /^(?:怎么|如何|为什么|是否|能不能|可以吗|应该|建议|分析|看看|检查|什么是|是什么)/;

const anaphoraPattern = /(?:上面|刚才|前面|这些|这个|那份)/;

export function analyzeOfficeRequestV2(
  text: string,
  context: OfficeRequestContextV2
): OfficeIntentV2 {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      kind: 'chat',
      confidence: 'high',
      rationale: '空输入'
    };
  }

  const explicitKind = typePatterns.find(({ pattern }) => pattern.test(trimmed))?.kind;
  const documents = context.documents ?? [];
  const drafts = context.drafts ?? [];

  // 1. 纯问答句（以问答词开头且无生成动词且无明确文档类型）
  if (
    questionOrAnalysisPattern.test(trimmed) &&
    !createPattern.test(trimmed) &&
    !revisionPattern.test(trimmed) &&
    !explicitKind
  ) {
    return {
      kind: 'chat',
      confidence: 'high',
      rationale: '纯问答句'
    };
  }

  // 2. 指代词 + drafts 存在（优先处理，避免被其他规则截断）
  if (anaphoraPattern.test(trimmed) && drafts.length > 0) {
    const latestDraft = drafts[drafts.length - 1];
    const hasCreate = createPattern.test(trimmed);
    const hasRevise = revisionPattern.test(trimmed);
    const isPureAnalysis = /(?:看看|检查|分析|有没有问题|对不对|正确吗)/.test(trimmed) &&
      !hasCreate && !hasRevise;

    if (isPureAnalysis) {
      return {
        kind: 'chat',
        confidence: 'high',
        rationale: '指代词+分析动词，非生成'
      };
    }

    if (hasCreate && !hasRevise) {
      return {
        kind: 'document',
        action: 'create',
        format: explicitKind ?? latestDraft.format,
        sourceDraftId: latestDraft.draftId,
        confidence: 'medium',
        needsConfirmation: true,
        missingFields: [],
        rationale: '指代词+生成动词+引用draft'
      };
    }

    if (hasRevise && documents.length > 0) {
      const target = documents[documents.length - 1];
      return {
        kind: 'document',
        action: 'revise',
        format: target.kind,
        sourceMessageId: target.messageId,
        sourceDraftId: latestDraft.draftId,
        confidence: 'medium',
        needsConfirmation: true,
        missingFields: [],
        rationale: '指代词+修改动词+引用draft与上一版'
      };
    }

    // 指代词但无明确动词，默认创建
    if (hasCreate || genericDeliverablePattern.test(trimmed)) {
      return {
        kind: 'document',
        action: 'create',
        format: latestDraft.format,
        sourceDraftId: latestDraft.draftId,
        confidence: 'low',
        needsConfirmation: true,
        missingFields: [],
        rationale: '指代词无明确动词，默认创建'
      };
    }
  }

  // 3. 明确的新建 + 生成动词
  if (explicitNewDocumentPattern.test(trimmed) && createPattern.test(trimmed)) {
    const format = explicitKind ?? inferDefaultFormat(trimmed);
    return {
      kind: 'document',
      action: 'create',
      format,
      confidence: 'high',
      needsConfirmation: false,
      missingFields: [],
      rationale: '明确新建指令'
    };
  }

  // 3. 生成动词 + 明确文档类型
  if (createPattern.test(trimmed) && explicitKind) {
    return {
      kind: 'document',
      action: 'create',
      format: explicitKind,
      confidence: 'high',
      needsConfirmation: false,
      missingFields: [],
      rationale: '生成动词+明确类型'
    };
  }

  // 4. 修改动词 + 存在上一版文档
  const hasRevision = revisionPattern.test(trimmed) || contextualAddPattern.test(trimmed);
  if (hasRevision && documents.length > 0) {
    const target = documents[documents.length - 1];
    const latestDraft = drafts.length > 0 ? drafts[drafts.length - 1] : undefined;
    return {
      kind: 'document',
      action: 'revise',
      format: target.kind,
      sourceMessageId: target.messageId,
      ...(latestDraft ? { sourceDraftId: latestDraft.draftId } : {}),
      confidence: 'high',
      needsConfirmation: false,
      missingFields: [],
      rationale: '修改动词+存在上一版'
    };
  }

  // 5. 启发式fallback
  if (createPattern.test(trimmed)) {
    const format = explicitKind ?? inferDefaultFormat(trimmed);
    return {
      kind: 'document',
      action: 'create',
      format,
      confidence: 'medium',
      needsConfirmation: false,
      missingFields: [],
      rationale: '启发式：有生成动词'
    };
  }

  return {
    kind: 'chat',
    confidence: 'high',
    rationale: '兜底：无生成/修改动词'
  };
}

function inferDefaultFormat(text: string): DocumentWorkspaceKind {
  if (/(?:汇报|演示|路演|宣讲|课件)/.test(text)) return 'ppt';
  if (tableDeliverablePattern.test(text)) return 'excel';
  return 'word';
}
