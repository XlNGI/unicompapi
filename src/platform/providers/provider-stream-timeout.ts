export interface ProviderStreamTimeoutOptions {
  readonly defaultTimeoutMs?: number;
  readonly defaultConnectionTimeoutMs?: number;
  readonly defaultStreamIdleTimeoutMs?: number;
  readonly defaultStreamTotalTimeoutMs?: number;
}

export interface ProviderStreamTimeoutPolicy {
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface ProviderStreamTimeoutController {
  readonly timedOut: boolean;
  start(): void;
  connected(): void;
  beforeRead(): void;
  afterRead(): void;
  close(): void;
}

export const defaultTextStreamTimeoutPolicy: ProviderStreamTimeoutPolicy =
  Object.freeze({
    connectionTimeoutMs: 5 * 60_000,
    idleTimeoutMs: 60_000,
    totalTimeoutMs: 15 * 60_000
  });

export function resolveTextStreamTimeoutPolicy(
  options: ProviderStreamTimeoutOptions
): ProviderStreamTimeoutPolicy {
  return Object.freeze({
    connectionTimeoutMs:
      options.defaultConnectionTimeoutMs ??
      options.defaultTimeoutMs ??
      defaultTextStreamTimeoutPolicy.connectionTimeoutMs,
    idleTimeoutMs:
      options.defaultStreamIdleTimeoutMs ??
      options.defaultTimeoutMs ??
      defaultTextStreamTimeoutPolicy.idleTimeoutMs,
    totalTimeoutMs:
      options.defaultStreamTotalTimeoutMs ??
      defaultTextStreamTimeoutPolicy.totalTimeoutMs
  });
}

export function isValidProviderStreamTimeoutPolicy(
  policy: ProviderStreamTimeoutPolicy
): boolean {
  return isPositiveSafeInteger(policy.connectionTimeoutMs) &&
    isPositiveSafeInteger(policy.idleTimeoutMs) &&
    isPositiveSafeInteger(policy.totalTimeoutMs);
}

export function isPositiveTimeoutMs(value: number): boolean {
  return isPositiveSafeInteger(value);
}

export function createProviderStreamTimeoutController(input: {
  readonly policy: ProviderStreamTimeoutPolicy;
  readonly abort: () => void;
}): ProviderStreamTimeoutController {
  let started = false;
  let timedOut = false;
  let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  let totalTimeout: ReturnType<typeof setTimeout> | undefined;
  const abortForTimeout = () => {
    timedOut = true;
    input.abort();
  };
  const clearConnectionTimeout = () => {
    if (connectionTimeout === undefined) return;
    clearTimeout(connectionTimeout);
    connectionTimeout = undefined;
  };
  const clearIdleTimeout = () => {
    if (idleTimeout === undefined) return;
    clearTimeout(idleTimeout);
    idleTimeout = undefined;
  };
  const clearTotalTimeout = () => {
    if (totalTimeout === undefined) return;
    clearTimeout(totalTimeout);
    totalTimeout = undefined;
  };
  return {
    get timedOut() {
      return timedOut;
    },
    start() {
      if (started) return;
      started = true;
      connectionTimeout = setTimeout(
        abortForTimeout,
        input.policy.connectionTimeoutMs
      );
      totalTimeout = setTimeout(abortForTimeout, input.policy.totalTimeoutMs);
    },
    connected() {
      clearConnectionTimeout();
    },
    beforeRead() {
      clearIdleTimeout();
      idleTimeout = setTimeout(abortForTimeout, input.policy.idleTimeoutMs);
    },
    afterRead() {
      clearIdleTimeout();
    },
    close() {
      clearConnectionTimeout();
      clearIdleTimeout();
      clearTotalTimeout();
    }
  };
}

export async function* boundProviderByteStream<RuntimeError extends Error>(input: {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly maximumBytes: number;
  readonly timeout: ProviderStreamTimeoutController;
  readonly close: () => void;
  readonly invalidResponse: () => RuntimeError;
  readonly responseTooLarge: () => RuntimeError;
  readonly mapFailure: (error: unknown) => RuntimeError;
}): AsyncGenerator<Uint8Array> {
  let total = 0;
  const iterator = input.stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      input.timeout.beforeRead();
      let result: IteratorResult<Uint8Array>;
      try {
        result = await iterator.next();
      } finally {
        input.timeout.afterRead();
      }
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) throw input.invalidResponse();
      total += chunk.byteLength;
      if (total > input.maximumBytes) throw input.responseTooLarge();
      yield Uint8Array.from(chunk);
    }
  } catch (error) {
    throw input.mapFailure(error);
  } finally {
    input.timeout.afterRead();
    input.close();
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
