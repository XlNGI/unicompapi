import { describe, expect, it } from 'vitest';
import {
  assessDocumentIntentPlan,
  parseDocumentIntentPlan,
  parseDocumentRevisionPlan
} from '../../src/domain';

describe('document intent plan', () => {
  it('parses a strict create plan', () => {
    const plan = parseDocumentIntentPlan({
      task: 'create',
      documentKind: 'ppt',
      topic: '季度经营复盘',
      audience: '管理层',
      purpose: '决策汇报',
      pageCount: 8,
      style: '专业简洁',
      sourcePolicy: 'internal_only',
      constraints: ['不虚构数据'],
      missing: [],
      ambiguities: [],
      confidence: 'high'
    });

    expect(plan.task).toBe('create');
    expect(plan.documentKind).toBe('ppt');
    expect(plan.pageCount).toBe(8);
  });

  it('rejects unsupported execution fields and invalid chat plans', () => {
    expect(() =>
      parseDocumentIntentPlan({
        task: 'create',
        documentKind: 'word',
        sourcePolicy: 'internal_only',
        constraints: [],
        missing: [],
        ambiguities: [],
        confidence: 'high',
        path: 'C:\\secret.docx'
      })
    ).toThrow(/unsupported field/);

    expect(() =>
      parseDocumentIntentPlan({
        task: 'chat',
        documentKind: 'ppt',
        sourcePolicy: 'internal_only',
        constraints: [],
        missing: [],
        ambiguities: [],
        confidence: 'high'
      })
    ).toThrow(/chat intent/);
  });

  it('requires clarification or confirmation according to confidence and source policy', () => {
    const low = parseDocumentIntentPlan({
      task: 'create',
      documentKind: 'auto',
      sourcePolicy: 'internal_only',
      constraints: [],
      missing: ['主题'],
      ambiguities: [],
      confidence: 'low'
    });
    expect(assessDocumentIntentPlan(low).readiness).toBe('needs_clarification');

    const web = parseDocumentIntentPlan({
      task: 'create',
      documentKind: 'ppt',
      sourcePolicy: 'mixed',
      constraints: [],
      missing: [],
      ambiguities: [],
      confidence: 'high'
    });
    expect(assessDocumentIntentPlan(web).readiness).toBe('needs_clarification');
    expect(
      assessDocumentIntentPlan(web, { externalSearchAuthorized: true }).readiness
    ).toBe('needs_confirmation');
  });
});

describe('document revision plan', () => {
  it('parses a bounded page-level revision plan', () => {
    const plan = parseDocumentRevisionPlan({
      task: 'revise',
      documentKind: 'ppt',
      target: { ordinal: 1 },
      scope: { pages: [2] },
      operations: [
        {
          operation: 'replace_page_layout',
          target: 'page:2',
          value: 'timeline'
        }
      ],
      preserve: ['pages_except_2', 'existing_data'],
      confidence: 'high',
      missing: [],
      ambiguities: []
    });

    expect(plan.operations[0]?.operation).toBe('replace_page_layout');
    expect(plan.scope.pages).toEqual([2]);
  });

  it('rejects unbounded or unsafe revision operations', () => {
    expect(() =>
      parseDocumentRevisionPlan({
        task: 'revise',
        documentKind: 'ppt',
        scope: { pages: [0] },
        operations: [
          { operation: 'run_code', target: 'all', value: 'rm -rf' }
        ],
        preserve: [],
        confidence: 'high',
        missing: [],
        ambiguities: []
      })
    ).toThrow(TypeError);

    expect(() =>
      parseDocumentRevisionPlan({
        task: 'revise',
        documentKind: 'ppt',
        scope: { pages: [1] },
        operations: [],
        preserve: [],
        confidence: 'high',
        missing: [],
        ambiguities: []
      })
    ).toThrow(/operations/);
  });
});
