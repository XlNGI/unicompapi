import { describe, expect, it } from 'vitest';
import {
  parsePresentationPageRequirement,
  parseRequestedPresentationTotalPages
} from '../../src/application/presentation-page-count';
import {
  presentationDocumentPageLimits,
  presentationPlanningTotalPages
} from '../../src/domain';

describe('presentation page preferences', () => {
  it.each([
    ['做一个10页的PPT', 10],
    ['制作一份10页', 10],
    ['给我10页', 10],
    ['我想要10页', 10],
    ['PPT做10页', 10],
    ['10页', 10],
    ['页数：十二页', 12],
    ['内容太少了加到5页', 5],
    ['扩展至8页', 8]
  ])('keeps ordinary %s as a planning target', (text, targetPages) => {
    expect(parsePresentationPageRequirement(text)).toEqual({ mode: 'target', targetPages, countBasis: 'total' });
    expect(parseRequestedPresentationTotalPages(text)).toBe(targetPages);
  });

  it.each([
    '大约10页的PPT',
    'PPT做10页左右',
    '必须大约10页的PPT',
    '正好10页左右的PPT',
    '预计10页的PPT'
  ])('does not turn approximate %s into an exact requirement', text => {
    expect(parsePresentationPageRequirement(text)).toEqual({ mode: 'target', targetPages: 10, countBasis: 'total' });
  });

  it.each(['必须10页的PPT', '恰好10页', 'PPT正好10页', '严格要求10页PPT', '严格要求10页'])('recognizes explicit exact %s', text => {
    expect(parsePresentationPageRequirement(text)).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
  });

  it.each(['最多10页PPT', '不要超过10页', '不超过10页', 'PPT严格控制在10页', '10页以内'])('preserves the upper bound in %s', text => {
    expect(parsePresentationPageRequirement(text)).toEqual({ mode: 'max', targetPages: 10, maximumPages: 10, countBasis: 'total' });
  });

  it.each(['8-12页PPT', 'PPT做8至12页', '8页到12页', '八到十二页的PPT'])('preserves both ends of %s', text => {
    expect(parsePresentationPageRequirement(text)).toEqual({ mode: 'range', targetPages: 10, minimumPages: 8, maximumPages: 12, countBasis: 'total' });
  });

  it.each(['正文10页', '10页正文', '正文页数：10', '10页PPT，不含封面和结束页', '10页PPT，封面结尾另算'])('keeps the content basis in %s and derives the total from configured system pages', text => {
    const requirement = parsePresentationPageRequirement(text);
    expect(requirement).toEqual({ mode: 'target', targetPages: 10, countBasis: 'content' });
    expect(presentationPlanningTotalPages(requirement!)).toBe(10 + presentationDocumentPageLimits.systemGeneratedPages);
    expect(parseRequestedPresentationTotalPages(text)).toBe(10 + presentationDocumentPageLimits.systemGeneratedPages);
  });

  it('retains an exact content count without counting the cover and closing twice', () => {
    const requirement = parsePresentationPageRequirement('正文必须恰好10页');
    expect(requirement).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'content' });
    expect(presentationPlanningTotalPages(requirement!)).toBe(10 + presentationDocumentPageLimits.systemGeneratedPages);
    expect(parsePresentationPageRequirement('含封面和结束页，总页数10页')).toEqual({ mode: 'target', targetPages: 10, countBasis: 'total' });
  });

  it.each([
    '修改第5页',
    '增加5页内容',
    '请把PPT增加5页',
    '超过14页的资料需要完整读取',
    '请总结超过14页的资料',
    '附件共14页',
    'PPT的第10页需要修改',
    '修改这份10页PPT的第5页',
    '请优化现有10页PPT',
    '不要按10页',
    '不是必须10页PPT',
    '不要10页PPT',
    '之前做10页PPT',
    '12-8页PPT',
    '做10.5页PPT',
    '做-10页PPT',
    '做0页PPT'
  ])('does not promote unrelated or invalid %s to a page goal', text => {
    expect(parsePresentationPageRequirement(text)).toBeUndefined();
  });

  it('uses the latest current requirement rather than an old quoted count', () => {
    expect(parsePresentationPageRequirement('之前要求“恰好10页PPT”，现在做12页PPT')).toEqual({ mode: 'target', targetPages: 12, countBasis: 'total' });
    expect(parsePresentationPageRequirement('总页数改为11页（之前约10页）')).toEqual({ mode: 'target', targetPages: 11, countBasis: 'total' });
    expect(parsePresentationPageRequirement('上一版文档内容：恰好20页PPT\n修改要求：扩展至12页')).toEqual({ mode: 'target', targetPages: 12, countBasis: 'total' });
  });

  it('does not let numeric confirmed parameters overwrite user semantics', () => {
    expect(parsePresentationPageRequirement('必须10页PPT\n\n已确认参数：\n页数：10')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('最多10页PPT\n\n已确认参数：\n页数：10')).toEqual({ mode: 'max', targetPages: 10, maximumPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('制作经营汇报PPT\n\n已确认参数：\n页数：10')).toEqual({ mode: 'target', targetPages: 10, countBasis: 'total' });
  });

  it.each([
    '必须10页PPT\n页数不限，内容完整优先',
    '最多10页PPT\n取消页数限制',
    '8-12页PPT\n不再限制页数',
    '正文恰好10页\n正文页数不限',
    '必须10页PPT\n页数你来安排',
    '最多10页PPT\n去掉之前的页数要求'
  ])('honors the later explicit removal in %s instead of carrying a historical count', text => {
    expect(parsePresentationPageRequirement(text)).toBeUndefined();
    expect(parseRequestedPresentationTotalPages(text)).toBeUndefined();
  });

  it('does not restore a cleared count from confirmed numeric parameters or a later relaxation', () => {
    expect(parsePresentationPageRequirement('必须10页PPT\n页数不限\n已确认参数：\n页数：10')).toBeUndefined();
    expect(parsePresentationPageRequirement('最多10页PPT\n取消页数限制\n页数仅作参考')).toBeUndefined();
  });

  it.each([
    '必须10页PPT\n不要严格卡页数，内容完整优先',
    '最多10页PPT\n页数仅作参考',
    '8-12页PPT\n页数只是建议',
    '必须10页PPT\n页数不用这么严格'
  ])('relaxes %s to the existing planning goal without keeping a blocking condition', text => {
    expect(parsePresentationPageRequirement(text)).toEqual({ mode: 'target', targetPages: 10, countBasis: 'total' });
  });

  it('accepts a new numeric requirement after an explicit clearing statement', () => {
    expect(parsePresentationPageRequirement('必须10页PPT\n取消页数限制\n改成12页PPT')).toEqual({ mode: 'target', targetPages: 12, countBasis: 'total' });
    expect(parsePresentationPageRequirement('页数不限\n本次必须恰好8页PPT')).toEqual({ mode: 'exact', targetPages: 8, countBasis: 'total' });
    expect(parsePresentationPageRequirement('最多10页PPT\n页数仅作参考\n必须恰好12页PPT')).toEqual({ mode: 'exact', targetPages: 12, countBasis: 'total' });
  });

  it('retains an established requirement across confirmation-only turns', () => {
    expect(parsePresentationPageRequirement('必须10页PPT\n可以')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('最多10页PPT\n好的，开始生成')).toEqual({ mode: 'max', targetPages: 10, maximumPages: 10, countBasis: 'total' });
  });

  it('keeps quoted, referenced and historical clear statements from changing the current goal', () => {
    expect(parsePresentationPageRequirement('必须10页PPT\n文件里写着“页数不限”')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('必须10页PPT\n文件里写着‘取消页数限制’')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement("必须10页PPT\n例句是'取消页数限制'")).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('必须10页PPT\n例句是`取消页数限制`')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('最多10页PPT\n参考资料：取消页数限制')).toEqual({ mode: 'max', targetPages: 10, maximumPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('必须10页PPT\n参考资料：当前需求：页数不限')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('必须10页PPT\n例句是“当前需求：页数不限”')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('必须10页PPT\n之前说过页数不限')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('必须10页PPT\n不要取消页数限制')).toEqual({ mode: 'exact', targetPages: 10, countBasis: 'total' });
  });

  it('uses follow-up requirements and keeps authorized reference text out of the page goal', () => {
    expect(parsePresentationPageRequirement('必须10页PPT\n后续要求（与此前冲突时以此为准）：做12页左右PPT')).toEqual({ mode: 'target', targetPages: 12, countBasis: 'total' });
    expect(parsePresentationPageRequirement('10页PPT\n参考资料：原文是恰好30页PPT')).toEqual({ mode: 'target', targetPages: 10, countBasis: 'total' });
    expect(parsePresentationPageRequirement('把10页资料总结为6页PPT')).toEqual({ mode: 'target', targetPages: 6, countBasis: 'total' });
  });

  it('leaves capability limits to the application validator instead of dropping an explicit requirement', () => {
    expect(parsePresentationPageRequirement('必须100页PPT')).toEqual({ mode: 'exact', targetPages: 100, countBasis: 'total' });
  });
});
