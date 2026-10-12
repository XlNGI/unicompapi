import { parentPort, workerData } from 'node:worker_threads';
import { NodeProjectStorage } from './node-project-storage';
import { ProjectMetadataUnitOfWork } from './project-metadata-unit-of-work';
import { ProjectSubmissionAcceptanceStore } from './project-submission-acceptance';
import { JsonProviderOperationRepository } from '../repositories/json-provider-operation-repository';

let cancelled = false;
parentPort?.on('message', (message: unknown) => {
  if (message === 'cancel') cancelled = true;
});

async function run(): Promise<void> {
  if (!parentPort || typeof workerData?.rootDirectory !== 'string') {
    throw new Error('Provider result history maintenance requires a project');
  }
  const storage = new NodeProjectStorage(workerData.rootDirectory);
  await new ProjectSubmissionAcceptanceStore(new ProjectMetadataUnitOfWork(storage)).compactResultHistory();
  if (cancelled) throw new Error('Provider result history maintenance cancelled');
  await new JsonProviderOperationRepository(storage).compactResultHistory();
  if (cancelled) throw new Error('Provider result history maintenance cancelled');
  parentPort.postMessage('completed');
}

void run().finally(() => parentPort?.close());
