import type { DocumentWorkspaceKind } from '../domain';

export type OfficeRequestAction = 'create' | 'revise';

export interface OfficeDocumentContext {
  readonly messageId: string;
  readonly kind: DocumentWorkspaceKind;
  readonly fileName: string;
}

export interface OfficeRequestContext {
  readonly documents?: readonly OfficeDocumentContext[];
  readonly latestDocumentKind?: DocumentWorkspaceKind;
  readonly availableDocumentKinds?: readonly DocumentWorkspaceKind[];
}

export type OfficeRequestIntent =
  | {
      readonly kind: 'chat';
      readonly missing: readonly [];
    }
  | {
      readonly kind: 'document';
      readonly action: OfficeRequestAction;
      readonly documentKind?: DocumentWorkspaceKind;
      readonly targetDocumentKind?: DocumentWorkspaceKind;
      readonly targetMessageId?: string;
      readonly missing: readonly string[];
    };

const typePatterns: readonly {
  readonly kind: DocumentWorkspaceKind;
  readonly pattern: RegExp;
}[] = [
  {
    kind: 'ppt',
    pattern: /(?:\bpptx?\b|幻灯片|演示文稿|课件|路演稿|宣讲稿)/i
  },
  {
    kind: 'excel',
    pattern: /(?:\bexcel\b|\bxlsx\b|工作簿|电子表格)/i
  },
  {
    kind: 'word',
    pattern: /(?:\bword\b|\bdocx\b|文字文档)/i
  }
];
const tableDeliverablePattern =
  /(?:表格|清单|(?:员工|工资|薪资|销售|数据|统计|经营|客户|库存|财务)表|台账)/;

const createPattern =
  /(?:帮我|请|给我|麻烦)?(?:做|生成|制作|创建|写|整理|输出|导出|出)(?:成|一份|一个)?/;
const explicitNewDocumentPattern =
  /(?:重新|从头)(?:做|生成|制作|创建|写)(?:一份|一个)?|另(?:做|生成|制作|创建|写)(?:一份|一个)|新建(?:一份|一个)?/;
const genericDeliverablePattern =
  /(?:汇报|报告|方案|纪要|复盘|计划|简历|清单|文档|表格)/;
const revisionPattern =
  /(?:修改|改成|改为|改一下|改简洁|改前|调整|调一下|优化|重排|重新排版|替换|换成|更新|补充|补一|再补|增加|新增|加上|加入|加一|加几|删除|删掉|精简|润色|统一|美化|扩写|扩充|丰富)/;
const contextualAddPattern =
  /(?:再|要|需要|想|在|给|帮我)?加(?!油|班|载|速|热|密|群|好友|微信|QQ)[\u4e00-\u9fffA-Za-z0-9]/;
const revisionTargetPattern =
  /(?:上一版|前一版|刚才(?:的)?|第\s*[一二三四五六七八九十百\d]+\s*(?:章|页|张(?:幻灯片)?|部分|节))/;
const directRevisionPattern =
  /(?:把|将|请|麻烦|帮我|给)[\s\S]{0,80}(?:修改|改|调整|优化|重排|替换|换成|更新|补充|增加|新增|加|删除|精简|润色|美化|扩写|丰富)/;
const questionOrAnalysisPattern =
  /(?:怎么|如何|为什么|是什么|有哪些|有什么区别|需要注意什么|是否|能否|可以吗|评价|点评)|^(?:请|帮我)?分析(?:这|一下)?/;
const previousResultCorrectionPattern =
  /(?:不是|不要)[\s\S]{0,20}(?:前一个|上一个|前一版)|(?:改|用)(?:成)?前一个(?:版本)?/;

