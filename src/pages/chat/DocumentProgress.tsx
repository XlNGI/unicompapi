import type { MessageDto } from '../../shared/chat-context-ipc';

/** Execution facts appear in the assistant reply, without a separate progress wizard. */
export function DocumentProgress({ detail }: {
  readonly state?: NonNullable<MessageDto['documentGenerationStatus']>['state'];
  readonly detail: string;
}) {
  return <p role="status" aria-live="polite">{detail}</p>;
}
