import {
  presentationDocumentPageLimits,
  presentationPlanningTotalPages,
  type PresentationPageRequirement
} from '../domain';

const pageNumberToken = '([0-9]{1,3}|[零一二两三四五六七八九十百]{1,5})';
const rangeSeparator = '(?:[-–—~～至到])';
const pageAmounts = new RegExp(`${pageNumberToken}(?:\\s*页)?\\s*(?:${rangeSeparator}\\s*${pageNumberToken})?\\s*页`, 'giu');
const labelledPageAmounts = new RegExp(`(?:正文页数|总页数|页数)\\s*[：:=]\\s*${pageNumberToken}(?:\\s*${rangeSeparator}\\s*${pageNumberToken})?(?:\\s*页)?`, 'giu');

interface PageCandidate {
  readonly index: number;
  readonly quoted: boolean;
  readonly requirement: PresentationPageRequirement;
}

interface PagePreferenceProjection {
  readonly requirement?: PresentationPageRequirement;
  readonly explicitlyCleared: boolean;
}

interface PageConstraintChange {
  readonly index: number;
  readonly end: number;
  readonly mode: 'clear' | 'relax';
}

const clearPageConstraint = /(?:正文页数|总页数|页数)\s*(?:可以)?\s*(?:不限|不限制|没有限制|无(?:需|须)限制|不作要求|不做要求|你来定|你来安排|自由安排)|(?:取消|撤销|去掉|解除|删除)\s*(?:之前的|原来的|此前的|原有的)?\s*(?:正文页数|总页数|页数)\s*(?:限制|要求|约束)|(?:不再|不用|无需|不必|不需要)\s*(?:限制|限定|指定|要求固定|控制)\s*(?:正文页数|总页数|页数)|不(?:限制|限定)\s*(?:正文页数|总页数|页数)/gu;
const relaxPageConstraint = /(?:正文页数|总页数|页数)\s*(?:只是|仅作|只作|仅供|作为|仅是|是)?\s*(?:参考|建议|规划目标)|(?:正文页数|总页数|页数)\s*(?:不用|不必|无需|不需要|不要)\s*(?:这么|那么)?\s*(?:严格|精确|死板|恰好|一致)|(?:不用|不必|无需|不需要|不要|别)\s*(?:严格|精确)\s*(?:卡|限制|控制|遵守|按)?\s*(?:正文页数|总页数|页数)/gu;

/** Interpret the current user's page preference without upgrading a planning target to a hard gate. */
export function parsePresentationPageRequirement(requestText: string): PresentationPageRequirement | undefined {
  const parameterIndex = requestText.search(/已确认参数\s*[：:]/u);
  const userText = parameterIndex < 0 ? requestText : requestText.slice(0, parameterIndex);
  const referenceFreeUserText = userText.split(/(?:以下 JSON 是已授权的参考资料|参考资料\s*[：:])/u)[0];
  const quotedRanges = quotedTextRanges(referenceFreeUserText);
  const currentMarkers = [...referenceFreeUserText.matchAll(/(?:后续要求（与此前冲突时以此为准）|修改要求|局部修改要求|本次要求|当前需求)\s*[：:]/gu)]
    .filter(match => !quotedRanges.some(range => match.index! > range.start && match.index! < range.end));
  const lastMarker = currentMarkers.at(-1);
  let effective = lastMarker ? referenceFreeUserText.slice(lastMarker.index! + lastMarker[0].length) : referenceFreeUserText;
  // References and previous drafts are not a second source of user requirements.
  effective = effective.split(/(?:以下 JSON 是已授权的参考资料|参考资料\s*[：:]|上一版文档内容\s*[：:])/u)[0];
  const projection = parseCurrentPagePreference(effective);
  if (projection.requirement || projection.explicitlyCleared || parameterIndex < 0) return projection.requirement;
  // Older semantic plans may retain only a numeric parameter. It remains a planning target.
  return parseCurrentPagePreference(requestText.slice(parameterIndex)).requirement;
}

