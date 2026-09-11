export function recentTaskDateRange(days: number, now = new Date()): [Date, Date] {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return [start, end];
}

export function isTaskInDateRange(createdAt: string, range: [Date, Date] | null): boolean {
  if (!range) return true;
  const start = new Date(range[0]);
  start.setHours(0, 0, 0, 0);
  const endExclusive = new Date(range[1]);
  endExclusive.setHours(0, 0, 0, 0);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const timestamp = new Date(createdAt).getTime();
  return timestamp >= start.getTime() && timestamp < endExclusive.getTime();
}
