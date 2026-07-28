import {
  ConversationApplicationError,
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
  ProjectContextRepositoryDataError,
  ProjectContextRevisionConflictError
} from '../repositories';

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
    error instanceof ProjectContextRepositoryDataError
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
