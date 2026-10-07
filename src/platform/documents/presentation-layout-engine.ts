import {
  parsePresentationLayoutConstraintModel,
  type PresentationElementConstraint,
  type PresentationLayoutConstraintModel,
  type PresentationLayoutDensity,
  type PresentationLayoutRegion,
  type PresentationPageConstraint,
  type PresentationPageFeatures,
  type ResolvedPresentationContentOrganization
} from '../../domain/entities/presentation-layout-constraints';

export type PresentationLayoutComposition = 'single-focus' | 'comparison' | 'evidence-led' | 'sequence' | 'structured';
export type PresentationLayoutDiagnosticCode =
  | 'layout_overflow'
  | 'layout_overlap'
  | 'content_too_dense'
  | 'font_below_minimum'
  | 'unsupported_content_type'
  | 'unsatisfied_constraint'
  | 'invalid_region';

export interface PresentationLayoutGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PresentationLayoutPlacement {
  readonly groupId?: string;
  readonly sourceRef: string;
  readonly role: PresentationElementConstraint['role'];
  readonly hierarchy: PresentationElementConstraint['hierarchy'];
  readonly region: PresentationLayoutRegion;
  readonly geometry: PresentationLayoutGeometry;
  readonly fontSize: number;
  readonly alignment: PresentationElementConstraint['alignment'];
  readonly zIndex: number;
}

export interface PresentationLayoutPageResult {
  readonly pageNumber: number;
  readonly pageRole: PresentationPageFeatures['pageRole'];
  readonly composition: PresentationLayoutComposition;
  readonly selectedLayout: 'weighted-regions' | 'adaptive-grid' | 'flow-track';
  readonly density: PresentationLayoutDensity;
  readonly whitespace: 'minimal' | 'balanced' | 'generous';
  readonly primaryRegion: PresentationLayoutRegion;
  readonly placements: readonly PresentationLayoutPlacement[];
  readonly geometrySignature: string;
  readonly contentOrganization?: ResolvedPresentationContentOrganization;
}

export interface PresentationLayoutDiagnostic {
  readonly code: PresentationLayoutDiagnosticCode;
  readonly pageNumber: number;
  readonly sourceRef?: string;
}

export interface PresentationLayoutResult {
  readonly status: 'success' | 'failed';
  readonly pages: readonly PresentationLayoutPageResult[];
  readonly diagnostics: readonly PresentationLayoutDiagnostic[];
}

export type PresentationLayoutRepairAction = 'reduce_gap' | 'rebalance_regions' | 'reduce_font_size' | 'compatible_composition';

export interface PresentationLayoutRepairResult extends PresentationLayoutResult {
  readonly repairCount: number;
  readonly repairs: readonly { readonly attempt: number; readonly action: PresentationLayoutRepairAction; readonly pages: readonly number[] }[];
  readonly constraints: PresentationLayoutConstraintModel;
}

interface LayoutGroup {
  readonly kind: 'primary' | 'supporting' | 'secondary' | 'sequence';
  readonly items: readonly PresentationElementConstraint[];
}

interface MutablePlacement {
  readonly groupId?: string;
  readonly element: PresentationElementConstraint;
  readonly region: PresentationLayoutRegion;
  readonly geometry: PresentationLayoutGeometry;
  readonly fontSize: number;
}

interface OrganizedLayoutCell {
  readonly element: PresentationElementConstraint;
  readonly geometry: PresentationLayoutGeometry;
  readonly region: PresentationLayoutRegion;
  readonly groupId?: string;
}

const MIN_GEOMETRY = 0.005;
/** Deterministic constraint-driven layout. It computes weighted regions and tracks, not template coordinates. */
export function solvePresentationLayout(
  features: readonly PresentationPageFeatures[],
  candidate: PresentationLayoutConstraintModel
): PresentationLayoutResult {
  const refsByPage = features.map(page => ({ pageNumber: page.pageNumber, sourceRefs: page.units.map(unit => unit.sourceRef) }));
  let constraints: PresentationLayoutConstraintModel;
  try {
    constraints = parsePresentationLayoutConstraintModel(candidate, {
      expectedPageCount: features.length,
      validSourceRefsByPage: refsByPage
    });
  } catch {
    return { status: 'failed', pages: [], diagnostics: features.map(page => ({ code: 'unsatisfied_constraint', pageNumber: page.pageNumber })) };
  }
  if (features.length !== constraints.pages.length || features.some((page, index) => page.pageNumber !== constraints.pages[index]?.pageNumber)) {
    return { status: 'failed', pages: [], diagnostics: features.map(page => ({ code: 'unsatisfied_constraint', pageNumber: page.pageNumber })) };
  }

  const pages: PresentationLayoutPageResult[] = [];
  const diagnostics: PresentationLayoutDiagnostic[] = [];
  constraints.pages.forEach((page, index) => {
    const feature = features[index];
    const solved = solvePage(feature, page, constraints.canvas);
    pages.push(...(solved.page ? [solved.page] : []));
    diagnostics.push(...solved.diagnostics);
  });
  return { status: diagnostics.length === 0 && pages.length === constraints.pages.length ? 'success' : 'failed', pages, diagnostics };
}

/** Runs four deterministic, local constraint repairs at most; unsupported types bypass repair. */
export function solvePresentationLayoutWithRepair(
  features: readonly PresentationPageFeatures[],
  source: PresentationLayoutConstraintModel
): PresentationLayoutRepairResult {
  const actions: readonly PresentationLayoutRepairAction[] = ['reduce_gap', 'rebalance_regions', 'reduce_font_size', 'compatible_composition'];
  let constraints = source;
  let result = solvePresentationLayout(features, constraints);
  const repairs: Array<{ readonly attempt: number; readonly action: PresentationLayoutRepairAction; readonly pages: readonly number[] }> = [];
  for (const action of actions) {
    if (result.status === 'success' || result.diagnostics.some(item => item.code === 'unsupported_content_type' || item.code === 'invalid_region')) break;
    const failedPages = [...new Set(result.diagnostics.map(item => item.pageNumber))].sort((left, right) => left - right);
    if (failedPages.length === 0) break;
    const next = applyRepair(constraints, failedPages, action);
    if (next === constraints) break;
    constraints = next;
    repairs.push({ attempt: repairs.length + 1, action, pages: failedPages });
    result = solvePresentationLayout(features, constraints);
  }
  return { ...result, repairCount: repairs.length, repairs, constraints };
}

