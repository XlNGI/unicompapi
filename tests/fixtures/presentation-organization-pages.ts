import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR, type ProductionPresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';

/** Synthetic facts only. Labels and evidence are deliberately separate content atoms. */
export const organizationPagesOutline: DocumentOutline = {
  kind: 'ppt', title: '合成数据示例｜Atlas 内容组织', sections: [
    { heading: '交付方式对比', level: 1, pageKind: 'comparison', blocks: [
      { type: 'paragraph', text: '原流程' }, { type: 'paragraph', text: '重复整理资料' }, { type: 'paragraph', text: '多人反复交接' },
      { type: 'paragraph', text: '新流程' }, { type: 'paragraph', text: '统一资料入口' }, { type: 'paragraph', text: '一次核验交付' },
      { type: 'paragraph', text: '合成测试：两侧证据分别归属原流程与新流程。' }
    ] },
    { heading: '试点指标', level: 1, pageKind: 'data', blocks: [
      { type: 'paragraph', text: '客户续费率' }, { type: 'paragraph', text: '92%' },
      { type: 'paragraph', text: '交付时间' }, { type: 'paragraph', text: '缩短 35%' },
      { type: 'paragraph', text: '统计范围：24 家试点客户；以上为合成数据，仅用于布局验收。' }
    ] },
    { heading: '实施顺序', level: 1, pageKind: 'process', blocks: [
      { type: 'paragraph', text: '第一步：整理资料' }, { type: 'paragraph', text: '明确资料范围' },
      { type: 'paragraph', text: '第二步：核验结果' }, { type: 'paragraph', text: '检查文件与来源' },
      { type: 'paragraph', text: '第三步：持续改进' }, { type: 'paragraph', text: '收集反馈再修改' },
      { type: 'paragraph', text: '合成流程：顺序由关系定义，不按 group 数组位置决定。' }
    ] },
    { heading: '季度证据', level: 1, pageKind: 'data', blocks: [
      { type: 'table', header: ['指标', '合成结果'], rows: [['续费率', '92%'], ['交付时间', '缩短 35%']] },
      { type: 'paragraph', text: '合成结论：交付结果可追溯' },
      { type: 'paragraph', text: '来源说明：同一批合成客户的季度记录。' }
    ] },
    { heading: '资料与核验分别成组', level: 1, pageKind: 'insight', blocks: [
      { type: 'paragraph', text: '资料准备' }, { type: 'paragraph', text: '确认需求与范围' },
      { type: 'paragraph', text: '文件核验' }, { type: 'paragraph', text: '核对输出与版本' },
      { type: 'paragraph', text: '合成示例：同组内容形成一个可阅读单元。' }
    ] }
  ]
};
export const organizationPagesFacts = [organizationPagesOutline.title,
  ...organizationPagesOutline.sections.flatMap(section => [section.heading, ...section.blocks.flatMap(block =>
    block.type === 'paragraph' || block.type === 'quote' ? [block.text] : block.type === 'table' ? [...block.header, ...block.rows.flat()]
      : block.type === 'bullets' || block.type === 'numbered' ? [...block.items] : [])])];

export function organizationPagesDesign(): ProductionPresentationDesignIR {
  const base = buildFallbackPresentationDesignIR(organizationPagesOutline);
  const heading = (section: number) => `outline.sections[${section}].heading`;
  const refs = (section: number, indexes: readonly number[]) => indexes.map(index => `outline.sections[${section}].blocks[${index}]`);
  const header = (section: number) => ({ groupId: 'header', role: 'header', contentRefs: [heading(section)] });
  const supporting = (section: number, index: number) => ({ groupId: 'source-note', role: 'supporting', contentRefs: refs(section, [index]) });
  const organizations = [
    { schemaVersion: 1, layout: 'comparison', groups: [header(0),
      { groupId: 'side-a', role: 'comparison-side', contentRefs: refs(0, [0, 1, 2]) },
      { groupId: 'side-b', role: 'comparison-side', contentRefs: refs(0, [3, 4, 5]) }, supporting(0, 6)],
    relationships: [{ kind: 'compare', fromGroupId: 'side-a', toGroupId: 'side-b' }] },
    { schemaVersion: 1, layout: 'metrics', groups: [header(1),
      { groupId: 'retention', role: 'metric', contentRefs: refs(1, [0, 1]) },
      { groupId: 'delivery', role: 'metric', contentRefs: refs(1, [2, 3]) }, supporting(1, 4)], relationships: [] },
    { schemaVersion: 1, layout: 'sequence', groups: [header(2),
      { groupId: 'step-3', role: 'step', contentRefs: refs(2, [4, 5]) },
      { groupId: 'step-1', role: 'step', contentRefs: refs(2, [0, 1]) },
      { groupId: 'step-2', role: 'step', contentRefs: refs(2, [2, 3]) }, supporting(2, 6)],
    relationships: [{ kind: 'sequence', fromGroupId: 'step-1', toGroupId: 'step-2' },
      { kind: 'sequence', fromGroupId: 'step-2', toGroupId: 'step-3' }] },
    { schemaVersion: 1, layout: 'evidence', groups: [header(3),
      { groupId: 'quarterly-evidence', role: 'evidence', contentRefs: refs(3, [0]) },
      { groupId: 'claim', role: 'content', contentRefs: refs(3, [1]) }, supporting(3, 2)],
    relationships: [{ kind: 'supports', fromGroupId: 'quarterly-evidence', toGroupId: 'claim' }] },
    { schemaVersion: 1, layout: 'grouped', groups: [header(4),
      { groupId: 'preparation', role: 'content', contentRefs: refs(4, [0, 1]) },
      { groupId: 'verification', role: 'content', contentRefs: refs(4, [2, 3]) }, supporting(4, 4)], relationships: [] }
  ];
  const roles = ['comparison', 'metric', 'process', 'evidence', 'content'] as const;
  const compositions = [
    { principle: 'comparison', focalArea: 'center', balance: 'symmetric', flow: 'comparison' },
    { principle: 'grid', focalArea: 'center', balance: 'symmetric', flow: 'left-to-right' },
    { principle: 'timeline', focalArea: 'center', balance: 'symmetric', flow: 'sequence' },
    { principle: 'evidence-led', focalArea: 'center', balance: 'symmetric', flow: 'top-to-bottom' },
    { principle: 'grid', focalArea: 'center', balance: 'symmetric', flow: 'left-to-right' }
  ] as const;
  return parsePresentationDesignIR({ ...base, globalDesign: { ...base.globalDesign, visualTone: 'corporate',
    visualRhythm: 'varied', colorDirection: 'accent-led' }, pages: base.pages.map(page => {
      const section = page.pageNumber - 2;
      if (section < 0 || section >= organizationPagesOutline.sections.length) return page;
      const allBlocks = refs(section, organizationPagesOutline.sections[section].blocks.map((_, index) => index));
      return { ...page, pageRole: roles[section], density: 'balanced', whitespace: 'balanced',
        composition: compositions[section],
        hierarchy: { primary: [heading(section)], secondary: allBlocks.slice(0, -1), supporting: allBlocks.slice(-1) },
        contentRoles: { title: [heading(section)], body: section === 3 ? refs(section, [1]) : allBlocks.slice(0, -1),
          metric: section === 1 ? refs(section, [1, 3]) : [], evidence: [allBlocks.at(-1)!, ...(section === 3 ? refs(section, [0]) : [])],
          image: [], chart: [] },
        organization: organizations[section] };
    }) }, { outline: organizationPagesOutline });
}
