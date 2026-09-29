import {
  buildPresentationArtDirectionInput, parseArtDirection, PresentationDesignIRParseError,
  type PresentationArtDirectionInput, type ProductionPresentationDesignIR
} from '../domain/entities/presentation-design-contract';
import type { DocumentIR } from '../domain/entities/document-agent';
import type { DocumentOutline } from '../domain/entities/document-generation';

/** Only this projected semantic contract crosses the Provider boundary. */
export interface PresentationArtDirectionRequest {
  readonly input: PresentationArtDirectionInput;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}
export type PresentationArtDirectionPlanner = (request: PresentationArtDirectionRequest) => Promise<unknown>;

export interface PresentationArtDirectionResult {
  readonly input?: PresentationArtDirectionInput;
  readonly designIR?: ProductionPresentationDesignIR;
  readonly diagnostics: readonly { readonly code: string }[];
}

/** One request, one validation, bounded wait; a failure selects the old renderer. */
export async function planPresentationArtDirection(options: {
  readonly outline: DocumentOutline;
  readonly documentIR?: DocumentIR;
  readonly userRequirement: string;
  readonly visualRequirements?: readonly string[];
  readonly brandingConstraints?: readonly string[];
  readonly request?: PresentationArtDirectionPlanner;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<PresentationArtDirectionResult> {
  options.signal.throwIfAborted();
  if (!options.request) return { diagnostics: [{ code: 'art_direction_unavailable' }] };
  let input: PresentationArtDirectionInput;
  try { input = buildPresentationArtDirectionInput(options); }
  catch { return { diagnostics: [{ code: 'art_direction_input_invalid' }] }; }
  const timeoutMs = resolveArtDirectionTimeout(options.timeoutMs, input.outline.pageCount);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  let timedOut = false;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(Object.assign(new Error('art_direction_cancelled'), { name: 'AbortError' }));
    };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('art_direction_timeout'));
    }, timeoutMs);
  });
  try {
    controller.signal.throwIfAborted();
    const raw = await Promise.race([
      Promise.resolve().then(() => options.request!({ input, signal: controller.signal, timeoutMs })), interrupted
    ]);
    options.signal.throwIfAborted();
    const designIR = parseArtDirection(raw, { outline: options.outline });
    return { input, designIR, diagnostics: [] };
  } catch (error) {
    options.signal.throwIfAborted();
    return { input, diagnostics: error instanceof PresentationDesignIRParseError
      ? error.diagnostics.slice(0, 40).map(({ code }) => ({ code }))
      : [{ code: safeArtDirectionFailure(error, timedOut) }] };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

function resolveArtDirectionTimeout(requestedMs: number | undefined, pageCount: number): number {
  if (Number.isFinite(requestedMs)) return Math.max(1, Math.min(120_000, requestedMs!));
  return Math.min(120_000, 55_000 + Math.max(0, pageCount - 4) * 15_000);
}

function safeArtDirectionFailure(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'art_direction_timeout';
  const message = error instanceof Error ? error.message : '';
  if (message === 'classification_timeout') return 'art_direction_timeout';
  if (message === 'classification_invalid_response' || message === 'semantic_response_incomplete') {
    return 'art_direction_provider_response_incomplete';
  }
  if (message === 'semantic_output_budget_exceeded') return 'art_direction_output_budget_exceeded';
  return 'art_direction_failed';
}
