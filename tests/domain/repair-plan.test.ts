import { describe, expect, it } from 'vitest';
import { parseRepairPlan } from '../../src/domain';

describe('RepairPlan schema', () => {
  it('accepts bounded structured repair operations', () => {
    const plan = parseRepairPlan({
      kind: 'repair',
      diagnosisCodes: ['capacity_exceeded'],
      operations: [{
        operation: 'replace_text',
        target: { sectionIndex: 0, blockIndex: 0 },
        value: 'short text'
      }],
      preserve: ['unplanned_pages_unchanged'],
      reason: 'shorten the overflowing text',
      expectedRevision: 4,
      targetPages: [2]
    });
    expect(plan.operations[0].operation).toBe('replace_text');
  });

  it('rejects paths, arbitrary fields and duplicate target pages', () => {
    expect(() => parseRepairPlan({
      kind: 'repair',
      diagnosisCodes: ['layout'],
      operations: [{ operation: 'replace_text', target: { sectionIndex: 0 }, value: 'C:\\bad' }],
      preserve: [],
      reason: 'repair',
      extra: true
    })).toThrow(/unsupported field/);
    expect(() => parseRepairPlan({
      kind: 'repair',
      diagnosisCodes: ['layout'],
      operations: [{ operation: 'replace_text', target: { sectionIndex: 0 }, value: 'C:\\bad' }],
      preserve: [],
      reason: 'repair'
    })).toThrow(/path or URL/);
    expect(() => parseRepairPlan({
      kind: 'repair', diagnosisCodes: ['layout'],
      operations: [{ operation: 'replace_text', target: { sectionIndex: 0 }, value: 'x' }],
      preserve: [], reason: 'repair', targetPages: [1, 1]
    })).toThrow(/duplicates/);
  });
});