function applyRepair(
  model: PresentationLayoutConstraintModel,
  pageNumbers: readonly number[],
  action: PresentationLayoutRepairAction
): PresentationLayoutConstraintModel {
  const targets = new Set(pageNumbers);
  let changed = false;
  const pages = model.pages.map(page => {
    if (!targets.has(page.pageNumber)) return page;
    if (action === 'reduce_gap') {
      if (page.preferredGap <= page.minimumGap) return page;
      changed = true;
      return { ...page, preferredGap: page.minimumGap };
    }
    if (action === 'rebalance_regions') {
      if (page.designIntent.composition.balance === 'weighted') return page;
      changed = true;
      return { ...page, designIntent: { ...page.designIntent, composition: { ...page.designIntent.composition, balance: 'weighted' as const } } };
    }
    if (action === 'reduce_font_size') {
      let pageChanged = false;
      const elements = page.elements.map(element => {
        if (element.preferredFontSize <= element.minimumFontSize) return element;
        pageChanged = true;
        return { ...element, preferredFontSize: Math.max(element.minimumFontSize, element.preferredFontSize - 2) };
      });
      if (!pageChanged) return page;
      changed = true;
      return { ...page, elements };
    }
    if (page.pageRole === 'process' || page.pageRole === 'comparison' || page.pageRole === 'evidence' ||
      page.designIntent.composition.principle === 'timeline' || page.designIntent.composition.principle === 'comparison' ||
      page.designIntent.composition.principle === 'evidence-led') return page;
    if (page.designIntent.composition.principle === 'stacked' && page.density === 'dense') return page;
    changed = true;
    return { ...page, density: 'dense' as const, preferredGap: page.minimumGap,
      designIntent: { ...page.designIntent, composition: { ...page.designIntent.composition, principle: 'stacked' as const } } };
  });
  return changed ? { ...model, pages } : model;
}

function solvePage(
  features: PresentationPageFeatures,
  page: PresentationPageConstraint,
  canvas: PresentationLayoutConstraintModel['canvas']
): { readonly page?: PresentationLayoutPageResult; readonly diagnostics: readonly PresentationLayoutDiagnostic[] } {
  const diagnostics: PresentationLayoutDiagnostic[] = [];
  if (features.hasImage) return { diagnostics: [{ code: 'unsupported_content_type', pageNumber: page.pageNumber }] };
  if (page.elements.length === 0 || page.elements.length > page.maximumElementCount) {
    return { diagnostics: [{ code: 'content_too_dense', pageNumber: page.pageNumber }] };
  }
  const pageNumberElement = page.elements.find(element => element.sourceRef === 'generated.page-number');
  const contentPage: PresentationPageConstraint = pageNumberElement
    ? { ...page, elements: page.elements.filter(element => element !== pageNumberElement) }
    : page;
  const area = pageArea(page, canvas, pageNumberElement !== undefined);
  if (!validGeometry(area)) return { diagnostics: [{ code: 'invalid_region', pageNumber: page.pageNumber }] };

  const organization = contentPage.contentOrganization;
  const composition = organization ? organizationComposition(organization.layout) : selectComposition(features, contentPage);
  const focusRef = contentPage.designIntent.emphasis.target;
  const groups = buildGroups(features, contentPage, composition, focusRef);
  const axis = selectAxis(contentPage, composition, area);
  const gap = effectiveGap(contentPage, features);
  const orderedGroups = orderGroupsForFocal(groups, contentPage, axis);
  const groupBoxes = allocateGroupBoxes(orderedGroups, area, axis, gap, contentPage);
  const placements: MutablePlacement[] = [];

  const cells: readonly OrganizedLayoutCell[] | undefined = organization ? buildOrganizedCells(contentPage, area, gap) : orderedGroups.flatMap((group, groupIndex) => {
    const box = groupBoxes[groupIndex];
    return box ? layoutGroup(group.items, box, gap, contentPage, composition).map(cell => ({ ...cell, region: regionFor(cell.element, group.kind, page) })) : [];
  });
  if (cells === undefined) return { diagnostics: [{ code: 'unsatisfied_constraint', pageNumber: page.pageNumber }] };
  for (const cell of cells) {
      if (!validGeometry(cell.geometry) || !inside(cell.geometry, area)) {
        diagnostics.push({ code: 'layout_overflow', pageNumber: page.pageNumber, sourceRef: cell.element.sourceRef });
        continue;
      }
      const fontSize = fitFontSize(cell.element, cell.geometry);
      if (fontSize === undefined) {
        diagnostics.push({ code: 'font_below_minimum', pageNumber: page.pageNumber, sourceRef: cell.element.sourceRef });
        continue;
      }
      placements.push({ element: cell.element, region: cell.region, geometry: cell.geometry, fontSize,
        ...(cell.groupId ? { groupId: cell.groupId } : {}) });
    }

  if (pageNumberElement) {
    const footer: PresentationLayoutGeometry = {
      x: canvas.width - page.safeArea.rightInset - pageNumberElement.preferredWidth,
      y: canvas.height - page.safeArea.bottomInset - pageNumberElement.preferredHeight,
      width: pageNumberElement.preferredWidth,
      height: pageNumberElement.preferredHeight
    };
    placements.push({ element: pageNumberElement, region: 'bottom', geometry: footer, fontSize: pageNumberElement.preferredFontSize });
  }

  if (placements.length !== page.elements.length) {
    if (diagnostics.length === 0) diagnostics.push({ code: 'unsatisfied_constraint', pageNumber: page.pageNumber });
    return { diagnostics };
  }
  if (hasOverlap(placements)) diagnostics.push({ code: 'layout_overlap', pageNumber: page.pageNumber });
  if (placements.some(item => item.fontSize < item.element.minimumFontSize)) {
    diagnostics.push({ code: 'font_below_minimum', pageNumber: page.pageNumber });
  }
  if (diagnostics.length > 0) return { diagnostics };

  const ordered = [...placements].sort((left, right) => {
    const regionOrder = groupRegionOrder(left.region) - groupRegionOrder(right.region);
    return regionOrder || right.element.priority - left.element.priority || left.element.sourceRef.localeCompare(right.element.sourceRef);
  });
  const output: PresentationLayoutPlacement[] = ordered.map((item, zIndex) => ({
    sourceRef: item.element.sourceRef,
    role: item.element.role,
    hierarchy: item.element.hierarchy,
    region: item.region,
    geometry: roundGeometry(item.geometry),
    fontSize: round(item.fontSize, 1),
    alignment: item.element.alignment,
    zIndex,
    ...(item.groupId ? { groupId: item.groupId } : {})
  }));
  const primary = output.find(item => item.hierarchy === 'primary') ?? output[0];
  const selectedLayout = composition === 'sequence' ? 'flow-track' : composition === 'structured' ? 'adaptive-grid' : 'weighted-regions';
  return {
    page: {
      pageNumber: page.pageNumber,
      pageRole: page.pageRole,
      composition,
      selectedLayout,
      density: page.density,
      whitespace: page.designIntent.whitespace,
      primaryRegion: primary?.region ?? 'center',
      placements: output,
      geometrySignature: geometrySignature(output),
      ...(organization ? { contentOrganization: organization } : {})
    },
    diagnostics
  };
}

