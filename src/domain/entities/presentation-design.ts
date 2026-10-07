import type { DocumentOutline } from './document-generation';
import type { PresentationPlan, PresentationSceneElementType } from './presentation-plan';

export interface PresentationDesignTheme {
  readonly fontFamily?: string;
  readonly headingColor?: string;
  readonly bodyColor?: string;
  readonly accentColor?: string;
  readonly spacingUnit?: number;
}

export interface PresentationDesignElement {
  readonly elementId: string;
  readonly type: PresentationSceneElementType;
  readonly content?: string;
  readonly assetRef?: string;
  readonly sourceRefs: readonly string[];
  readonly style: {
    readonly fontFamily?: string;
    readonly fontSize?: number;
    readonly textColor?: string;
    readonly fill?: string;
    readonly stroke?: string;
  };
}

export interface PresentationDesignPage {
  readonly pageNumber: number;
  readonly pageKind: string;
  readonly composition: string;
  readonly elements: readonly PresentationDesignElement[];
}

export interface PresentationDesignIR {
  readonly schemaVersion: 1;
  readonly templateId: string;
  readonly theme: PresentationDesignTheme;
  readonly pages: readonly PresentationDesignPage[];
}

export interface PresentationLayoutBox {
  readonly elementId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly parentId?: string;
}

export interface PresentationLayoutDiagnostic {
  readonly code: 'overlap' | 'element_overflow';
  readonly severity: 'warning' | 'error';
  readonly pageNumber: number;
  readonly elementIds: readonly string[];
  readonly message: string;
}

export interface PresentationLayoutPage {
  readonly pageNumber: number;
  readonly boxes: readonly PresentationLayoutBox[];
}

/** Legacy normalized scene-box input for temporary workflows; production uses ProductionPresentationLayoutIR. */
export interface PresentationLayoutIR {
  readonly schemaVersion: 1;
  readonly pages: readonly PresentationLayoutPage[];
  readonly diagnostics: readonly PresentationLayoutDiagnostic[];
  readonly adjustments: readonly PresentationLayoutAdjustment[];
}

export interface PresentationLayoutAdjustment {
  readonly pageNumber: number;
  readonly elementId: string;
  readonly reason: 'overflow' | 'overlap';
  readonly from: PresentationLayoutBox;
  readonly to: PresentationLayoutBox;
}

export function buildPresentationDesignIR(plan: PresentationPlan): PresentationDesignIR {
  return {
    schemaVersion: 1,
    templateId: plan.templateId,
    theme: {},
    pages: plan.pages.map((page) => ({
      pageNumber: page.pageNumber,
      pageKind: page.pageKind,
      composition: page.composition,
      elements: (sceneForPage(plan, page)?.elements ?? []).map((element) => ({
        elementId: element.elementId,
        type: element.type,
        ...(element.content !== undefined ? { content: element.content } : {}),
        ...(element.assetRef !== undefined ? { assetRef: element.assetRef } : {}),
        sourceRefs: page.sourceRefs,
        style: {
          ...(element.style?.fontFamily !== undefined ? { fontFamily: element.style.fontFamily } : {}),
          ...(element.style?.fontSize !== undefined ? { fontSize: element.style.fontSize } : {}),
          ...(element.style?.textColor !== undefined ? { textColor: element.style.textColor } : {}),
          ...(element.style?.fill !== undefined ? { fill: element.style.fill } : {}),
          ...(element.style?.stroke !== undefined ? { stroke: element.style.stroke } : {})
        }
      }))
    }))
  };
}

/** Compatibility-only geometry path. Adapt its already computed boxes at the production boundary; do not solve them again. */
export function buildPresentationLayoutIR(plan: PresentationPlan, options: { readonly autoAdjust?: boolean; readonly maxAdjustments?: number } = {}): PresentationLayoutIR {
  const diagnostics: PresentationLayoutDiagnostic[] = [];
  const adjustments: PresentationLayoutAdjustment[] = [];
  const maxAdjustments = Math.max(0, Math.min(options.maxAdjustments ?? 8, 32));
  const pages = plan.pages.map((page) => {
    const boxes: PresentationLayoutBox[] = (sceneForPage(plan, page)?.elements ?? []).map((element) => ({
      elementId: element.elementId,
      ...element.geometry,
      zIndex: element.zIndex,
      ...(element.parentId !== undefined ? { parentId: element.parentId } : {})
    }));
    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      const adjusted = options.autoAdjust === false ? box : adjustOverflow(box);
      if (adjusted !== box && adjustments.length < maxAdjustments) {
        boxes[index] = adjusted;
        adjustments.push({ pageNumber: page.pageNumber, elementId: box.elementId, reason: 'overflow', from: box, to: adjusted });
      }
      const current = boxes[index];
      if (current.x < 0 || current.y < 0 || current.width <= 0 || current.height <= 0 || current.x + current.width > 1 || current.y + current.height > 1) {
        diagnostics.push({
          code: 'element_overflow',
          severity: 'error',
          pageNumber: page.pageNumber,
          elementIds: [current.elementId],
          message: 'Layout box exceeds normalized page bounds'
        });
      }
    }
    for (let index = 0; index < boxes.length; index += 1) {
      for (let next = index + 1; next < boxes.length; next += 1) {
        const left = boxes[index];
        let right = boxes[next];
        if (left.parentId === right.elementId || right.parentId === left.elementId) continue;
        let overlapWidth = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
        let overlapHeight = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
        if (options.autoAdjust !== false && overlapWidth > 0.01 && overlapHeight > 0.01 && adjustments.length < maxAdjustments) {
          const candidate = adjustOverlap(right, left);
          boxes[next] = candidate;
          adjustments.push({ pageNumber: page.pageNumber, elementId: right.elementId, reason: 'overlap', from: right, to: candidate });
          right = candidate;
          overlapWidth = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
          overlapHeight = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
        }
        if (overlapWidth > 0.01 && overlapHeight > 0.01) {
          diagnostics.push({
            code: 'overlap',
            severity: 'warning',
            pageNumber: page.pageNumber,
            elementIds: [left.elementId, right.elementId],
            message: 'Layout boxes overlap; verify intentional layering or apply a bounded adjustment'
          });
        }
      }
    }
    return { pageNumber: page.pageNumber, boxes };
  });
  return { schemaVersion: 1, pages, diagnostics, adjustments };
}

