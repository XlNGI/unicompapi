import { createHash } from 'node:crypto';
import type { VideoExportPlan } from '../../domain';

export function computeVideoExportPlanHash(
  value: VideoExportPlan
): string {
  const material = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'planHash')
  );
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

export function hasValidVideoExportPlanHash(plan: VideoExportPlan): boolean {
  return computeVideoExportPlanHash(plan) === plan.planHash;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