function organizationComposition(layout: ResolvedPresentationContentOrganization['layout']): PresentationLayoutComposition {
  return layout === 'metrics' || layout === 'grouped' ? 'structured' : layout === 'sequence' ? 'sequence'
    : layout === 'evidence' ? 'evidence-led' : 'comparison';
}

/** Group slots are semantic objects, independent of typography hierarchy or focal weighting. */
function buildOrganizedCells(page: PresentationPageConstraint, area: PresentationLayoutGeometry, gap: number): readonly OrganizedLayoutCell[] | undefined {
  const organization = page.contentOrganization!;
  type Group = ResolvedPresentationContentOrganization['groups'][number];
  const elements = new Map(page.elements.map(element => [element.sourceRef, element]));
  const parent = new Map(organization.relationships.filter(relation => relation.kind === 'supports').map(relation => [relation.fromGroupId, relation.toGroupId]));
  const owner = (group: Group): string | undefined => {
    let current = group.groupId;
    for (let step = 0; step <= organization.groups.length; step += 1) {
      const next = parent.get(current);
      if (!next) return current;
      current = next;
    }
    return undefined;
  };
  const ownerIds = new Map(organization.groups.map(group => [group.groupId, owner(group)]));
  if ([...ownerIds.values()].some(value => value === undefined)) return undefined;
  const roots = organization.groups.filter(group => !parent.has(group.groupId) && group.role !== 'header');
  const cluster = (root: Group): Group[] => [root, ...organization.groups.filter(group => group !== root && ownerIds.get(group.groupId) === root.groupId)];
  const items = (groups: readonly Group[]) => groups.flatMap(group => group.sourceRefs.map(ref => ({ groupId: group.groupId, element: elements.get(ref)! })));
  if (organization.groups.some(group => group.sourceRefs.some(ref => !elements.has(ref)))) return undefined;
  const measureHeight = (element: PresentationElementConstraint, width: number): number => {
    const font = Math.max(element.minimumFontSize, Math.floor(element.preferredFontSize));
    if (element.role === 'chart') return Math.max(element.minHeight, 1.55);
    if (element.role === 'table' && element.tableCellWidthsEm && element.tableColumns) {
      return Math.max(element.minHeight, estimateTableHeight(element.tableCellWidthsEm, element.tableColumns, width, Math.min(font, 16)));
    }
    const lines = Math.max(1, Math.ceil(element.estimatedTextWidthEm * font / 72 / Math.max(0.1, width - 0.12)));
    return Math.max(element.minHeight, lines * font / 72 * 1.28 + 0.061);
  };
  const compactTracks = (rows: readonly (readonly PresentationElementConstraint[])[], width: number, height: number): number[] => {
    const minimums = rows.map(row => Math.max(...row.map(element => element.minHeight)));
    const preferred = rows.map(row => Math.max(...row.map(element => measureHeight(element, width))));
    const available = height - gap * Math.max(0, rows.length - 1);
    const minTotal = minimums.reduce((sum, value) => sum + value, 0), prefTotal = preferred.reduce((sum, value) => sum + value, 0);
    if (prefTotal <= available) return preferred;
    const factor = Math.max(0, Math.min(1, (available - minTotal) / Math.max(0.001, prefTotal - minTotal)));
    return minimums.map((minimum, index) => minimum + (preferred[index] - minimum) * factor);
  };
  const stack = (groups: readonly Group[], box: PresentationLayoutGeometry, region: PresentationLayoutRegion,
    sharedTracks?: readonly number[]): OrganizedLayoutCell[] => {
    const members = items(groups);
    const heights = sharedTracks ?? compactTracks(members.map(member => [member.element]), box.width, box.height);
    const positions = offsets(heights, box.y, gap);
    return members.map((member, index) => {
      const cell = { x: box.x, y: positions[index], width: box.width, height: heights[index] };
      const geometry = fitCellGeometry({ ...member.element, preferredRegion: page.pageRole === 'hero' || page.pageRole === 'closing' ? 'center' : 'top' }, cell,
        { ...page, designIntent: { ...page.designIntent, composition: { ...page.designIntent.composition,
          focalArea: page.pageRole === 'hero' || page.pageRole === 'closing' ? 'center' : 'top' } } });
      return { ...member, geometry, region };
    });
  };
  // A cover or closing headline remains centered; "header" here is its source
  // classification, not a mandatory business-page top bar.
  if (page.pageRole === 'hero' || page.pageRole === 'closing') return stack(organization.groups, area, 'center');
  const headers = organization.groups.filter(group => group.role === 'header');
  const mainRole = organization.layout === 'comparison' ? 'comparison-side' : organization.layout === 'metrics' ? 'metric'
    : organization.layout === 'sequence' ? 'step' : organization.layout === 'evidence' ? 'evidence' : undefined;
  // "Evidence supports claim" is directed evidence -> claim. The claim owns
  // the cohesive region, whose semantic type comes from all its members.
  let main = roots.filter(group => mainRole ? cluster(group).some(member => member.role === mainRole) : group.role !== 'supporting');
  const notes = roots.filter(group => !main.includes(group)).flatMap(cluster);
  if (!main.length || (organization.layout === 'comparison' && main.length < 2)) return undefined;
  const sequenceEdges = organization.relationships.filter(relation => relation.kind === 'sequence').map(relation => ({
    from: ownerIds.get(relation.fromGroupId), to: ownerIds.get(relation.toGroupId) }));
  if (sequenceEdges.some(relation => !main.some(group => group.groupId === relation.from) || !main.some(group => group.groupId === relation.to))) return undefined;
  if (organization.layout === 'sequence') {
    const pending = new Set(main.map(group => group.groupId));
    const ordered: Group[] = [];
    while (pending.size) {
      const next = main.find(group => pending.has(group.groupId) && !sequenceEdges.some(relation =>
        relation.from !== relation.to && relation.to === group.groupId && relation.from !== undefined && pending.has(relation.from)));
      if (!next) return undefined;
      ordered.push(next); pending.delete(next.groupId);
    }
    main = ordered;
  }
  const stackHeight = (groups: readonly Group[]) => items(groups).reduce((sum, member) => {
    const element = member.element;
    const lines = Math.max(1, Math.ceil(element.estimatedTextWidthEm * element.preferredFontSize / 72 / Math.max(0.1, area.width - 0.12)));
    return sum + Math.max(element.minHeight, Math.min(element.maxHeight, lines * element.preferredFontSize / 72 * 1.28 + 0.06));
  }, 0) + Math.max(0, items(groups).length - 1) * gap;
  const headerHeight = headers.length ? Math.min(area.height * 0.25, stackHeight(headers)) : 0;
  const noteHeight = notes.length ? Math.min(area.height * 0.42, stackHeight(notes)) : 0;
  const body: PresentationLayoutGeometry = { x: area.x, y: area.y + headerHeight + (headers.length ? gap : 0), width: area.width,
    height: area.height - headerHeight - noteHeight - (headers.length ? gap : 0) - (notes.length ? gap : 0) };
  if (!validGeometry(body)) return undefined;
  const cells = headers.length ? stack(headers, { ...area, height: headerHeight }, 'top') : [];
  const vertical = (organization.layout === 'comparison' || organization.layout === 'sequence') && page.designIntent.composition.flow === 'top-to-bottom';
  const columns = vertical ? 1 : organization.layout === 'comparison' ? main.length
    : organization.layout === 'sequence' ? Math.min(main.length, Math.max(1, Math.floor((body.width + gap) /
      (Math.max(...main.map(group => Math.max(...items(cluster(group)).map(member => member.element.minWidth)))) + gap))))
      : organization.layout === 'evidence' ? Math.min(2, main.length) : main.length <= 3 ? main.length : Math.min(3, Math.ceil(Math.sqrt(main.length)));
  const rows = Math.ceil(main.length / columns);
  const width = (body.width - gap * (columns - 1)) / columns;
  const height = (body.height - gap * (rows - 1)) / rows;
  if (width <= 0 || height <= 0) return undefined;
  const sharedByRow = new Map<number, readonly number[]>();
  if (columns > 1 && (organization.layout === 'comparison' || organization.layout === 'metrics')) {
    for (let row = 0; row < rows; row += 1) {
      const members = main.slice(row * columns, (row + 1) * columns).map(group => items(cluster(group)));
      const count = Math.max(...members.map(group => group.length));
      const tracks = Array.from({ length: count }, (_, index) => members.flatMap(group => group[index] ? [group[index].element] : []));
      sharedByRow.set(row, compactTracks(tracks, width, height));
    }
  }
  main.forEach((group, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const box = { x: body.x + column * (width + gap), y: body.y + row * (height + gap), width, height };
    const region = vertical ? row === 0 ? 'top' : 'bottom' : columns > 1 ? column === 0 ? 'left' : column === columns - 1 ? 'right' : 'center' : 'center';
    cells.push(...stack(cluster(group), box, region, sharedByRow.get(row)));
  });
  if (notes.length) cells.push(...stack(notes, { x: area.x, y: area.y + area.height - noteHeight, width: area.width, height: noteHeight }, 'bottom'));
  if (cells.length !== page.elements.length || new Set(cells.map(cell => cell.element.sourceRef)).size !== cells.length) return undefined;
  return cells;
}

