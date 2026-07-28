import type {
  ExecutionId,
  ProviderOperationRecordId,
  TaskId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';
import type {
  ProviderExecutionLifecycle,
  ProviderImmediateResultReference,
  ProviderMediaKind,
  ProviderSubmitOutcome
} from './provider';

export interface ProviderOperationRecord {
  readonly schemaVersion: 2;
  readonly id: ProviderOperationRecordId;
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly mediaKind: Exclude<ProviderMediaKind, 'unknown'>;
  readonly executionLifecycle: ProviderExecutionLifecycle;
  readonly outcome: ProviderSubmitOutcome;
  readonly automaticRetryCount: 0;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createProviderOperationRecord(
  input: Omit<ProviderOperationRecord, 'schemaVersion' | 'automaticRetryCount'>
): ProviderOperationRecord {
  validateProviderSubmitOutcome(input.outcome);
  if (
    input.executionLifecycle === 'asynchronous_polling' &&
    input.outcome.kind === 'completed_sync'
  ) {
    throw new TypeError('asynchronous protocols cannot complete synchronously');
  }
  if (
    input.executionLifecycle === 'synchronous_completed' &&
    input.outcome.kind === 'accepted_async'
  ) {
    throw new TypeError('synchronous protocols cannot accept async operations');
  }
  return {
    ...input,
    schemaVersion: 2,
    automaticRetryCount: 0,
    outcome: cloneProviderSubmitOutcome(input.outcome)
  };
}

export function cloneProviderSubmitOutcome(
  outcome: ProviderSubmitOutcome
): ProviderSubmitOutcome {
  if (outcome.kind === 'accepted_async') {
    return {
      kind: outcome.kind,
      providerOperationId: requireNonBlank(
        outcome.providerOperationId,
        'provider operation ID'
      ),
      state: outcome.state
    };
  }
  if (outcome.kind === 'completed_sync') {
    if (!Array.isArray(outcome.results) || outcome.results.length === 0) {
      throw new TypeError('synchronous completion requires result references');
    }
    return {
      kind: outcome.kind,
      providerOperationId: requireNonBlank(
        outcome.providerOperationId,
        'provider operation ID'
      ),
      results: outcome.results.map(cloneImmediateResult)
    };
  }
  if (outcome.kind === 'submission_outcome_unknown') {
    return {
      kind: outcome.kind,
      providerOperationId: outcome.providerOperationId
        ? requireNonBlank(outcome.providerOperationId, 'provider operation ID')
        : undefined,
      message: requireNonBlank(outcome.message, 'unknown submission message')
    };
  }
  return {
    kind: outcome.kind,
    message: requireNonBlank(outcome.message, 'submission failure message'),
    retryability: outcome.retryability
  };
}

function validateProviderSubmitOutcome(outcome: ProviderSubmitOutcome): void {
  cloneProviderSubmitOutcome(outcome);
}

function cloneImmediateResult(
  result: ProviderImmediateResultReference
): ProviderImmediateResultReference {
  const value = requireNonBlank(result.value, 'provider result reference');
  if (result.kind === 'base64') {
    return {
      kind: result.kind,
      value,
      mimeType: requireNonBlank(result.mimeType, 'provider result MIME type')
    };
  }
  return { kind: result.kind, value };
}
