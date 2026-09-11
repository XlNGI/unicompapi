import { describe, expect, it } from 'vitest';
import { isTaskInDateRange, recentTaskDateRange } from '../../src/pages/tasks/task-date-range';

describe('task creation date range', () => {
  it('keeps all history when cleared', () => {
    expect(isTaskInDateRange('2020-01-01T00:00:00Z', null)).toBe(true);
  });

  it('includes both local calendar days and excludes the next midnight', () => {
    const range: [Date, Date] = [new Date(2026, 8, 2, 12), new Date(2026, 8, 8, 12)];
    expect(isTaskInDateRange(new Date(2026, 8, 2).toISOString(), range)).toBe(true);
    expect(isTaskInDateRange(new Date(2026, 8, 8, 23, 59, 59, 999).toISOString(), range)).toBe(true);
    expect(isTaskInDateRange(new Date(2026, 8, 1, 23, 59, 59, 999).toISOString(), range)).toBe(false);
    expect(isTaskInDateRange(new Date(2026, 8, 9).toISOString(), range)).toBe(false);
  });

  it('counts today within shortcuts across year boundaries without mutating the clock', () => {
    const now = new Date(2026, 0, 3, 15);
    expect(recentTaskDateRange(7, now)).toEqual([new Date(2025, 11, 28), new Date(2026, 0, 3)]);
    expect(recentTaskDateRange(30, now)[0]).toEqual(new Date(2025, 11, 5));
    expect(recentTaskDateRange(1, now)).toEqual([new Date(2026, 0, 3), new Date(2026, 0, 3)]);
    expect(now.getHours()).toBe(15);
  });
});