export function applyPresentationLayoutIR(plan: PresentationPlan, layout: PresentationLayoutIR): PresentationPlan {
  const boxesByPage = new Map(layout.pages.map((page) => [page.pageNumber, new Map(page.boxes.map((box) => [box.elementId, box]))]));
  const pages = plan.pages.map((page) => {
    const boxes = boxesByPage.get(page.pageNumber);
    if (!boxes || !page.scene) return page;
    return {
      ...page,
      scene: applySceneLayout(page.scene, boxes)
    };
  });
  return {
    ...plan,
    pages,
    ...(plan.coverScene !== undefined
      ? { coverScene: applySceneLayout(plan.coverScene, boxesByPage.get(1)) }
      : {}),
    ...(plan.closingScene !== undefined
      ? { closingScene: applySceneLayout(plan.closingScene, boxesByPage.get(plan.pages.length)) }
      : {})
  };
}

export function applyPresentationLayoutToOutline(
  outline: DocumentOutline,
  plan: PresentationPlan,
  layout: PresentationLayoutIR
): DocumentOutline {
  if (outline.kind !== 'ppt') return outline;
  const adjustedPlan = applyPresentationLayoutIR(plan, layout);
  return {
    ...outline,
    ...(adjustedPlan.coverScene !== undefined ? { coverScene: adjustedPlan.coverScene } : {}),
    ...(adjustedPlan.closingScene !== undefined ? { closingScene: adjustedPlan.closingScene } : {}),
    sections: outline.sections.map((section, sectionIndex) => {
      const page = adjustedPlan.pages.find((candidate) =>
        candidate.sourceSection === `outline.sections[${sectionIndex}]` ||
        candidate.sourceSection === section.heading
      );
      if (!page?.scene || !section.scene) return section;
      return {
        ...section,
        scene: {
          ...section.scene,
          elements: section.scene.elements.map((element) => {
            const adjusted = page.scene?.elements.find((candidate) => candidate.elementId === element.elementId);
            return adjusted ? { ...element, geometry: adjusted.geometry } : element;
          })
        }
      };
    })
  };
}

function sceneForPage(
  plan: PresentationPlan,
  page: PresentationPlan['pages'][number]
): PresentationPlan['coverScene'] {
  if (page.scene !== undefined) return page.scene;
  if (page.pageNumber === 1) return plan.coverScene;
  if (page.pageNumber === plan.pages.length) return plan.closingScene;
  return undefined;
}

function applySceneLayout(
  scene: NonNullable<PresentationPlan['coverScene']>,
  boxes: ReadonlyMap<string, PresentationLayoutBox> | undefined
): NonNullable<PresentationPlan['coverScene']> {
  if (!boxes) return scene;
  return {
    ...scene,
    elements: scene.elements.map((element) => {
      const box = boxes.get(element.elementId);
      return box ? { ...element, geometry: { x: box.x, y: box.y, width: box.width, height: box.height } } : element;
    })
  };
}

function adjustOverflow(box: PresentationLayoutBox): PresentationLayoutBox {
  const width = Math.min(Math.max(box.width, 0.02), 1);
  const height = Math.min(Math.max(box.height, 0.02), 1);
  const x = Math.min(Math.max(box.x, 0), Math.max(0, 1 - width));
  const y = Math.min(Math.max(box.y, 0), Math.max(0, 1 - height));
  return x === box.x && y === box.y && width === box.width && height === box.height ? box : { ...box, x, y, width, height };
}

function adjustOverlap(box: PresentationLayoutBox, anchor: PresentationLayoutBox): PresentationLayoutBox {
  const gap = 0.015;
  const shiftedDown = { ...box, y: anchor.y + anchor.height + gap };
  if (shiftedDown.y + shiftedDown.height <= 1) return shiftedDown;
  const shiftedRight = { ...box, x: anchor.x + anchor.width + gap };
  if (shiftedRight.x + shiftedRight.width <= 1) return shiftedRight;
  return { ...box, width: Math.max(0.02, 1 - box.x - gap) };
}