function selectComposition(features: PresentationPageFeatures, page: PresentationPageConstraint): PresentationLayoutComposition {
  const principle = page.designIntent.composition.principle;
  if (page.pageRole === 'process' || principle === 'timeline' || page.designIntent.composition.flow === 'sequence') return 'sequence';
  if (page.pageRole === 'comparison' || principle === 'comparison' || principle === 'split') return 'comparison';
  if (page.pageRole === 'evidence' || principle === 'evidence-led') return 'evidence-led';
  if (page.density === 'dense' || features.contentDensity === 'dense' || principle === 'grid' || principle === 'stacked') return 'structured';
  if (features.comparisonCandidate) return 'comparison';
  return 'single-focus';
}

function buildGroups(
  features: PresentationPageFeatures,
  page: PresentationPageConstraint,
  composition: PresentationLayoutComposition,
  focusRef: string
): LayoutGroup[] {
  const all = [...page.elements].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  if (composition === 'sequence') return [{ kind: 'sequence', items: orderByRelationships(orderByOutline(all, features.units), page.relationships) }];

  let primary: PresentationElementConstraint[];
  let supporting: PresentationElementConstraint[];
  if (composition === 'evidence-led') {
    primary = all.filter(item => item.sourceRef === focusRef || item.role === 'evidence' || item.role === 'chart' || item.role === 'table');
    supporting = all.filter(item => !primary.includes(item));
    if (primary.length === 0) primary = choosePrimary(all);
    supporting = all.filter(item => !primary.includes(item));
  } else if (composition === 'comparison' || composition === 'structured') {
    primary = all.filter(item => item.hierarchy === 'primary');
    supporting = all.filter(item => !primary.includes(item));
    if (primary.length === 0) primary = choosePrimary(all);
    if (supporting.length === 0 && primary.length > 1 && composition === 'comparison') {
      supporting = primary.splice(Math.ceil(primary.length / 2));
    }
  } else {
    const exactFocus = all.find(item => item.sourceRef === focusRef);
    primary = exactFocus ? [exactFocus] : choosePrimary(all);
    supporting = all.filter(item => !primary.includes(item));
  }

  const linkedAbove = page.relationships.some(relationship => relationship.kind === 'above' &&
    primary.some(element => element.sourceRef === relationship.fromRef) &&
    supporting.some(element => element.sourceRef === relationship.toRef));
  if (linkedAbove) {
    primary = [...primary, ...supporting];
    supporting = [];
  }

  if (composition === 'structured') {
    const secondary = supporting.filter(item => item.hierarchy === 'secondary');
    const tertiary = supporting.filter(item => item.hierarchy !== 'secondary');
    if (primary.length > 0 && secondary.length > 0 && tertiary.length > 0) {
      const groups: LayoutGroup[] = [
        { kind: 'primary', items: orderByRelationships(primary, page.relationships) },
        { kind: 'secondary', items: orderByRelationships(secondary, page.relationships) },
        { kind: 'supporting', items: orderByRelationships(tertiary, page.relationships) }
      ];
      return groups;
    }
  }

  const focal = page.designIntent.composition.focalArea;
  if (focal === 'center' && supporting.length >= 2) {
    const midpoint = Math.ceil(supporting.length / 2);
    const centeredGroups: LayoutGroup[] = [
      { kind: 'supporting', items: orderByRelationships(supporting.slice(0, midpoint), page.relationships) },
      { kind: 'primary', items: orderByRelationships(primary, page.relationships) },
      { kind: 'secondary', items: orderByRelationships(supporting.slice(midpoint), page.relationships) }
    ];
    return centeredGroups.filter(group => group.items.length > 0);
  }
  const groups: LayoutGroup[] = [
    ...(primary.length > 0 ? [{ kind: 'primary' as const, items: orderByRelationships(primary, page.relationships) }] : []),
    ...(supporting.length > 0 ? [{ kind: 'supporting' as const, items: orderByRelationships(supporting, page.relationships) }] : [])
  ];
  return groups;
}

