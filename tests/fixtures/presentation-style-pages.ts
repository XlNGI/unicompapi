import type { DocumentOutline } from '../../src/domain/entities/document-generation';
import {
  buildFallbackPresentationDesignIR, parsePresentationDesignIR,
  type PresentationColorDirection, type PresentationDesignIRPage, type ProductionPresentationDesignIR
} from '../../src/domain/entities/presentation-design-contract';

/** One coherent deck and identical facts for every palette/style direction. */
export const stylePagesOutline: DocumentOutline = {
  kind: 'ppt', title: 'Atlas 试点：更快交付，保留客户', sections: [
    { heading: '用统一工作流减少重复交接', level: 1, pageKind: 'insight',
      blocks: [{ type: 'paragraph', text: '让团队把时间用于客户' }, { type: 'paragraph', text: '保持每次交付的可追溯记录' }] },
    { heading: '试点成果', level: 1, pageKind: 'data',
      blocks: [{ type: 'bullets', items: ['客户续费率达到 92%', '交付时间缩短 35%'] }, { type: 'paragraph', text: '统计范围：24 家试点客户' }] },
    { heading: '季度证据', level: 1, pageKind: 'data',
      blocks: [{ type: 'table', header: ['指标', '季度结果'], rows: [['续费率', '92%'], ['交付时间', '缩短 35%']] },
        { type: 'paragraph', text: '数据来源：同一批客户的季度运营记录' }] },
    { heading: '交付方式对比', level: 1, pageKind: 'comparison',
      blocks: [{ type: 'paragraph', text: '原流程：多人反复整理和交接' }, { type: 'paragraph', text: '新流程：统一资料并一次核验' }] },
    { heading: '推广实施步骤', level: 1, pageKind: 'process',
      blocks: [{ type: 'numbered', items: ['第一步：整理资料', '第二步：核验结果', '第三步：持续改进'] }],
      action: '下季度扩至 50 家客户' }
  ]
};

export const stylePagesRoles = ['hero', 'content', 'metric', 'evidence', 'comparison', 'process', 'closing'] as const;
export const stylePagesFacts = [
  stylePagesOutline.title,
  '让团队把时间用于客户', '保持每次交付的可追溯记录', '客户续费率达到 92%', '交付时间缩短 35%', '统计范围：24 家试点客户',
  '续费率', '92%', '交付时间', '缩短 35%', '数据来源：同一批客户的季度运营记录',
  '原流程：多人反复整理和交接', '新流程：统一资料并一次核验',
  '第一步：整理资料', '第二步：核验结果', '第三步：持续改进', '下季度扩至 50 家客户'
] as const;

export function stylePagesDesign(colorDirection: PresentationColorDirection = 'accent-led'): ProductionPresentationDesignIR {
  const base = buildFallbackPresentationDesignIR(stylePagesOutline);
  const page = (section: number, change: Partial<PresentationDesignIRPage>) => ({ ...base.pages[section + 1], ...change });
  const heading = (section: number) => `outline.sections[${section}].heading`;
  const block = (section: number, index: number) => `outline.sections[${section}].blocks[${index}]`;
  const pages: readonly PresentationDesignIRPage[] = [
    { ...base.pages[0], pageRole: 'hero', pageIntent: '用同一主题介绍试点结论',
      composition: { principle: 'single-focus', focalArea: 'center', balance: 'centered', flow: 'top-to-bottom' } },
    page(0, { pageRole: 'content', pageIntent: '清晰说明统一工作流的用途',
      hierarchy: { primary: [heading(0)], secondary: [block(0, 0)], supporting: [block(0, 1)] },
      contentRoles: { title: [heading(0)], body: [block(0, 0), block(0, 1)], metric: [], evidence: [], image: [], chart: [] },
      composition: { principle: 'stacked', focalArea: 'top', balance: 'symmetric', flow: 'top-to-bottom' } }),
    page(1, { pageRole: 'metric', pageIntent: '突出同一批客户的两项已核验指标',
      hierarchy: { primary: [`${block(1, 0)}.items[0]`], secondary: [heading(1), `${block(1, 0)}.items[1]`], supporting: [block(1, 1)] },
      contentRoles: { title: [heading(1)], body: [], metric: [`${block(1, 0)}.items[0]`, `${block(1, 0)}.items[1]`], evidence: [block(1, 1)], image: [], chart: [] },
      emphasis: { target: `${block(1, 0)}.items[0]`, strength: 'dominant' },
      composition: { principle: 'grid', focalArea: 'center', balance: 'symmetric', flow: 'left-to-right' } }),
    page(2, { pageRole: 'evidence', pageIntent: '用表格完整列出指标和来源',
      hierarchy: { primary: [block(2, 0)], secondary: [heading(2)], supporting: [block(2, 1)] },
      contentRoles: { title: [heading(2)], body: [], metric: [], evidence: [block(2, 0), block(2, 1)], image: [], chart: [] },
      emphasis: { target: block(2, 0), strength: 'strong' },
      composition: { principle: 'evidence-led', focalArea: 'center', balance: 'symmetric', flow: 'top-to-bottom' } }),
    page(3, { pageRole: 'comparison', pageIntent: '对比两种流程，不改动事实',
      hierarchy: { primary: [heading(3)], secondary: [block(3, 0), block(3, 1)], supporting: [] },
      contentRoles: { title: [heading(3)], body: [block(3, 0), block(3, 1)], metric: [], evidence: [], image: [], chart: [] },
      composition: { principle: 'comparison', focalArea: 'center', balance: 'symmetric', flow: 'comparison' } }),
    page(4, { pageRole: 'process', pageIntent: '按语义顺序呈现实施步骤',
      hierarchy: { primary: [heading(4)], secondary: [block(4, 0)], supporting: ['outline.sections[4].action'] },
      contentRoles: { title: [heading(4)], body: [block(4, 0), 'outline.sections[4].action'], metric: [], evidence: [], image: [], chart: [] },
      composition: { principle: 'timeline', focalArea: 'center', balance: 'symmetric', flow: 'sequence' } }),
    { ...base.pages[6], pageRole: 'closing', pageIntent: '用同一主题收束下一步行动',
      composition: { principle: 'single-focus', focalArea: 'center', balance: 'centered', flow: 'top-to-bottom' } }
  ];
  return parsePresentationDesignIR({ ...base, globalDesign: { ...base.globalDesign, colorDirection, visualRhythm: 'varied', visualTone: 'corporate' }, pages },
    { outline: stylePagesOutline });
}
