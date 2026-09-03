import {
  ConversationApplicationError,
  ConversationWorkflowApplicationError,
  ProjectContextApplicationError
} from '../../application';
import {
  DomainError
} from '../../domain';
import type {
  ChatContextIpcErrorCode,
  ChatContextIpcResult
} from '../../shared/chat-context-ipc';
import {
  ConversationRepositoryDataError,
  ConversationRevisionConflictError,
  ConversationResponseDraftRepositoryDataError,
  ConversationResponseDraftRevisionConflictError,
  ConversationResponseExecutionRepositoryDataError,
  ConversationWorkflowRepositoryDataError,
  ConversationWorkflowRevisionConflictError,
  ProjectContextRepositoryDataError,
  ProjectContextRevisionConflictError,
  ProjectContextSnapshotError
} from '../repositories';
import {
  ConversationResponseExecutionLifecycleError,
  FeatureSubmissionError,
  RuntimeAuthorizationDeniedError,
  SubmissionOrchestrationError
} from '../providers';

export function chatContextFailure<T>(
  error: unknown,
  onError?: (error: unknown) => void
): ChatContextIpcResult<T> {
  onError?.(error);
  if (error instanceof TypeError) {
    return failure('invalid_request', 'The request is invalid');
  }
  if (error instanceof ConversationApplicationError) {
    return failure(
      error.code,
      error.message,
      error.currentRevision
    );
  }
  if (error instanceof ProjectContextApplicationError) {
    return failure(error.code, error.message);
  }
  if (error instanceof ConversationWorkflowApplicationError) {
    return failure(error.code, error.message, error.currentRevision);
  }
  if (error instanceof ConversationRevisionConflictError) {
    return failure(
      'revision_conflict',
      'Conversation revision has changed',
      error.actualRevision ?? undefined
    );
  }
  if (error instanceof ProjectContextRevisionConflictError) {
    return failure(
      'revision_conflict',
      'Project context revision has changed',
      error.actualRevision ?? undefined
    );
  }
  if (error instanceof ConversationResponseDraftRevisionConflictError) {
    return failure(
      'revision_conflict',
      'Conversation response draft revision has changed',
      error.actualRevision ?? undefined
    );
  }
  if (error instanceof ConversationWorkflowRevisionConflictError) {
    return failure(
      'workflow_revision_conflict',
      'Conversation workflow revision has changed',
      error.actualRevision ?? undefined
    );
  }
  if (error instanceof FeatureSubmissionError) {
    const code = error.code === 'subject_invalid'
      ? 'invalid_request'
      : error.code;
    return failure(code, error.message);
  }
  if (error instanceof SubmissionOrchestrationError) {
    if (error.code === 'authorization_not_claimed') {
      return failure('runtime_not_allowed', error.message);
    }
    if (error.code === 'adapter_contract_invalid') {
      return failure('adapter_unavailable', error.message);
    }
    return failure('storage_error', error.message);
  }
  if (error instanceof RuntimeAuthorizationDeniedError) {
    return failure('runtime_not_allowed', error.message);
  }
  if (error instanceof ProjectContextSnapshotError) {
    const code = error.code === 'context_not_found' ||
      error.code === 'context_revision_not_found' ||
      error.code === 'context_deleted'
      ? 'context_not_found'
      : 'invalid_request';
    return failure(code, error.message);
  }
  if (error instanceof ConversationResponseExecutionLifecycleError) {
    return failure('response_execution_not_found', 'The response execution does not exist');
  }
  if (error instanceof DomainError) {
    return failure(
      error.code === 'invalid_state_transition'
        ? 'conversation_not_active'
        : 'invalid_request',
      error.code === 'invalid_state_transition'
        ? 'The requested state transition is not allowed'
        : 'The request violates a domain rule'
    );
  }
  if (
    error instanceof ConversationRepositoryDataError ||
    error instanceof ProjectContextRepositoryDataError ||
    error instanceof ConversationResponseDraftRepositoryDataError ||
    error instanceof ConversationResponseExecutionRepositoryDataError ||
    error instanceof ConversationWorkflowRepositoryDataError
  ) {
    return failure('storage_error', 'Local data could not be read or saved');
  }
  return failure('storage_error', 'The operation could not be completed');
}

export function failure<T>(
  code: ChatContextIpcErrorCode,
  message: string,
  currentRevision?: number
): ChatContextIpcResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(currentRevision === undefined ? {} : { currentRevision })
    }
  };
}
