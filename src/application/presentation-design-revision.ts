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
  if (typeof requestText !== 'string' || !requestText.trim() || !Number.isSafeInteger(pageCount) || pageCount < 1) return undefined;
  const restrained = /(?:颜色|配色|色彩).{0,12}(?:克制|收敛)|(?:整份|全篇).{0,8}克制/u.test(requestText);
  const concise = /(?:更简洁|简洁一点|减少装饰|留白更多|更留白)/u.test(requestText);
  const techProcess = /(?:科技感|科技风).{0,12}流程图|流程图.{0,12}(?:科技感|科技风)/u.test(requestText);
  if (!restrained && !concise && !techProcess) return undefined;
  const requestedPages = parseRevisionTargets(requestText).filter(target => target.unit === 'page').map(target => target.ordinal);
  const targetPageNumbers = requestedPages.length ? [...new Set(requestedPages)].filter(page => page >= 1 && page <= pageCount) :
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
  if (input.revision.colorDirection !== undefined && !presentationColorDirections.includes(input.revision.colorDirection)) throw new TypeError('presentation_visual_revision_color_invalid');
  if (input.revision.density !== undefined && !presentationDesignDensities.includes(input.revision.density)) throw new TypeError('presentation_visual_revision_density_invalid');
  if (input.revision.whitespace !== undefined && !presentationDesignWhitespaces.includes(input.revision.whitespace)) throw new TypeError('presentation_visual_revision_whitespace_invalid');
  const next = parsePresentationDesignIR({
    ...design,
    globalDesign: input.revision.colorDirection === undefined ? design.globalDesign : { ...design.globalDesign, colorDirection: input.revision.colorDirection },
    pages: design.pages.map(page => {
      if (!targets.has(page.pageNumber)) return page;
      const treatment = input.revision.component === undefined ? page.visualTreatment : {
        surface: page.visualTreatment?.surface ?? 'flat', accent: page.visualTreatment?.accent ?? 'none', component: input.revision.component
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
