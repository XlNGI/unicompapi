import { describe, expect, it } from 'vitest';
import {
  documentComponentRegistry,
  getDocumentComponent,
  planDocumentComponents,
  selectSectionComponent
} from '../../src/platform/documents';

describe('document component registry', () => {
  it('keeps component identity and versions independent from themes', () => {
    expect(getDocumentComponent('title')?.version).toBe('1.0');
    expect(getDocumentComponent('title')?.variants.map((variant) => variant.id)).toEqual([
      'cover',
      'section',
      'content',
      'card'
    ]);
    expect(documentComponentRegistry.some((component) => component.id === 'timeline')).toBe(true);
  });

  it('selects bounded components from outline semantics', () => {
    expect(selectSectionComponent({
      heading: '流程',
      level: 1,
      blocks: [{ type: 'numbered', items: ['一', '二', '三'] }]
    })).toMatchObject({ id: 'timeline', version: '1.0', variant: 'horizontal' });
    expect(selectSectionComponent({
      heading: '指标',
      level: 1,
      blocks: [{ type: 'chart', chartKind: 'bar', data: [{ label: 'A', value: 1 }] }]
    }).id).toBe('chart');
    expect(selectSectionComponent({
      heading: '说明',
      level: 1,
      blocks: [{ type: 'paragraph', text: '内容' }]
    }, { hasImage: true }).id).toBe('image-text');
    expect(selectSectionComponent({
      heading: '传统方式与现在方式的区别',
      level: 1,
      blocks: [{ type: 'bullets', items: ['传统方式：人工处理', '现在方式：模型辅助'] }]
    })).toMatchObject({ id: 'comparison', variant: 'two-column' });
    expect(selectSectionComponent({
      heading: '结果评估',
      level: 1,
      blocks: [{ type: 'bullets', items: ['划分测试集验证', '关注准确率召回率', '对比基准模型'] }]
    }).id).toBe('metrics');
    expect(selectSectionComponent({
      heading: '风险与注意事项',
      level: 1,
      blocks: [{ type: 'bullets', items: ['保护隐私', '避免数据泄露'] }]
    }).id).toBe('callout');
  });

  it('plans ordinary bullet sections without consecutive duplicate components', () => {
    const plan = planDocumentComponents([
      { heading: '一', level: 1, blocks: [{ type: 'bullets', items: ['a', 'b'] }] },
      { heading: '二', level: 1, blocks: [{ type: 'bullets', items: ['c', 'd'] }] },
      { heading: '三', level: 1, blocks: [{ type: 'bullets', items: ['e', 'f'] }] },
      { heading: '结果评估', level: 1, blocks: [{ type: 'bullets', items: ['准确率'] }] },
      { heading: '四', level: 1, blocks: [{ type: 'bullets', items: ['g', 'h'] }] }
    ]);
    expect(plan.map((item) => item.id)).toEqual([
      'cards',
      'body',
      'cards',
      'metrics',
      'body'
    ]);
    expect(plan[3].reason).toBe('metrics');
  });
});
