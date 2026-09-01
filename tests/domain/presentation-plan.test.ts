import { describe, expect, it } from 'vitest';
import { parsePresentationPlan } from '../../src/domain';

const page = {
  pageNumber: 1,
  sourceSection: 'outline.title',
  pageKind: 'cover',
  layout: 'cover',
  composition: 'cover',
  elements: [
    { elementId: 'cover-title', content: { type: 'paragraph', text: '季度汇报' } }
  ],
  capacity: {
    contentGroups: 1,
    bodyCharacters: 4,
    maxContentGroups: 0,
    maxBodyCharacters: 180,
    maxTableColumns: 5,
    minBodyFontSize: 17,
    withinLimit: false
  },
  sourceRefs: [],
  preserve: []
};

describe('presentation plan schema', () => {
  it('parses a strict, replayable plan', () => {
    const plan = parsePresentationPlan({
      kind: 'ppt',
      title: '季度汇报',
      templateId: 'work_report',
      pages: [page],
      sourceRefs: ['attachment:brief'],
      preserve: ['unplanned_pages_unchanged']
    });
    expect(plan.pages[0].sourceSection).toBe('outline.title');
  });

  it('rejects non-contiguous pages and forged capacity flags', () => {
    expect(() => parsePresentationPlan({
      kind: 'ppt',
      title: 'x',
      templateId: 'work_report',
      pages: [{ ...page, pageNumber: 2 }],
      sourceRefs: [],
      preserve: []
    })).toThrow(/page numbers/);
    expect(() => parsePresentationPlan({
      kind: 'ppt',
      title: 'x',
      templateId: 'work_report',
      pages: [{ ...page, capacity: { ...page.capacity, withinLimit: true } }],
      sourceRefs: [],
      preserve: []
    })).toThrow(/withinLimit/);
  });

  it('rejects paths in execution-facing references', () => {
    expect(() => parsePresentationPlan({
      kind: 'ppt',
      title: 'x',
      templateId: 'work_report',
      pages: [{ ...page, elements: [{ ...page.elements[0], elementId: 'C:\\secret\\file' }] }],
      sourceRefs: [],
      preserve: []
    })).toThrow(/path or URL/);
  });
});