function choosePrimary(items: readonly PresentationElementConstraint[]): PresentationElementConstraint[] {
  const selected = [...items].sort((left, right) => {
    const hierarchy = hierarchyRank(left.hierarchy) - hierarchyRank(right.hierarchy);
    return hierarchy || right.priority - left.priority || left.sourceRef.localeCompare(right.sourceRef);
  })[0];
  return selected ? [selected] : [];
}

function orderByOutline(items: readonly PresentationElementConstraint[], units: PresentationPageFeatures['units']): PresentationElementConstraint[] {
  const order = new Map(units.map((unit, index) => [unit.sourceRef, index]));
  return [...items].sort((left, right) => (order.get(left.sourceRef) ?? 0) - (order.get(right.sourceRef) ?? 0));
}

function orderByRelationships(
  items: readonly PresentationElementConstraint[],
  relationships: PresentationPageConstraint['relationships']
): PresentationElementConstraint[] {
  if (items.length < 2) return [...items];
  const index = new Map(items.map((item, itemIndex) => [item.sourceRef, itemIndex]));
  const edges = new Map(items.map(item => [item.sourceRef, new Set<string>()]));
  for (const relationship of relationships) {
    const fromIndex = index.get(relationship.fromRef);
    const toIndex = index.get(relationship.toRef);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) continue;
    if (relationship.kind === 'above' || relationship.kind === 'near' || relationship.kind === 'paired' || relationship.kind === 'supports') {
      edges.get(relationship.fromRef)!.add(relationship.toRef);
    } else if (relationship.kind === 'align' && fromIndex > toIndex) {
      edges.get(relationship.toRef)!.add(relationship.fromRef);
    }
  }
  const indegree = new Map(items.map(item => [item.sourceRef, 0]));
  edges.forEach(targets => targets.forEach(target => indegree.set(target, indegree.get(target)! + 1)));
  const output: PresentationElementConstraint[] = [];
  const emitted = new Set<string>();
  while (output.length < items.length) {
    const next = items.find(item => !emitted.has(item.sourceRef) && indegree.get(item.sourceRef) === 0);
    if (!next) return [...items];
    output.push(next);
    emitted.add(next.sourceRef);
    for (const target of edges.get(next.sourceRef) ?? []) indegree.set(target, indegree.get(target)! - 1);
  }
  const ordered = [...output];
  for (const relationship of relationships) {
    if (!['near', 'paired', 'align'].includes(relationship.kind)) continue;
    const from = ordered.findIndex(item => item.sourceRef === relationship.fromRef);
    const to = ordered.findIndex(item => item.sourceRef === relationship.toRef);
    if (from < 0 || to < 0 || Math.abs(from - to) <= 1) continue;
    const [target] = ordered.splice(to, 1);
    const fromAfterRemoval = ordered.findIndex(item => item.sourceRef === relationship.fromRef);
    ordered.splice(fromAfterRemoval + 1, 0, target);
  }
  return ordered;
}

