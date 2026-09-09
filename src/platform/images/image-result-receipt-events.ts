import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ImageSubmissionErrorCode } from '../../shared/image-submission-ipc';

export const imageResultReceiptEventKinds = [
  'receipt_started',
  'descriptor_loaded',
  'download_started',
  'download_completed',
  'verification_completed',
  'work_registered',
  'receipt_failed'
] as const;

export type ImageResultReceiptEventKind =
  (typeof imageResultReceiptEventKinds)[number];

export const imageResultReceiptStages = [
  'loading_execution',
  'loading_descriptor',
  'downloading',
  'verifying',
  'writing',
  'registering_work'
] as const;

export type ImageResultReceiptStage =
  (typeof imageResultReceiptStages)[number];

export interface ImageResultReceiptEvent {
  readonly event: ImageResultReceiptEventKind;
  readonly taskId?: string;
  readonly executionId: string;
  readonly stage: ImageResultReceiptStage;
  readonly safeCode?: ImageSubmissionErrorCode;
  readonly retryability?: 'retryable' | 'not_retryable' | 'unknown';
  readonly occurredAt: string;
}

/** Serializes only the receipt event whitelist and preserves event order. */
export class JsonLineImageResultReceiptLogger {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly logFilePath: string) {}

  write(event: ImageResultReceiptEvent): void {
    const line = `${JSON.stringify(safeLogRecord(event))}\n`;
    this.pending = this.pending
      .then(async () => {
        await mkdir(path.dirname(this.logFilePath), { recursive: true });
        await appendFile(this.logFilePath, line, 'utf8');
      })
      .catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

function safeLogRecord(event: ImageResultReceiptEvent) {
  return {
    event: event.event,
    ...(event.taskId ? { taskId: safeIdentifier(event.taskId) } : {}),
    executionId: safeIdentifier(event.executionId),
    stage: event.stage,
    ...(event.safeCode ? { safeCode: event.safeCode } : {}),
    ...(event.retryability ? { retryability: event.retryability } : {}),
    occurredAt: event.occurredAt
  };
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
    ? value
    : 'invalid';
}
