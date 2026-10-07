import {
  presentationColorDirections, presentationPageRoles,
  type PresentationDesignContentRoles, type PresentationDesignEmphasis,
  type PresentationDesignGlobal, type PresentationDesignIRPage
} from '../../domain/entities/presentation-design-contract';
import type { PresentationRenderPlanStyle } from '../../domain/entities/presentation-render-plan';
import type { PresentationTemplateTokens } from './presentation-template';

/** Host-resolved paint policy. It carries no coordinates, document facts or page-order variants. */
export interface ResolvedPresentationPageStyle {
  readonly tone: PresentationDesignGlobal['visualTone'];
  readonly colorDirection: PresentationDesignGlobal['colorDirection'];
  readonly pageRole: PresentationDesignIRPage['pageRole'];
  readonly backgroundColor: string;
  readonly fontFamily: string;
  readonly textColor: string;
  readonly mutedColor: string;
  readonly headingColor: string;
  readonly accentColor: string;
  readonly secondaryAccentColor: string;
  readonly surfaceColor: string;
  readonly cardFill: string;
  readonly emphasisFill: string;
  readonly tableHeaderFill: string;
  readonly tableHeaderColor: string;
  readonly tableBodyFill: string;
  readonly borderColor: string;
  readonly chartColors: readonly string[];
  readonly emphasis: PresentationDesignEmphasis;
  readonly contentRoles: PresentationDesignContentRoles;
}

type ToneRecipe = { readonly hero: number; readonly closing: number; readonly statement: number;
  readonly metric: number; readonly evidence: number; readonly comparison: number;
  readonly card: number; readonly emphasis: number; readonly strongHero?: boolean };
const toneRecipes: Readonly<Record<PresentationDesignGlobal['visualTone'], ToneRecipe>> = {
  minimal: { hero: 0.16, closing: 0.06, statement: 0.04, metric: 0.07, evidence: 0.025, comparison: 0.045, card: 0.09, emphasis: 0.22 },
  editorial: { hero: 0.22, closing: 0.09, statement: 0.075, metric: 0.045, evidence: 0.025, comparison: 0.06, card: 0.12, emphasis: 0.30 },
  corporate: { hero: 0.20, closing: 0.075, statement: 0.05, metric: 0.08, evidence: 0.03, comparison: 0.065, card: 0.10, emphasis: 0.27 },
  technical: { hero: 0.25, closing: 0.10, statement: 0.065, metric: 0.085, evidence: 0.035, comparison: 0.075, card: 0.13, emphasis: 0.34 },
  playful: { hero: 0.27, closing: 0.12, statement: 0.08, metric: 0.09, evidence: 0.04, comparison: 0.09, card: 0.16, emphasis: 0.42 },
  cinematic: { hero: 0.25, closing: 0.12, statement: 0.09, metric: 0.07, evidence: 0.045, comparison: 0.085, card: 0.15, emphasis: 0.52, strongHero: true },
  bold: { hero: 0.30, closing: 0.13, statement: 0.10, metric: 0.09, evidence: 0.045, comparison: 0.09, card: 0.18, emphasis: 0.60, strongHero: true }
};

export function resolvePresentationPageStyle(input: {
  readonly design: PresentationDesignGlobal; readonly page: PresentationDesignIRPage;
  readonly tokens: PresentationTemplateTokens;
}): ResolvedPresentationPageStyle {
  const { design, page, tokens } = input;
  const recipe = toneRecipes[design.visualTone];
  if (!recipe || !presentationColorDirections.includes(design.colorDirection) || !presentationPageRoles.includes(page.pageRole))
    throw new TypeError('invalid_presentation_style_intent');
  const neutral = design.colorDirection === 'monochrome' || design.colorDirection === 'neutral';
  const paint = (value: string) => neutral ? grayscale(color(value)) : color(value);
  const base = paint(tokens.background);
  const surface = paint(tokens.surface);
  const text = paint(tokens.text);
  const accent = paint(tokens.accent);
  const secondary = paint(tokens.secondaryAccent);
  const muted = paint(tokens.muted);
  const backgroundColor = page.pageRole === 'hero'
    ? recipe.strongHero ? accent : mix(base, accent, recipe.hero)
    : page.pageRole === 'closing' ? mix(base, accent, recipe.closing)
      : page.pageRole === 'statement' ? mix(base, accent, recipe.statement)
        : page.pageRole === 'metric' ? mix(surface, accent, recipe.metric)
          : page.pageRole === 'evidence' ? mix(surface, accent, recipe.evidence)
            : page.pageRole === 'comparison' ? mix(base, secondary, recipe.comparison)
              : page.pageRole === 'section' ? mix(base, accent, recipe.hero * 0.7) : base;
  const emphasisWeight = design.colorDirection === 'high-contrast' ? Math.max(0.80, recipe.emphasis)
    : design.colorDirection === 'accent-led' || design.colorDirection === 'brand-led' ? Math.max(0.55, recipe.emphasis) : recipe.emphasis;
  const emphasisFill = mix(surface, accent, emphasisWeight);
  const cardFill = mix(surface, accent, recipe.card);
  const tableHeaderFill = neutral ? mix(surface, text, 0.78) : accent;
  const fontFamily = tokens.fontFamily?.trim() || 'Microsoft YaHei';
  if (fontFamily.length > 128 || /[\u0000-\u001f:/\\]/u.test(fontFamily)) throw new TypeError('invalid_presentation_style_font');
  const contentRoles = Object.freeze(Object.fromEntries(Object.entries(page.contentRoles).map(([role, refs]) =>
    [role, Object.freeze([...refs])])) as unknown as PresentationDesignContentRoles);
  const chartColors = neutral ? [mix(backgroundColor, text, 0.90), mix(backgroundColor, text, 0.65), mix(backgroundColor, text, 0.42)]
    : [accent, secondary, muted];
  return Object.freeze({
    tone: design.visualTone, colorDirection: design.colorDirection, pageRole: page.pageRole,
    backgroundColor, fontFamily,
    textColor: readableForeground(backgroundColor, text),
    mutedColor: readableForeground(backgroundColor, muted),
    headingColor: readableForeground(backgroundColor,
      design.colorDirection === 'accent-led' || design.colorDirection === 'brand-led' || design.colorDirection === 'high-contrast' ? accent : text),
    accentColor: readableForeground(backgroundColor, accent), secondaryAccentColor: secondary,
    surfaceColor: surface, cardFill, emphasisFill,
    tableHeaderFill, tableHeaderColor: readableForeground(tableHeaderFill, text),
    tableBodyFill: surface, borderColor: mix(surface, muted, 0.65),
    chartColors: Object.freeze(chartColors), emphasis: Object.freeze({ ...page.emphasis }), contentRoles
  });
}