function parseCurrentPagePreference(text: string): PagePreferenceProjection {
  const quotedRanges = quotedTextRanges(text);
  const candidates = new Map<number, PageCandidate>();
  for (const pattern of [pageAmounts, labelledPageAmounts]) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index! + match[0].indexOf(match[1]);
      const end = match.index! + match[0].length;
      const preceding = text.slice(0, index);
      const prefix = preceding.split(/[，,。；;\n！？!?]/u).at(-1)!.slice(-100);
      const suffix = text.slice(end).split(/[，,。；;\n！？!?]/u)[0].slice(0, 100);
      if (/[0-9零一二两三四五六七八九十百.\-−]$/u.test(preceding) || /[-−]\s*$/u.test(prefix)) continue;
      if (/第\s*$/u.test(prefix)) continue;
      if (/(?:加|增加|新增|添加|补充)\s*$/u.test(prefix)) continue;
      if (/^\s*(?:的\s*)?(?:资料|附件|原文|参考材料|参考文档|源文件)/u.test(suffix)) continue;
      if (/(?:资料|附件|原文|参考材料|参考文档|源文件)\s*(?:共|有|共有|长|超过|为)?\s*$/u.test(prefix)) continue;
      if (/(?:不要|不做|不用|不必|无需|不需要|不要求|不是|撤销|取消|别做)\s*(?:按|必须|恰好|正好|做|制作)?\s*$/u.test(prefix)) continue;
      if (/(?:至少|最少|不低于|不少于)\s*$/u.test(prefix)) continue;
      if (/(?:修改|优化|编辑|检查|读取|分析|总结|查看|改进)\s*(?:一下|这份|这个|一份|一个)?\s*$/u.test(prefix)) continue;
      const historical = /(?:原来|原本|之前|此前|上次|以前|旧版|上一版|现有|已有|曾经|曾说|参考|引用)/u.exec(prefix);
      if (historical && !/(?:现在|本次|这次|此次|当前|改成|改为|改到|调整为|调整到|扩展至|扩展到)/u.test(prefix.slice(historical.index + historical[0].length))) continue;
      const presentationContext = /pptx?|演示文稿|幻灯片|课件/iu.test(prefix + suffix);
      const demandContext = /(?:正文|内容页数|总页数|页数|总共|总计|一共|合计|做|要|给我|生成|制作|计划|希望|需要|设置|减少到|减到|压缩到|扩展至|扩展到|扩至|增至|加到|改到|改成|改为|调整为|调整到|变成|控制在|最多|至多|不超过|不多于|不要超过|不得超过|不能超过|必须|恰好|正好|严格|大约|大概|预计|约)\s*(?:要求|为|是|到|至|成|一个|一份|[：:=])?\s*$/u.test(prefix);
      const standalone = /^[\s“「『"]*$/u.test(prefix) && /^(?:\s*(?:左右|上下|以内|以下|之间|正文))?(?:\s*(?:就行|即可|就可以|为宜|都行|吧))?\s*[“”「」『』"。]*$/u.test(suffix);
      if (!presentationContext && !demandContext && !standalone) continue;
      const first = parsePageNumber(match[1]);
      const second = match[2] === undefined ? undefined : parsePageNumber(match[2]);
      if (!Number.isSafeInteger(first) || first <= 0 ||
          (second !== undefined && (!Number.isSafeInteger(second) || second < first))) continue;
      const basisMentions = [...prefix.matchAll(/正文(?:页数)?|内容页数|总页数|总共|总计|一共|合计/gu)];
      const lastBasis = basisMentions.at(-1)?.[0];
      const excludesSystemPages = /(?:不含|不包括|不计|不算|另算)[^。；\n]{0,20}(?:封面|结束页|结尾|致谢)|(?:封面|结束页|结尾|致谢)[^。；\n]{0,12}(?:另算|不计入)/u.test(text.slice(end, end + 64));
      const countBasis = lastBasis?.startsWith('正文') || lastBasis === '内容页数' || /^\s*(?:的\s*)?正文/u.test(suffix) || excludesSystemPages
        ? 'content' as const : 'total' as const;
      let requirement: PresentationPageRequirement;
      if (second !== undefined) {
        requirement = { mode: 'range', targetPages: Math.round((first + second) / 2), minimumPages: first, maximumPages: second, countBasis };
      } else if (/(?:最多|至多|不超过|不多于|不要超过|不得超过|不能超过|控制在)/u.test(prefix) || /^\s*(?:以内|以下|之内)/u.test(suffix)) {
        requirement = { mode: 'max', targetPages: first, maximumPages: first, countBasis };
      } else {
        const approximate = /大约|大概|差不多|大致|预计|约/u.test(prefix) || /^\s*(?:左右|上下|大约|差不多)/u.test(suffix);
        const exact = !approximate && /必须|恰好|正好|严格/u.test(prefix);
        requirement = { mode: exact ? 'exact' : 'target', targetPages: first, countBasis };
      }
      candidates.set(index, { index, quoted: quotedRanges.some(range => index > range.start && index < range.end), requirement });
    }
  }
  const ordered = [...candidates.values()].sort((left, right) => left.index - right.index);
  const changes: PageConstraintChange[] = [];
  for (const [pattern, mode] of [[clearPageConstraint, 'clear'], [relaxPageConstraint, 'relax']] as const) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index!;
      if (quotedRanges.some(range => index > range.start && index < range.end)) continue;
      const prefix = text.slice(0, index).split(/[，,。；;\n！？!?]/u).at(-1)!.slice(-100);
      const historical = /(?:原来|原本|之前|此前|上次|以前|旧(?:版|要求)|上一版|曾经|曾说|参考|引用|资料|附件|原文|示例)/u.exec(prefix);
      if (historical && !/(?:现在|本次|这次|此次|当前)/u.test(prefix.slice(historical.index + historical[0].length))) continue;
      if (/(?:不要|不必|不用|无需|不需要|别)\s*(?:再)?\s*$/u.test(prefix) && mode === 'clear') continue;
      changes.push({ index, end: index + match[0].length, mode });
    }
  }
  changes.sort((left, right) => left.index - right.index);
  const latestChange = changes.at(-1);
  if (!latestChange) return { requirement: latestPageCandidate(ordered)?.requirement, explicitlyCleared: false };
  const lastClear = changes.filter(change => change.mode === 'clear').at(-1);
  const afterChange = latestPageCandidate(ordered.filter(candidate => candidate.index >= latestChange.end));
  if (afterChange) return { requirement: afterChange.requirement, explicitlyCleared: lastClear !== undefined };
  if (latestChange.mode === 'clear') return { explicitlyCleared: true };
  // Relax only the surviving numeric goal. A later relaxation cannot revive a cleared historical count.
  const previous = latestPageCandidate(ordered.filter(candidate => candidate.index < latestChange.end &&
    (lastClear === undefined || candidate.index >= lastClear.end)));
  return {
    ...(previous ? { requirement: { mode: 'target', targetPages: previous.requirement.targetPages,
      countBasis: previous.requirement.countBasis } as const } : {}),
    explicitlyCleared: lastClear !== undefined
  };
}

