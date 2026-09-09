export type ConversationStreamDeltaKind = 'reasoning' | 'content';

export interface ConversationStreamDeltaSegment {
  readonly kind: ConversationStreamDeltaKind;
  readonly delta: string;
}

export interface ConversationStreamDeltaBatcherOptions {
  readonly persist: (
    segments: readonly ConversationStreamDeltaSegment[]
  ) => Promise<void>;
  readonly flushDelayMs?: number;
  readonly flushByteThreshold?: number;
  readonly maximumOutstandingBytes?: number;
}

const defaultFlushDelayMs = 120;
const defaultFlushByteThreshold = 8 * 1024;
const defaultMaximumOutstandingBytes = 256 * 1024;
const textEncoder = new TextEncoder();

export class ConversationStreamDeltaBatcher {
  private readonly flushDelayMs: number;
  private readonly flushByteThreshold: number;
  private readonly maximumOutstandingBytes: number;
  private pending: ConversationStreamDeltaSegment[] = [];
  private pendingBytes = 0;
  private outstandingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private sealed = false;

  constructor(private readonly options: ConversationStreamDeltaBatcherOptions) {
    this.flushDelayMs = options.flushDelayMs ?? defaultFlushDelayMs;
    this.flushByteThreshold =
      options.flushByteThreshold ?? defaultFlushByteThreshold;
    this.maximumOutstandingBytes =
      options.maximumOutstandingBytes ?? defaultMaximumOutstandingBytes;
    if (
      !isPositiveSafeInteger(this.flushDelayMs) ||
      !isPositiveSafeInteger(this.flushByteThreshold) ||
      !isPositiveSafeInteger(this.maximumOutstandingBytes) ||
      this.flushByteThreshold > this.maximumOutstandingBytes
    ) {
      throw new TypeError('Conversation stream delta batch limits are invalid');
    }
  }

  append(kind: ConversationStreamDeltaKind, delta: string): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.sealed) {
      return Promise.reject(new Error('Conversation stream delta batch is sealed'));
    }
    if (delta.length < 1) {
      return Promise.reject(new TypeError('Conversation stream delta is empty'));
    }
    const bytes = textEncoder.encode(delta).byteLength;
    const last = this.pending.at(-1);
    if (last?.kind === kind) {
      this.pending[this.pending.length - 1] = {
        kind,
        delta: `${last.delta}${delta}`
      };
    } else {
      this.pending.push({ kind, delta });
    }
    this.pendingBytes += bytes;
    this.outstandingBytes += bytes;
    this.scheduleFlush();

    if (this.pendingBytes < this.flushByteThreshold) return Promise.resolve();
    const flush = this.flushPending();
    if (this.outstandingBytes >= this.maximumOutstandingBytes) return flush;
    void flush.catch(() => undefined);
    return Promise.resolve();
  }

  async sealAndDrain(): Promise<void> {
    this.sealed = true;
    this.clearTimer();
    if (this.failure !== undefined) throw this.failure;
    await this.flushPending();
    await this.tail;
    if (this.failure !== undefined) throw this.failure;
  }

  get pendingByteCount(): number {
    return this.outstandingBytes;
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushPending().catch(() => undefined);
    }, this.flushDelayMs);
  }

  private flushPending(): Promise<void> {
    this.clearTimer();
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.pending.length === 0) return this.tail;
    const segments = this.pending;
    const batchBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const operation = this.tail.then(async () => {
      await this.options.persist(segments);
      this.outstandingBytes -= batchBytes;
    });
    this.tail = operation.catch((error: unknown) => {
      this.failure = error;
      throw error;
    });
    void this.tail.catch(() => undefined);
    return this.tail;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
