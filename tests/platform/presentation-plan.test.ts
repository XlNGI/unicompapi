import { describe, expect, it } from 'vitest';
import { buildPresentationPlanFromOutline } from '../../src/platform/documents';

describe('presentation plan builder', () => {
  it('maps outline sections through existing template and layout selectors', () => {
    const plan = buildPresentationPlanFromOutline({
      kind: 'ppt',
      title: '经营分析',
      sections: [
        {
          heading: '核心指标',
          level: 1,
          blocks: [{
            type: 'chart',
            chartKind: 'bar',
            data: [{ label: '一季度', value: 12 }]
          }],
          takeaway: '增长保持稳定'
        }
      ]
    }, {
      templateId: 'technology',
      sourceRefs: ['project:brief'],
      sectionSourceRefs: { 0: ['product:kpi'] }
    });
    expect(plan.pages).toHaveLength(3);
    expect(plan.pages[1]).toMatchObject({
      pageNumber: 2,
      sourceSection: 'outline.sections[0]',
      pageKind: 'data',
      composition: 'data',
      sourceRefs: ['project:brief', 'product:kpi']
    });
    expect(plan.pages[1].capacity.withinLimit).toBe(true);
  });

  it('marks pages outside a revision target as unchanged', () => {
    const plan = buildPresentationPlanFromOutline({
      kind: 'ppt',
      title: '报告',
      sections: [
        { heading: 'A', level: 1, blocks: [{ type: 'paragraph', text: 'a' }] },
        { heading: 'B', level: 1, blocks: [{ type: 'paragraph', text: 'b' }] }
      ]
    }, {
      revision: { baseWorkId: 'work-1', expectedRevision: 3, targetPages: [2] }
    });
    expect(plan.revision?.targetPages).toEqual([2]);
    expect(plan.pages[0].preserve).toContain('page_outside_revision_scope_unchanged');
    expect(plan.pages[1].preserve).not.toContain('page_outside_revision_scope_unchanged');
  });
});