function latestPageCandidate(candidates: readonly PageCandidate[]): PageCandidate | undefined {
  return candidates.filter(candidate => !candidate.quoted).at(-1) ?? candidates.at(-1);
}

function quotedTextRanges(text: string): readonly { readonly start: number; readonly end: number }[] {
  return [...text.matchAll(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
}

/** Compatibility projection for planning only; hard QA must use the semantic requirement. */
export function parseRequestedPresentationTotalPages(
  requestText: string
): number | undefined {
  const requirement = parsePresentationPageRequirement(requestText);
  return requirement ? presentationPlanningTotalPages(requirement) : undefined;
}

export function presentationBodySectionCount(totalPages: number): number {
  return totalPages - presentationDocumentPageLimits.systemGeneratedPages;
}

export function isSupportedPresentationTotalPages(totalPages: number): boolean {
  return (
    Number.isSafeInteger(totalPages) &&
    totalPages >= presentationDocumentPageLimits.minimumRequestedPages &&
    totalPages <= presentationDocumentPageLimits.maximumPages
  );
}

function parsePageNumber(token: string): number {
  if (/^\d+$/u.test(token)) return Number(token);
  const digits: Readonly<Record<string, number>> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  const units: Readonly<Record<string, number>> = { 十: 10, 百: 100 };
  let total = 0;
  let current = 0;
  for (const character of token) {
    const digit = digits[character];
    if (digit !== undefined) {
      current = digit;
      continue;
    }
    const unit = units[character];
    if (unit === undefined) return Number.NaN;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}
