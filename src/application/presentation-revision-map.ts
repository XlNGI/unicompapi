/** Trusted file-derived data, never accepted from a model or renderer request. */
export interface PresentationRevisionMap {
  readonly checksumSha256: string;
  readonly totalPages: number;
  readonly sections: readonly {
    readonly sectionIndex: number;
    readonly heading: string;
    readonly pages: readonly number[];
  }[];
}

export function mappedPresentationTarget(map: PresentationRevisionMap, target: { unit: 'page' | 'section'; ordinal: number }) {
  const section = target.unit === 'page'
    ? map.sections.find((item) => item.pages.includes(target.ordinal))
    : map.sections.find((item) => item.sectionIndex === target.ordinal - 1);
  if (!section || !section.pages.length) throw new Error('Presentation target cannot be mapped to the registered file');
  return { sectionIndex: section.sectionIndex, sectionHeading: section.heading,
    pageNumber: target.unit === 'page' ? target.ordinal : section.pages[0],
    targetUnit: target.unit,
    pages: target.unit === 'page' ? [target.ordinal] : section.pages };
}
