import path from 'node:path';
import { NodeProjectStorage } from '../../src/platform/storage/node-project-storage';
import { withProjectMetadataTransactionLock } from '../../src/platform/storage/project-metadata-transaction-lock';
import { JsonConversationAgentSessionRepository } from '../../src/platform/repositories/json-conversation-agent-session-repository';
import { toConversationAgentRunId, toProjectId } from '../../src/domain/ids';

function send(kind: string, facts?: Readonly<Record<string, string | number>>) { process.stdout.write(`${JSON.stringify({ kind, ...facts })}\n`); }
async function command(): Promise<void> {
  await new Promise<void>(resolve => { process.stdin.once('data', () => resolve()); process.stdin.resume(); });
  process.stdin.pause();
}
async function main() {
  const [, , root, mode] = process.argv;
  send('ready'); await command();
  if (mode === 'hold') {
    await withProjectMetadataTransactionLock(root, path.join(root, 'entities/project-metadata.json'), async () => { send('held'); await command(); });
    send('released'); return;
  }
  const storage = new NodeProjectStorage(root, { onAtomicWriteStage: async event => {
    if (event.stage === 'before_replace' && event.targetPath.endsWith('project-metadata.json')) await new Promise<void>(resolve => setTimeout(resolve, 80));
  } });
  const repository = new JsonConversationAgentSessionRepository(storage, toProjectId('project-os-lock'));
  try {
    const result = await repository.acquireLease({ sessionId: toConversationAgentRunId('session-os-lock'), ownerId: `owner-${process.pid}`, ttlMs: 10_000 });
    send('result', { status: 'acquired', epoch: result.lease.epoch });
  } catch (error) {
    send('result', { status: 'rejected', code: error instanceof Error ? error.message : 'unknown' });
  }
}
void main().catch(() => { send('error'); process.exitCode = 1; });
