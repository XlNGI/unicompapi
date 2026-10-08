export function shouldCommitResponseFrame(
  previous: { readonly state: string; readonly taskProgress?: readonly unknown[] } | undefined,
  next: { readonly state: string; readonly taskProgress?: readonly unknown[] }
): boolean {
  if (!previous || previous.state !== next.state || next.state !== 'streaming') return true;
  return previous.taskProgress !== next.taskProgress;
}
