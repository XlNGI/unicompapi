import { presentationDocumentPageLimits } from '../domain';

const pageNumberToken = '([0-9]{1,3}|[一二两三四五六七八九十百]{1,5})';
const totalPagePatterns = [
  new RegExp(
    `(?:总页数|页数|总共|总计|一共|合计)\\s*[：:=]?\\s*(?:调整为|修改为|改为|设置为|控制在|为|是)?\\s*${pageNumberToken}\\s*页`,
    'iu'
  ),
  new RegExp(
    `(?:加|增加|扩展|扩充|调整|修改|改|变更|做|设置)\\s*(?:到|至|为|成)\\s*${pageNumberToken}\\s*页`,
    'iu'
  ),
  new RegExp(
    `(?:增至|扩至|改为|调整为|修改为|变成|做到|控制在)\\s*${pageNumberToken}\\s*页`,
    'iu'
  ),
  new RegExp(
    `${pageNumberToken}\\s*页\\s*(?:的\\s*)?(?:pptx?|演示文稿|幻灯片|课件)`,
    'iu'
  ),
  new RegExp(
    `(?:pptx?|演示文稿|幻灯片|课件)\\s*(?:做|生成|制作|调整|修改|改成|扩展)?\\s*(?:到|至|为|成)?\\s*${pageNumberToken}\\s*页`,
    'iu'
  )
] as const;

/** Returns an exact requested PPT total, never a local target such as “第 5 页”. */
export function parseRequestedPresentationTotalPages(
  requestText: string
): number | undefined {
  for (const pattern of totalPagePatterns) {
    const match = pattern.exec(requestText);
    if (!match) continue;
    const value = parsePageNumber(match[1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

export function presentationBodySectionCount(totalPages: number): number {
  return totalPages - presentationDocumentPageLimits.systemGeneratedPages;
}

export function isSupportedPresentationTotalPages(totalPages: number): boolean {
  return (
    Number.isSafeInteger(totalPages) &&
    totalPages >= presentationDocumentPageLimits.minimumRequestedPages &&
    totalPages <= presentationDocumentPageLimits.maximumPages
  );
}

function parsePageNumber(token: string): number {
  if (/^\d+$/u.test(token)) return Number(token);
  const digits: Readonly<Record<string, number>> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  const units: Readonly<Record<string, number>> = { 十: 10, 百: 100 };
  let total = 0;
  let current = 0;
  for (const character of token) {
    const digit = digits[character];
    if (digit !== undefined) {
      current = digit;
      continue;
    }
    const unit = units[character];
    if (unit === undefined) return Number.NaN;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}
