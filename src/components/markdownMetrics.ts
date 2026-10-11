let parseCount = 0;
let parseTimeMs = 0;

export function recordMarkdownParse(durationMs: number): void {
  parseCount += 1;
  parseTimeMs += durationMs;
}

export function readMarkdownMetrics(): { readonly parseCount: number; readonly parseTimeMs: number } {
  return { parseCount, parseTimeMs };
}

export function resetMarkdownMetrics(): void {
  parseCount = 0;
  parseTimeMs = 0;
}