export function analyzeOfficeRequest(
  rawText: string,
  context: OfficeRequestContext = {}
): OfficeRequestIntent {
  const text = rawText.trim();
  if (!text) return { kind: 'chat', missing: [] };

  const explicitKind =
    typePatterns.find(({ pattern }) => pattern.test(text))?.kind ??
    (tableDeliverablePattern.test(text) ? 'excel' : undefined);
  const documents = context.documents ?? [];
  const explicitTarget = findNamedDocument(text, documents);
  const hasRevision =
    revisionPattern.test(text) || contextualAddPattern.test(text);
  const hasCreateRequest = createPattern.test(text);
  // A revision target must point at an existing artifact (a named file, a
  // previous version, or a numbered section/page).  Content instructions
  // such as “删除重复内容” are not targets: they are valid requirements for
  // a brand-new document and must not be blocked by the no-previous-version
  // guard below.
  const hasExplicitRevisionReference =
    explicitTarget !== undefined ||
    revisionTargetPattern.test(text) ||
    previousResultCorrectionPattern.test(text);
  const directRevision = directRevisionPattern.test(text);

  if (explicitNewDocumentPattern.test(text)) {
    return createIntent(explicitKind ?? inferDefaultDocumentKind(text));
  }
  if (questionOrAnalysisPattern.test(text) && !directRevision) {
    return { kind: 'chat', missing: [] };
  }

  // Creation is the default for an explicit create verb unless the user
  // also names an existing artifact/version.  This keeps requirements that
  // contain edit-like words (for example, “删除重复内容”) in the creation
  // workflow while preserving an explicit revision request such as “修改上
  // 一版 PPT”.
  if (hasCreateRequest && !hasExplicitRevisionReference) {
    if (!explicitKind && !genericDeliverablePattern.test(text)) {
      return { kind: 'chat', missing: [] };
    }
    return createIntent(explicitKind ?? inferDefaultDocumentKind(text));
  }

  const hasDocumentContext =
    documents.length > 0 || context.latestDocumentKind !== undefined;
  const isRevision =
    hasRevision &&
    (hasExplicitRevisionReference || (!hasCreateRequest && hasDocumentContext));
  if (isRevision) {
    const target = resolveRevisionTarget(text, explicitKind, explicitTarget, documents);
    const documentKind =
      target?.kind ?? explicitKind ?? context.latestDocumentKind;
    if (!documentKind) return { kind: 'chat', missing: [] };
    const targetAvailable = target !== undefined || legacyTargetAvailable(documentKind, context);
    return {
      kind: 'document',
      action: 'revise',
      documentKind,
      targetDocumentKind: documentKind,
      ...(target ? { targetMessageId: target.messageId } : {}),
      missing: targetAvailable
        ? []
        : [`可修改的上一版 ${documentKindLabel(documentKind)}`]
    };
  }

  if (!createPattern.test(text)) return { kind: 'chat', missing: [] };
  if (!explicitKind && !genericDeliverablePattern.test(text)) {
    return { kind: 'chat', missing: [] };
  }
  return createIntent(explicitKind ?? inferDefaultDocumentKind(text));
}

function createIntent(
  documentKind: DocumentWorkspaceKind
): OfficeRequestIntent {
  return {
    kind: 'document',
    action: 'create',
    documentKind,
    missing: []
  };
}

function inferDefaultDocumentKind(text: string): DocumentWorkspaceKind {
  if (/(?:汇报|演示|路演|宣讲|课件)/.test(text)) return 'ppt';
  if (tableDeliverablePattern.test(text)) return 'excel';
  return 'word';
}

function resolveRevisionTarget(
  text: string,
  explicitKind: DocumentWorkspaceKind | undefined,
  explicitTarget: OfficeDocumentContext | undefined,
  documents: readonly OfficeDocumentContext[]
): OfficeDocumentContext | undefined {
  if (explicitTarget) return explicitTarget;
  const candidates = explicitKind
    ? documents.filter((document) => document.kind === explicitKind)
    : documents;
  const offset = previousResultCorrectionPattern.test(text) ? 2 : 1;
  return candidates[candidates.length - offset];
}

function findNamedDocument(
  text: string,
  documents: readonly OfficeDocumentContext[]
): OfficeDocumentContext | undefined {
  return [...documents]
    .reverse()
    .find((document) => text.toLocaleLowerCase().includes(document.fileName.toLocaleLowerCase()));
}

function legacyTargetAvailable(
  kind: DocumentWorkspaceKind,
  context: OfficeRequestContext
): boolean {
  return (context.availableDocumentKinds ?? []).includes(kind);
}

function documentKindLabel(kind: DocumentWorkspaceKind): string {
  if (kind === 'ppt') return 'PPT';
  if (kind === 'excel') return 'Excel';
  return 'Word';
}
