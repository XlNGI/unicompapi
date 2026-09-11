import type { ProviderFailureDiagnosticV1 } from '../../domain';

/** Only bounded diagnostic fields cross the provider boundary. Never retain a response body. */
export function failureDiagnostic(input: {
  message?: unknown;
  code?: unknown;
  requestId?: unknown;
  statusCode?: number;
  stage?: ProviderFailureDiagnosticV1['stage'];
}, secrets: readonly string[] = []): ProviderFailureDiagnosticV1 | undefined {
  if (typeof input.message !== 'string' || !input.message.trim()) return undefined;
  let message = input.message.slice(0, 4096);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[已隐藏]');
  }
  message = message
    .replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[已隐藏]')
    .replace(/(?:https?:\/\/|[a-z]:\\|\\\\)\S+/gi, '[地址已隐藏]')
    .replace(/\b(?:api[_-]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '[凭证已隐藏]')
    .replace(/\b(?:prompt|input|content)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*')/gi, '[内容已隐藏]')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/)\S+/g, '[路径已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 512).trim();
  if (!message) return undefined;
  const token = (value: unknown) => typeof value === 'string' &&
    /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value) ? value : undefined;
  const code = token(input.code);
  const requestId = token(input.requestId);
  return {
    message,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {})
  };
}