function selectAxis(page: PresentationPageConstraint, composition: PresentationLayoutComposition, area: PresentationLayoutGeometry): 'horizontal' | 'vertical' {
  const focal = page.designIntent.composition.focalArea;
  if (composition === 'sequence') return page.designIntent.composition.flow === 'top-to-bottom' ? 'vertical' : 'horizontal';
  if (composition === 'comparison' && page.designIntent.composition.flow === 'top-to-bottom') return 'vertical';
  if (focal === 'left' || focal === 'right') return 'horizontal';
  if (focal === 'top' || focal === 'bottom') return 'vertical';
  if (page.designIntent.composition.flow === 'top-to-bottom') return 'vertical';
  if (page.designIntent.composition.flow === 'left-to-right' || page.designIntent.composition.flow === 'comparison') return 'horizontal';
  return area.width >= area.height * 1.12 ? 'horizontal' : 'vertical';
}

function orderGroupsForFocal(groups: readonly LayoutGroup[], page: PresentationPageConstraint, axis: 'horizontal' | 'vertical'): LayoutGroup[] {
  if (groups.length < 2) return [...groups];
  const focal = page.designIntent.composition.focalArea;
  if (focal === 'center') return [...groups];
  const movesPrimaryToEnd = axis === 'horizontal' ? focal === 'right' : focal === 'bottom';
  const primary = groups.filter(group => group.kind === 'primary');
  const others = groups.filter(group => group.kind !== 'primary');
  if (primary.length === 0) return [...groups];
  return movesPrimaryToEnd ? [...others, ...primary] : [...primary, ...others];
}

function allocateGroupBoxes(
  groups: readonly LayoutGroup[],
  area: PresentationLayoutGeometry,
  axis: 'horizontal' | 'vertical',
  gap: number,
  page: PresentationPageConstraint
): PresentationLayoutGeometry[] {
  if (groups.length === 0) return [];
  const total = axis === 'horizontal' ? area.width : area.height;
  const available = total - gap * (groups.length - 1);
  const weights = groups.map((group, index) => groupWeight(group, page, axis, index, groups.length));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const minimums = groups.map(group => groupMinimumExtent(group, axis, gap));
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
  const distributable = Math.max(0, available - minimumTotal);
  let offset = axis === 'horizontal' ? area.x : area.y;
  return groups.map((group, index) => {
    const extent = minimums[index] + distributable * (weights[index] / weightTotal);
    const box = axis === 'horizontal'
      ? { x: offset, y: area.y, width: extent, height: area.height }
      : { x: area.x, y: offset, width: area.width, height: extent };
    offset += extent + gap;
    return box;
  });
}

function groupMinimumExtent(group: LayoutGroup, axis: 'horizontal' | 'vertical', gap: number): number {
  if (axis === 'horizontal') return group.items.reduce((maximum, element) => Math.max(maximum, element.minWidth), 0);
  return group.items.reduce((total, element) => total + element.minHeight, 0) + gap * Math.max(0, group.items.length - 1);
}

function groupWeight(group: LayoutGroup, page: PresentationPageConstraint, axis: 'horizontal' | 'vertical', index: number, groupCount: number): number {
  const content = group.items.reduce((sum, element) => sum + Math.max(12, element.textLength) + element.itemCount * 18, 0);
  const priority = group.items.reduce((sum, element) => sum + element.priority, 0) / Math.max(1, group.items.length);
  const preferredArea = group.items.reduce((sum, element) => sum + element.preferredWidth * element.preferredHeight, 0) / Math.max(1, group.items.length);
  let weight = Math.sqrt(content) * Math.sqrt(Math.max(0.25, preferredArea)) * (0.8 + priority / 300);
  const emphasis = page.designIntent.emphasis;
  if (group.items.some(element => element.sourceRef === emphasis.target)) {
    weight *= emphasis.strength === 'dominant' ? 1.34 : emphasis.strength === 'strong' ? 1.22 : emphasis.strength === 'moderate' ? 1.1 : 1;
  }
  const balance = page.designIntent.composition.balance;
  const dominance = page.relationships.filter(relationship => relationship.kind === 'dominates');
  if (dominance.some(relationship => group.items.some(element => element.sourceRef === relationship.fromRef))) weight *= 1.16;
  if (dominance.some(relationship => group.items.some(element => element.sourceRef === relationship.toRef))) weight *= 0.9;
  if (group.kind === 'primary' && balance === 'weighted') weight *= 1.18;
  if (group.kind === 'primary' && balance === 'centered') weight *= 1.1;
  const edgeWeight = axis === 'horizontal'
    ? balance === 'asymmetric-left' ? index === 0 : balance === 'asymmetric-right' ? index === groupCount - 1 : false
    : false;
  if (edgeWeight) weight *= 1.16;
  return Math.max(1, weight);
}

