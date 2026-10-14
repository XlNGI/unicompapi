import { describe, expect, it } from 'vitest';
import { applyPresentationVisualRevision, parsePresentationVisualRevisionRequest } from '../../src/application/presentation-design-revision';
import { buildFallbackPresentationDesignIR, parsePresentationDesignIR } from '../../src/domain/entities/presentation-design-contract';
import { stylePagesOutline } from '../fixtures/presentation-style-pages';

describe('bounded PPT visual revision', () => {
  it('parses scoped visual language without treating it as a content edit', () => {
    expect(parsePresentationVisualRevisionRequest('第三页更简洁一点', 7)).toEqual({
      targetPageNumbers: [3], density: 'sparse', whitespace: 'generous', component: 'none'
    });
    expect(parsePresentationVisualRevisionRequest('整份 PPT 的颜色更克制一些', 7)).toEqual({
      targetPageNumbers: [1, 2, 3, 4, 5, 6, 7], colorDirection: 'restrained'
    });
    expect(parsePresentationVisualRevisionRequest('把第四页改成科技感流程图', 7)).toEqual({
      targetPageNumbers: [4], component: 'track'
    });
    expect(parsePresentationVisualRevisionRequest('把第三页改得更漂亮', 7)).toBeUndefined();
  });

  it('changes only targeted Design IR fields and keeps content references stable', () => {
    const outline = stylePagesOutline;
    const design = parsePresentationDesignIR(buildFallbackPresentationDesignIR(outline), { outline });
    const next = applyPresentationVisualRevision({ outline, designIR: design, revision: {
      targetPageNumbers: [3], density: 'sparse', whitespace: 'generous', component: 'none'
    } });
    expect(next.pages[2].density).toBe('sparse');
    expect(next.pages[2].whitespace).toBe('generous');
    expect(next.pages[2].visualTreatment?.component).toBe('none');
    expect(next.pages[1].density).toBe(design.pages[1].density);
    expect(next.pages[2].hierarchy).toEqual(design.pages[2].hierarchy);
    expect(next.pages[2].contentRoles).toEqual(design.pages[2].contentRoles);
  });

  it.each(['不要让第三页更简洁一点', '第三页不要更简洁', '把第三章更简洁一点',
    '第三页更简洁一点，并把收入改成十亿', '第99页更简洁一点', '第三页的颜色更克制一些'])('does not widen or override this request: %s', request => {
    expect(parsePresentationVisualRevisionRequest(request, 7)).toBeUndefined();
  });
});
