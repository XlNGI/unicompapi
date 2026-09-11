/** Protocol support is scoped to a model profile; catalog names are not evidence. */
export type NativeSearchProtocol = 'kimi_builtin' | 'glm_web_search';
export interface NativeSearchCapability {
  readonly protocol: NativeSearchProtocol;
  readonly state: 'declared' | 'verified' | 'unknown' | 'unsupported' | 'limited' | 'failed';
  readonly evidenceUrl: string;
  readonly recordedAt: string;
}
export interface NativeSearchRequest {
  readonly grantId: string;
  readonly protocol: NativeSearchProtocol;
  readonly mode: 'auto' | 'required';
}
export interface NativeSearchEvidence {
  readonly status: 'started' | 'completed' | 'unobserved' | 'failed' | 'cancelled';
  readonly toolCalls: number | null;
  readonly cost: 'not_reported';
  readonly searchContentTokens?: number | null;
  readonly requestUsage?: readonly (Readonly<Record<string, number>> | null)[];
  readonly retrievedAt: string;
  readonly sources: readonly { readonly title: string; readonly url: string }[];
}
export function parseNativeSearchCapability(value: unknown): NativeSearchCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid native search capability');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['protocol', 'state', 'evidenceUrl', 'recordedAt'].includes(k)) ||
      !['kimi_builtin', 'glm_web_search'].includes(String(v.protocol)) ||
      !['declared', 'verified', 'unknown', 'unsupported', 'limited', 'failed'].includes(String(v.state)) ||
      typeof v.evidenceUrl !== 'string' || v.evidenceUrl.length > 2048 ||
      typeof v.recordedAt !== 'string' || !Number.isFinite(Date.parse(v.recordedAt))) throw new TypeError('Invalid native search capability');
  const url = new URL(v.evidenceUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Invalid native search evidence URL');
  return { protocol: v.protocol as NativeSearchProtocol, state: v.state as NativeSearchCapability['state'], evidenceUrl: url.href, recordedAt: v.recordedAt };
}
export function parseNativeSearchRequest(value: unknown): NativeSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid native search request');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 3 || typeof v.grantId !== 'string' || !/^native-[a-f0-9-]{36}$/.test(v.grantId) ||
      !['kimi_builtin', 'glm_web_search'].includes(String(v.protocol)) || !['auto', 'required'].includes(String(v.mode))) throw new TypeError('Invalid native search request');
  return { grantId: v.grantId, protocol: v.protocol as NativeSearchProtocol, mode: v.mode as 'auto' | 'required' };
}
