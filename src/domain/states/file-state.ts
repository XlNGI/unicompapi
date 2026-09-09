export const fileStates = [
  'pending',
  'writing',
  'verifying',
  'available',
  'missing',
  'read_only',
  'disconnected',
  'corrupted',
  'deleted'
] as const;

export type FileState = (typeof fileStates)[number];
