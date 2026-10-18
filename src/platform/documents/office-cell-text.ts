/** A readable projection of an Excel cell value; never evaluates a formula or follows a link. */
export function officeCellText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (depth > 2) return '[单元格复合值]';
  const cell = value as Record<string, unknown>;
  if (typeof cell.formula === 'string' || typeof cell.sharedFormula === 'string') {
    const formula = typeof cell.formula === 'string' ? `=${cell.formula}` : `共享公式 ${String(cell.sharedFormula)}`;
    return cell.result === undefined ? formula : `${formula}（缓存值：${officeCellText(cell.result, depth + 1)}）`;
  }
  if (Array.isArray(cell.richText)) return cell.richText.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('');
  if (typeof cell.text === 'string') return cell.text;
  if (typeof cell.error === 'string') return cell.error;
  return '[单元格复合值]';
}