function layoutGroup(
  items: readonly PresentationElementConstraint[],
  area: PresentationLayoutGeometry,
  gap: number,
  page: PresentationPageConstraint,
  composition: PresentationLayoutComposition
): { readonly element: PresentationElementConstraint; readonly geometry: PresentationLayoutGeometry }[] {
  if (items.length === 0) return [];
  const density = page.density;
  const aspect = area.width / area.height;
  const maxColumns = density === 'dense' ? 3 : density === 'balanced' ? 2 : 1;
  const flow = page.designIntent.composition.flow;
  const horizontalSequence = composition === 'sequence' && flow !== 'top-to-bottom';
  const flowingColumns = flow === 'top-to-bottom' ? 1 : Math.min(maxColumns, aspect > 1.45 ? Math.max(1, Math.ceil(Math.sqrt(items.length * aspect / 1.8))) : 1);
  const hasVerticalRelationship = page.relationships.some(relationship => relationship.kind === 'above' &&
    items.some(element => element.sourceRef === relationship.fromRef) && items.some(element => element.sourceRef === relationship.toRef));
  const hasAlignedPair = page.relationships.some(relationship => relationship.kind === 'align' &&
    items.some(element => element.sourceRef === relationship.fromRef) && items.some(element => element.sourceRef === relationship.toRef));
  const desiredColumns = hasVerticalRelationship || flow === 'top-to-bottom' ? 1
    : hasAlignedPair ? Math.max(2, flowingColumns)
      : horizontalSequence ? Math.min(items.length, maxColumns) : flowingColumns;
  const columns = Math.min(items.length, desiredColumns);
  const rows = Math.ceil(items.length / columns);
  const rowGap = rows > 1 ? gap : 0;
  const colGap = columns > 1 ? gap : 0;
  const columnWidths = allocateTrackSizes(items, columns, columns, area.width, colGap, 'width');
  const rowHeights = allocateTrackSizes(items, rows, columns, area.height, rowGap, 'height');
  const columnOffsets = offsets(columnWidths, area.x, colGap);
  const rowOffsets = offsets(rowHeights, area.y, rowGap);
  const output = items.map((element, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    let geometry = fitCellGeometry(element, {
      x: columnOffsets[column]!, y: rowOffsets[row]!, width: columnWidths[column]!, height: rowHeights[row]!
    }, page);
    if (items.length === 1 && composition !== 'sequence') geometry = emphasizeCell(geometry, element, page);
    return { element, geometry };
  });
  return output;
}

function allocateTrackSizes(
  items: readonly PresentationElementConstraint[],
  trackCount: number,
  tracksAcross: number,
  total: number,
  gap: number,
  axis: 'width' | 'height'
): number[] {
  const minimums = Array.from({ length: trackCount }, (_, track) => Math.max(...items
    .filter((_item, index) => axis === 'width' ? index % tracksAcross === track : Math.floor(index / tracksAcross) === track)
    .map(item => axis === 'width' ? item.minWidth : item.minHeight)));
  const preferred = Array.from({ length: trackCount }, (_, track) => Math.max(...items
    .filter((_item, index) => axis === 'width' ? index % tracksAcross === track : Math.floor(index / tracksAcross) === track)
    .map(item => axis === 'width' ? item.preferredWidth : item.preferredHeight)));
  const available = total - gap * Math.max(0, trackCount - 1);
  const distributable = Math.max(0, available - minimums.reduce((sum, value) => sum + value, 0));
  const weightTotal = preferred.reduce((sum, value) => sum + value, 0);
  return minimums.map((minimum, index) => minimum + distributable * (preferred[index]! / Math.max(1, weightTotal)));
}

function offsets(sizes: readonly number[], start: number, gap: number): number[] {
  const result: number[] = [];
  let current = start;
  for (const size of sizes) {
    result.push(current);
    current += size + gap;
  }
  return result;
}

function fitCellGeometry(
  element: PresentationElementConstraint,
  cell: PresentationLayoutGeometry,
  page: PresentationPageConstraint
): PresentationLayoutGeometry {
  let width = Math.min(cell.width, element.maxWidth);
  let height = Math.min(cell.height, element.maxHeight);
  if ((element.role === 'chart' || element.role === 'table') && element.aspectRatio !== undefined) {
    if (width / height > element.aspectRatio) width = height * element.aspectRatio;
    else height = width / element.aspectRatio;
  }
  width = Math.max(element.minWidth, width);
  height = Math.max(element.minHeight, height);
  const horizontalCenter = cell.x + (cell.width - width) / 2;
  const verticalCenter = cell.y + (cell.height - height) / 2;
  const horizontal = element.preferredRegion === 'left' || element.preferredRegion === 'leading' ? cell.x
    : element.preferredRegion === 'right' || element.preferredRegion === 'trailing' ? cell.x + cell.width - width
      : horizontalCenter;
  const vertical = element.preferredRegion === 'top' ? cell.y
    : element.preferredRegion === 'bottom' ? cell.y + cell.height - height
      : verticalCenter;
  const focal = page.designIntent.composition.focalArea;
  return {
    x: focal === 'left' && element.hierarchy === 'primary' ? cell.x
      : focal === 'right' && element.hierarchy === 'primary' ? cell.x + cell.width - width
        : horizontal,
    y: vertical,
    width,
    height
  };
}

function emphasizeCell(box: PresentationLayoutGeometry, element: PresentationElementConstraint, page: PresentationPageConstraint): PresentationLayoutGeometry {
  const strength = page.designIntent.emphasis.strength;
  const hierarchy = element.hierarchy;
  const base = hierarchy === 'primary' ? 0.82 : hierarchy === 'secondary' ? 0.7 : 0.58;
  const emphasisScale = strength === 'dominant' && element.sourceRef === page.designIntent.emphasis.target ? 0.96
    : strength === 'strong' && element.sourceRef === page.designIntent.emphasis.target ? 0.9 : base;
  const scale = Math.max(base, emphasisScale);
  const width = Math.min(box.width, Math.max(box.width * scale, element.minWidth));
  const height = Math.min(box.height, Math.max(box.height * scale, element.minHeight));
  const focal = page.designIntent.composition.focalArea;
  const x = focal === 'left' ? box.x : focal === 'right' ? box.x + box.width - width : box.x + (box.width - width) / 2;
  const y = focal === 'top' ? box.y : focal === 'bottom' ? box.y + box.height - height : box.y + (box.height - height) / 2;
  return { x, y, width, height };
}

