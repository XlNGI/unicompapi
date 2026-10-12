import { parseMessage, type Message, type MessageFailureReason, type ConversationResponseExecutionReadModelV1,
  type ConversationResponseStreamEventV1 } from '../../domain';

/** Response facts supply text/state; the Thread snapshot supplies Host metadata only. */
export function threadResponseMessage(execution: ConversationResponseExecutionReadModelV1,
  event: ConversationResponseStreamEventV1, current?: Message): Message {
  if (event.responseExecutionId !== execution.responseExecutionId || current &&
      (current.id !== execution.assistantMessageId || current.conversationId !== execution.conversationId || current.role !== 'assistant')) {
    throw new Error('thread_response_message_scope_mismatch');
  }
  const metadata = Object.fromEntries(Object.entries(current ?? {}).filter(([key]) =>
    !['startedAt', 'completedAt', 'failedAt', 'failureReason', 'cancelledAt', 'streamSequence', 'reasoningContent'].includes(key)));
  const state = execution.state === 'interrupted' ? 'failed' : execution.state;
  const updatedAt = [current?.updatedAt ?? execution.createdAt, execution.updatedAt].sort().at(-1)!;
  return parseMessage({ ...metadata, schemaVersion: 1, id: execution.assistantMessageId,
    conversationId: execution.conversationId, role: 'assistant', revision: current?.revision ?? 0,
    state, content: execution.content, attachments: current?.attachments ?? [],
    createdAt: current?.createdAt ?? execution.createdAt, updatedAt,
    ...(execution.reasoningContent ? { reasoningContent: execution.reasoningContent } : {}),
    ...(state === 'pending' ? {} : { streamSequence: execution.streamSequence }),
    ...(state === 'streaming' ? { startedAt: current?.state === 'streaming' ? current.startedAt : execution.createdAt }
      : state === 'completed' ? { completedAt: updatedAt }
        : state === 'cancelled' ? { cancelledAt: updatedAt }
          : state === 'failed' ? { failedAt: updatedAt, failureReason: execution.state === 'interrupted' ? 'interrupted'
            : event.safeCode ? failureReasonFromSafeCode(event.safeCode) : current?.state === 'failed' ? current.failureReason : 'unknown' } : {}) });
}

export function failureReasonFromSafeCode(safeCode: string): MessageFailureReason {
  if (/timeout|unknown_result|submission_outcome_unknown/u.test(safeCode)) return 'unknown';
  if (safeCode.includes('finish.length')) return 'truncated';
  if (safeCode.includes('upstream_rejected')) return 'upstream_rejected';
  if (safeCode.includes('model_not_found')) return 'model_unavailable';
  if (safeCode.includes('local_response_write_failed')) return 'local_write_failed';
  if (safeCode.includes('invalid_request') || safeCode.includes('invalid_parameters')) return 'request_rejected';
  if (safeCode.includes('authentication_failed') || safeCode.includes('permission_denied')) return 'access_denied';
  if (safeCode.includes('invalid_response')) return 'invalid_response';
  if (safeCode.includes('interrupted') || safeCode.includes('application_shutdown')) return 'interrupted';
  return 'unavailable';
}