export function compilePresentationElementStyle(input: {
  readonly pageStyle: ResolvedPresentationPageStyle; readonly contentType: 'text' | 'table' | 'chart';
  readonly sourceRef: string; readonly generated: boolean;
  readonly hierarchy: 'primary' | 'secondary' | 'supporting' | 'unassigned'; readonly role: string;
  readonly fontSize: number; readonly alignment: 'left' | 'center' | 'right' | 'justify';
  readonly verticalAlignment: 'top' | 'middle' | 'bottom';
}): PresentationRenderPlanStyle {
  const { pageStyle: page, contentType, generated } = input;
  if (!Number.isFinite(input.fontSize) || input.fontSize <= 0 || input.fontSize > 300) throw new TypeError('invalid_presentation_style_font_size');
  const matches = (refs: readonly string[]) => refs.some(ref => referenceMatches(input.sourceRef, ref));
  const metric = input.role === 'metric' || matches(page.contentRoles.metric);
  const evidence = input.role === 'evidence' || matches(page.contentRoles.evidence);
  const title = input.role === 'title' || matches(page.contentRoles.title);
  const emphasized = referenceMatches(input.sourceRef, page.emphasis.target);
  const strong = page.emphasis.strength === 'strong' || page.emphasis.strength === 'dominant';
  const primary = input.hierarchy === 'primary';
  const fill = !generated && contentType === 'text' && !title
    ? metric || (emphasized && strong && primary) || (page.pageRole === 'statement' && emphasized)
      ? page.emphasisFill
      : (evidence && primary) || (page.pageRole === 'comparison' && primary) ? page.cardFill : undefined
    : undefined;
  const preferredTextColor = generated ? page.mutedColor : emphasized || metric ? page.accentColor
    : title ? page.headingColor : input.hierarchy === 'supporting' ? page.mutedColor : page.textColor;
  const foreground = readableForeground(fill ?? page.backgroundColor, preferredTextColor);
  return Object.freeze({
    fontFamily: page.fontFamily,
    // Font metrics and geometry belong to the solver, never the paint compiler.
    fontSize: input.fontSize,
    bold: !generated && (title || primary || metric || (emphasized && strong)),
    color: foreground,
    ...(fill ? { fill } : {}), alignment: input.alignment, verticalAlignment: input.verticalAlignment,
    ...(contentType === 'table' ? { color: readableForeground(page.tableBodyFill, page.textColor),
      tableHeaderFill: page.tableHeaderFill, tableHeaderColor: page.tableHeaderColor,
      tableBodyFill: page.tableBodyFill, borderColor: page.borderColor } : {}),
    ...(contentType === 'chart' ? { chartColors: page.chartColors,
      mutedColor: readableForeground(page.backgroundColor, page.mutedColor), showLegend: false, showValues: true } : {})
  });
}

/** Exact semantic references and their children only; section[1] never matches section[10]. */
function referenceMatches(source: string, reference: string): boolean {
  return source === reference || (reference.length > 0 && source.startsWith(reference + '.'));
}
function color(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{6}$/iu.test(value)) throw new TypeError('invalid_presentation_style_color');
  return value.toUpperCase();
}
function channels(value: string): readonly number[] {
  const normalized = color(value);
  return [0, 2, 4].map(offset => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}
function hex(values: readonly number[]): string { return values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function mix(base: string, accent: string, weight: number): string {
  const start = channels(base); const end = channels(accent);
  return hex(start.map((channel, index) => channel * (1 - weight) + end[index] * weight));
}
function grayscale(value: string): string {
  const [r, g, b] = channels(value);
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return hex([gray, gray, gray]);
}
function luminance(value: string): number {
  const linear = channels(value).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(background: string, foreground: string): number {
  const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}
function readableForeground(background: string, candidate: string): string {
  if (contrast(background, candidate) >= 4.5) return candidate;
  return contrast(background, '000000') >= contrast(background, 'FFFFFF') ? '000000' : 'FFFFFF';
}