function fitFontSize(element: PresentationElementConstraint, box: PresentationLayoutGeometry): number | undefined {
  if (box.width < element.minWidth || box.height < element.minHeight) return undefined;
  if (element.role === 'chart') return element.itemCount <= 20 && box.width >= 2.8 && box.height >= 1.55 ? clamp(16, element.minimumFontSize, element.maximumFontSize) : undefined;
  if (element.role === 'table') {
    const cellWidthsEm = element.tableCellWidthsEm;
    const columns = element.tableColumns;
    if (!cellWidthsEm || !columns || cellWidthsEm.length !== (element.tableRows ?? -1) + 1) return undefined;
    const minimum = Math.ceil(element.minimumFontSize);
    const preferred = Math.max(minimum, Math.floor(Math.min(element.preferredFontSize, 16, element.maximumFontSize)));
    for (let fontSize = preferred; fontSize >= minimum; fontSize -= 1) {
      if (estimateTableHeight(cellWidthsEm, columns, box.width, fontSize) <= box.height) return fontSize;
    }
    return undefined;
  }
  for (let fontSize = Math.floor(Math.min(element.preferredFontSize, element.maximumFontSize)); fontSize >= element.minimumFontSize; fontSize -= 1) {
    const availableWidth = Math.max(0.1, box.width - 0.12);
    const measuredTextWidth = Math.max(0.28, element.estimatedTextWidthEm) * fontSize / 72;
    const lines = Math.max(1, Math.ceil(measuredTextWidth / availableWidth));
    const requiredHeight = lines * fontSize / 72 * 1.28 + 0.06;
    if (requiredHeight <= box.height) return fontSize;
  }
  return undefined;
}

function estimateTableHeight(
  cellWidthsEm: readonly (readonly number[])[],
  columns: number,
  boxWidth: number,
  fontSize: number
): number {
  const cellWidth = Math.max(0.1, (boxWidth - columns * 0.12) / columns);
  let totalLines = 0;
  for (const row of cellWidthsEm) {
    const rowLines = Math.max(1, ...row.map(width => Math.ceil((width * fontSize / 72 + 0.04) / cellWidth)));
    totalLines += rowLines;
  }
  return totalLines * fontSize / 72 * 1.3 + cellWidthsEm.length * 0.12;
}

function pageArea(page: PresentationPageConstraint, canvas: PresentationLayoutConstraintModel['canvas'], reserveFooter: boolean): PresentationLayoutGeometry {
  const left = page.safeArea.leftInset;
  const top = page.safeArea.topInset;
  const width = Math.min(page.contentBounds.maximumWidth, canvas.width - left - page.safeArea.rightInset);
  const footerSpace = reserveFooter ? 0.42 : 0;
  const height = Math.min(page.contentBounds.maximumHeight, canvas.height - top - page.safeArea.bottomInset) - footerSpace;
  return { x: left, y: top, width, height };
}

function effectiveGap(page: PresentationPageConstraint, features: PresentationPageFeatures): number {
  const densityMultiplier = features.contentDensity === 'dense' || page.density === 'dense' ? 0.72 : page.density === 'sparse' ? 1.14 : 1;
  return Math.max(page.minimumGap, page.preferredGap * densityMultiplier);
}

function regionFor(element: PresentationElementConstraint, kind: LayoutGroup['kind'], page: PresentationPageConstraint): PresentationLayoutRegion {
  if (element.hierarchy === 'primary' && element.preferredRegion !== 'supporting') return element.preferredRegion;
  const focal = page.designIntent.composition.focalArea;
  if (kind === 'primary') return focal === 'full-bleed' ? 'center' : focal;
  if (kind === 'secondary') return focal === 'center' ? 'trailing' : 'supporting';
  if (kind === 'sequence') return page.designIntent.composition.flow === 'top-to-bottom' ? 'top' : 'leading';
  if (focal === 'left') return 'right';
  if (focal === 'right') return 'left';
  if (focal === 'top') return 'bottom';
  if (focal === 'bottom') return 'top';
  return 'supporting';
}

function hasOverlap(placements: readonly MutablePlacement[]): boolean {
  for (let left = 0; left < placements.length; left += 1) {
    for (let right = left + 1; right < placements.length; right += 1) {
      const a = placements[left].geometry;
      const b = placements[right].geometry;
      const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapWidth > MIN_GEOMETRY && overlapHeight > MIN_GEOMETRY) return true;
    }
  }
  return false;
}

function inside(box: PresentationLayoutGeometry, bounds: PresentationLayoutGeometry): boolean {
  return box.x >= bounds.x - MIN_GEOMETRY && box.y >= bounds.y - MIN_GEOMETRY &&
    box.x + box.width <= bounds.x + bounds.width + MIN_GEOMETRY && box.y + box.height <= bounds.y + bounds.height + MIN_GEOMETRY;
}

function validGeometry(box: PresentationLayoutGeometry): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0;
}

function geometrySignature(placements: readonly PresentationLayoutPlacement[]): string {
  return placements.map(item => `${item.sourceRef}:${round(item.geometry.x, 2)},${round(item.geometry.y, 2)},${round(item.geometry.width, 2)},${round(item.geometry.height, 2)}`).join('|');
}

function roundGeometry(geometry: PresentationLayoutGeometry): PresentationLayoutGeometry {
  return { x: round(geometry.x, 4), y: round(geometry.y, 4), width: round(geometry.width, 4), height: round(geometry.height, 4) };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hierarchyRank(value: PresentationElementConstraint['hierarchy']): number {
  return value === 'primary' ? 0 : value === 'secondary' ? 1 : value === 'supporting' ? 2 : 3;
}

function groupRegionOrder(value: PresentationLayoutRegion): number {
  return value === 'left' || value === 'top' || value === 'leading' ? 0 : value === 'center' ? 1 : 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
