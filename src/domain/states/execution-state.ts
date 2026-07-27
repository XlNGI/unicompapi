export const executionStates = [
  'created',
  'submitting',
  'queued',
  'processing',
  'validating_sources',
  'preparing_media',
  'encoding',
  'writing_file',
  'verifying_file',
  'registering_work',
  'remote_completed',
  'downloading',
  'writing',
  'verifying',
  'completed',
  'cancel_requested',
  'cancelled',
  'cancellation_unknown',
  'needs_user_action',
  'interrupted',
  'recovery_required',
  'failed',
  'expired'
] as const;

export type ExecutionState = (typeof executionStates)[number];

export const terminalExecutionStates: readonly ExecutionState[] = [
  'completed',
  'cancelled',
  'failed',
  'expired'
];

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return terminalExecutionStates.includes(state);
}
