import { describe, expect, it } from 'vitest';
import type { PresentationDesignGlobal, PresentationDesignIRPage } from '../../src/domain/entities/presentation-design-contract';
import { presentationTemplates } from '../../src/platform/documents/presentation-template';
import { compilePresentationElementStyle, resolvePresentationPageStyle, type ResolvedPresentationPageStyle } from '../../src/platform/documents/presentation-style-compiler';

const target = 'outline.sections[1].blocks[0]';
const heading = 'outline.sections[1].heading';
const global: PresentationDesignGlobal = { visualTone: 'editorial', visualRhythm: 'steady', density: 'balanced',
  whitespace: 'balanced', typographyDirection: 'balanced', colorDirection: 'restrained' };
function page(role: PresentationDesignIRPage['pageRole'] = 'content'): PresentationDesignIRPage {
  return { pageNumber: 2, pageRole: role, pageIntent: 'Present the verified facts',
    hierarchy: { primary: [target], secondary: [heading], supporting: [] },
    composition: { principle: 'single-focus', focalArea: 'left', balance: 'asymmetric-right', flow: 'left-to-right' },
    density: 'balanced', whitespace: 'balanced', emphasis: { target, strength: 'strong' },
    contentRoles: { title: [heading], body: [target], metric: [], evidence: [], image: [], chart: [] },
    visualStrategy: 'Use controlled content hierarchy' };
}
function resolved(role: PresentationDesignIRPage['pageRole'] = 'content', design = global, template = presentationTemplates.business_minimal) {
  return resolvePresentationPageStyle({ design, page: page(role), tokens: template.tokens });
}
function element(pageStyle: ResolvedPresentationPageStyle, input: Partial<Parameters<typeof compilePresentationElementStyle>[0]> = {}) {
  return compilePresentationElementStyle({ pageStyle, contentType: 'text', sourceRef: target, generated: false,
    hierarchy: 'primary', role: 'body', fontSize: 27.64, alignment: 'left', verticalAlignment: 'top', ...input });
}
function luminance(value: string): number {
  const rgb = [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((first, second) => first - second);
  return (light + 0.05) / (dark + 0.05);
}
function grayscale(value: string): boolean { return value.slice(0, 2) === value.slice(2, 4) && value.slice(2, 4) === value.slice(4, 6); }

describe('controlled presentation paint compiler', () => {
  it('varies semantic page backgrounds without using slide number or changing one document theme', () => {
    const roles = ['hero', 'closing', 'statement', 'metric', 'evidence', 'comparison', 'content'] as const;
    const styles = roles.map(role => resolved(role));
    expect(new Set(styles.map(style => style.backgroundColor)).size).toBe(roles.length);
    expect(new Set(styles.map(style => style.tone))).toEqual(new Set(['editorial']));
    const original = page('metric');
    const moved = { ...original, pageNumber: 29 };
    expect(resolvePresentationPageStyle({ design: global, page: original, tokens: presentationTemplates.business_minimal.tokens }))
      .toEqual(resolvePresentationPageStyle({ design: global, page: moved, tokens: presentationTemplates.business_minimal.tokens }));
  });

  it('makes a low-chroma business theme visibly emphasize a metric from its actual content reference', () => {
    const selected = page('metric');
    const withMetric = { ...selected, contentRoles: { ...selected.contentRoles, metric: [target] }, emphasis: { ...selected.emphasis, strength: 'subtle' as const } };
    const style = resolvePresentationPageStyle({ design: global, page: withMetric, tokens: presentationTemplates.business_minimal.tokens });
    const metric = element(style, { hierarchy: 'supporting', role: 'body' });
    const unrelated = element(style, { sourceRef: 'outline.sections[10].blocks[0]', hierarchy: 'supporting', role: 'body' });
    expect(metric.fill).toBe(style.emphasisFill);
    expect(metric.fill).not.toBe(style.backgroundColor);
    expect(metric.bold).toBe(true);
    expect(unrelated.fill).toBeUndefined();
    expect(unrelated.bold).toBe(false);
  });

  it('uses reference relationships for a quoted evidence card and never conflates sibling references', () => {
    const selected = page('evidence');
    const withEvidence = { ...selected, emphasis: { ...selected.emphasis, strength: 'subtle' as const },
      contentRoles: { ...selected.contentRoles, evidence: [target] } };
    const style = resolvePresentationPageStyle({ design: global, page: withEvidence, tokens: presentationTemplates.work_report.tokens });
    expect(element(style).fill).toBe(style.cardFill);
    expect(element(style, { sourceRef: target + '.items[0]' }).fill).toBe(style.cardFill);
    expect(element(style, { sourceRef: 'outline.sections[10].blocks[0]' }).fill).toBeUndefined();
  });

  it('keeps generated footer text free of card fill and emphasis even when supplied as primary metric', () => {
    const style = resolved('metric');
    const footer = element(style, { sourceRef: target, generated: true, role: 'metric', fontSize: 10 });
    expect(footer).toMatchObject({ fontSize: 10, bold: false, color: style.mutedColor });
    expect(footer.fill).toBeUndefined();
  });

  it.each(['monochrome', 'neutral'] as const)('honors %s for every page, card, table and chart paint', colorDirection => {
    const style = resolved('hero', { ...global, visualTone: 'bold', colorDirection }, presentationTemplates.technology);
    const table = element(style, { contentType: 'table' });
    const chart = element(style, { contentType: 'chart' });
    const text = element(style, { role: 'metric' });
    const paints = [style.backgroundColor, style.textColor, style.mutedColor, style.headingColor, style.accentColor,
      style.secondaryAccentColor, style.surfaceColor, style.cardFill, style.emphasisFill, style.borderColor,
      table.color, table.tableHeaderFill!, table.tableHeaderColor!, table.tableBodyFill!, text.color, text.fill!,
      chart.color, chart.mutedColor!, ...chart.chartColors!];
    expect(paints.every(grayscale)).toBe(true);
  });

  it.each(['work_report', 'technology', 'business_minimal'] as const)('selects readable foregrounds on %s page, card and colored table surfaces', template => {
    for (const visualTone of ['minimal', 'editorial', 'bold'] as const) {
      const style = resolved('hero', { ...global, visualTone, colorDirection: 'accent-led' }, presentationTemplates[template]);
      const text = element(style, { role: 'metric' });
      const footer = element(style, { sourceRef: 'generated.page-number', generated: true, fontSize: 10 });
      const table = element(style, { contentType: 'table' });
      expect(contrast(style.backgroundColor, style.textColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(style.backgroundColor, footer.color)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text.fill ?? style.backgroundColor, text.color)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(table.tableHeaderFill!, table.tableHeaderColor!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(table.tableBodyFill!, table.color)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('never emits white text on a light surface after an unsuitable theme foreground', () => {
    const style = resolvePresentationPageStyle({ design: global, page: page('content'),
      tokens: { ...presentationTemplates.work_report.tokens, background: 'FFFFFF', surface: 'FFFFFF', text: 'FFFFFF', muted: 'FAFAFA', accent: 'EEEEEE' } });
    const text = element(style, { sourceRef: 'outline.sections[1].blocks[1]', hierarchy: 'secondary' });
    expect(text.color).not.toBe('FFFFFF');
    expect(contrast('FFFFFF', text.color)).toBeGreaterThanOrEqual(4.5);
  });

  it('preserves solver font size, alignment and input facts instead of inventing layout changes', () => {
    const style = resolved('comparison');
    const input = { pageStyle: style, contentType: 'text' as const, sourceRef: target, generated: false,
      hierarchy: 'primary' as const, role: 'body', fontSize: 19.375, alignment: 'right' as const, verticalAlignment: 'middle' as const,
      geometry: { x: 1, y: 2, width: 3, height: 4 }, fact: 'Do not rewrite a verified fact' };
    const before = JSON.stringify(input);
    const result = compilePresentationElementStyle(input);
    expect(result).toMatchObject({ fontSize: 19.375, alignment: 'right', verticalAlignment: 'middle' });
    expect('geometry' in result).toBe(false);
    expect('fact' in result).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
    const changedGeometryIntent = resolvePresentationPageStyle({ design: { ...global, density: 'dense', whitespace: 'minimal' },
      page: page('comparison'), tokens: presentationTemplates.business_minimal.tokens });
    expect(changedGeometryIntent).toEqual(style);
  });

  it('detaches and deeply freezes semantic references and all output paints', () => {
    const source = page('metric');
    const style = resolvePresentationPageStyle({ design: global, page: source, tokens: presentationTemplates.technology.tokens });
    Object.assign(source.emphasis, { target: 'outline.sections[9].blocks[0]' });
    Object.assign(source.contentRoles, { metric: ['outline.sections[9].blocks[0]'] });
    expect(style.emphasis.target).toBe(target);
    expect(style.contentRoles.metric).toEqual([]);
    expect(Object.isFrozen(style)).toBe(true);
    expect(Object.isFrozen(style.emphasis)).toBe(true);
    expect(Object.isFrozen(style.contentRoles)).toBe(true);
    expect(Object.values(style.contentRoles).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(style.chartColors)).toBe(true);
    expect(Object.isFrozen(element(style))).toBe(true);
  });

  it('rejects invalid host paint tokens and external font locators', () => {
    expect(() => resolvePresentationPageStyle({ design: global, page: page(), tokens: { ...presentationTemplates.work_report.tokens, accent: '#00FF00' } }))
      .toThrow('invalid_presentation_style_color');
    expect(() => resolvePresentationPageStyle({ design: global, page: page(), tokens: { ...presentationTemplates.work_report.tokens, fontFamily: 'https://remote/font.woff' } }))
      .toThrow('invalid_presentation_style_font');
    expect(() => element(resolved(), { fontSize: Number.NaN })).toThrow('invalid_presentation_style_font_size');
  });
});
