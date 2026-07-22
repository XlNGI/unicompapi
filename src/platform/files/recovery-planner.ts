import type { FileState } from '../../domain';
import type { FileProbeIssue, FileStatusProbeResult } from './file-status-probe';

export type RecoveryAction =
  | 'recheck'
  | 'reconnect_storage'
  | 'relink_file'
  | 'choose_writable_directory'
  | 'restore_backup'
  | 'redownload';

export interface RecoveryPlan {
  readonly state: FileState;
  readonly issues: readonly FileProbeIssue[];
  readonly actions: readonly RecoveryAction[];
  readonly message: string;
}

export function planFileRecovery(
  result: FileStatusProbeResult
): RecoveryPlan {
  if (result.issues.length === 0) {
    return {
      state: result.recommendedState,
      issues: [],
      actions: [],
      message: 'File is available and locally verified.'
    };
  }

  const actions = new Set<RecoveryAction>();

  for (const issue of result.issues) {
    if (issue === 'storage_disconnected') {
      actions.add('reconnect_storage');
      actions.add('recheck');
    }

    if (issue === 'not_found' || issue === 'invalid_path') {
      actions.add('relink_file');
      actions.add('restore_backup');
    }

    if (issue === 'project_directory_read_only' || issue === 'permission_denied') {
      actions.add('choose_writable_directory');
      actions.add('recheck');
    }

    if (issue === 'checksum_mismatch' || issue === 'not_a_regular_file') {
      actions.add('restore_backup');
      actions.add('redownload');
    }
  }

  return {
    state: result.recommendedState,
    issues: result.issues,
    actions: [...actions],
    message: messageForState(result.recommendedState)
  };
}

function messageForState(state: FileState): string {
  switch (state) {
    case 'missing':
      return 'The referenced file is missing. Choose a replacement or restore it.';
    case 'disconnected':
      return 'The storage device is unavailable. Reconnect it before retrying.';
    case 'read_only':
      return 'The file or project directory is not writable.';
    case 'corrupted':
      return 'The local file does not match its recorded verification evidence.';
    default:
      return 'The file requires attention before it can be used.';
  }
}
