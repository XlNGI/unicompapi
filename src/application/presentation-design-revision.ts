import { parseRevisionTargets } from './document-revision-agent';
import {
  parsePresentationDesignIR,
  presentationDesignDensities,
  presentationDesignWhitespaces,
  presentationColorDirections,
  type PresentationDesignDensity,
  type PresentationDesignWhitespace,
  type PresentationColorDirection,
  type PresentationVisualComponent,
  type ProductionPresentationDesignIR
} from '../domain/entities/presentation-design-contract';
import type { DocumentOutline } from '../domain/entities/document-generation';

export interface PresentationVisualRevision {
  readonly targetPageNumbers: readonly number[];
  readonly colorDirection?: PresentationColorDirection;
  readonly density?: PresentationDesignDensity;
  readonly whitespace?: PresentationDesignWhitespace;
  readonly component?: PresentationVisualComponent;
}

/** Bounded local rules for explicit visual edits; ambiguous prose stays on the normal revision path. */
export function parsePresentationVisualRevisionRequest(requestText: string, pageCount: number): PresentationVisualRevision | undefined {
  if (typeof requestText !== 'string' || !requestText.trim() || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 40) return undefined;
  // Match complete explicit commands only. Negations, mixed content edits and
  // section targets must never become an implicit whole-deck visual edit.
  const command = requestText.trim().replace(/[。！!？?]$/u, '');
  const scope = /^(?:(?:请|帮我)\s*)?(?:把|将)?\s*(第\s*[0-9一二两三四五六七八九十百零〇]+\s*页|整份(?:\s*PPT)?|全篇(?:\s*PPT)?)\s*(?:的)?\s*(.*)$/iu.exec(command);
  if (!scope) return undefined;
  const restrained = /^(?:颜色|配色|色彩)(?:改成|改为|调整为)?(?:更)?(?:克制|收敛)(?:一些|一点)?$/u.test(scope[2]);
  const concise = /^(?:改成|改为)?(?:更简洁(?:一些|一点)?|简洁一点|减少装饰|留白更多|更留白)$/u.test(scope[2]);
  const techProcess = /^(?:改成|改为)?(?:科技感|科技风)流程图$/u.test(scope[2]);
  if (!restrained && !concise && !techProcess) return undefined;
  const requestedPages = parseRevisionTargets(scope[1]).filter(target => target.unit === 'page').map(target => target.ordinal);
  if (requestedPages.some(page => page < 1 || page > pageCount) || (restrained && requestedPages.length)) return undefined;
  const targetPageNumbers = requestedPages.length ? requestedPages :
    Array.from({ length: pageCount }, (_value, index) => index + 1);
  if (targetPageNumbers.length === 0) return undefined;
  return {
    targetPageNumbers,
    ...(restrained ? { colorDirection: 'restrained' as const } : {}),
    ...(concise ? { density: 'sparse' as const, whitespace: 'generous' as const, component: 'none' as const } : {}),
    ...(techProcess ? { component: 'track' as const } : {})
  };
}

/** Applies only the requested visual fields; content references and page identities remain untouched. */
export function applyPresentationVisualRevision(input: {
  readonly outline: DocumentOutline;
  readonly designIR: ProductionPresentationDesignIR;
  readonly revision: PresentationVisualRevision;
}): ProductionPresentationDesignIR {
  const design = parsePresentationDesignIR(input.designIR, { outline: input.outline });
  const targets = new Set(input.revision.targetPageNumbers);
  if (targets.size === 0 || [...targets].some(page => !Number.isSafeInteger(page) || page < 1 || page > design.pages.length)) {
    throw new TypeError('presentation_visual_revision_target_invalid');
  }
  if (input.revision.colorDirection !== undefined && targets.size !== design.pages.length) throw new TypeError('presentation_visual_revision_color_scope_invalid');
  if (input.revision.component === 'track' && design.pages.some(page => targets.has(page.pageNumber) &&
    page.pageRole !== 'process')) throw new TypeError('presentation_visual_revision_process_required');
  if (input.revision.colorDirection !== undefined && !presentationColorDirections.includes(input.revision.colorDirection)) throw new TypeError('presentation_visual_revision_color_invalid');
  if (input.revision.density !== undefined && !presentationDesignDensities.includes(input.revision.density)) throw new TypeError('presentation_visual_revision_density_invalid');
  if (input.revision.whitespace !== undefined && !presentationDesignWhitespaces.includes(input.revision.whitespace)) throw new TypeError('presentation_visual_revision_whitespace_invalid');
  const next = parsePresentationDesignIR({
    ...design,
    globalDesign: input.revision.colorDirection === undefined ? design.globalDesign : { ...design.globalDesign, colorDirection: input.revision.colorDirection },
    pages: design.pages.map(page => {
      if (!targets.has(page.pageNumber)) return page;
      const treatment = input.revision.component === undefined ? page.visualTreatment : {
        surface: input.revision.component === 'none' ? 'flat' : page.visualTreatment?.surface ?? 'flat',
        accent: input.revision.component === 'none' ? 'none' : page.visualTreatment?.accent ?? 'none', component: input.revision.component
      };
      return {
        ...page,
        ...(input.revision.density === undefined ? {} : { density: input.revision.density }),
        ...(input.revision.whitespace === undefined ? {} : { whitespace: input.revision.whitespace }),
        ...(treatment ? { visualTreatment: treatment } : {})
      };
    })
  }, { outline: input.outline });
  if (JSON.stringify(design) === JSON.stringify(next)) throw new TypeError('presentation_visual_revision_unchanged');
  return next;
}
