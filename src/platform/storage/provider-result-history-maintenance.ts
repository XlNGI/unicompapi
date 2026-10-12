import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { NodeProjectStorage } from './node-project-storage';
import { projectStoragePaths } from './project-paths';

export async function prepareProviderResultHistory(rootDirectory: string): Promise<void> {
  const storage = new NodeProjectStorage(rootDirectory);
  await storage.withExclusiveAccess([
    projectStoragePaths.entities.metadataUnit,
    projectStoragePaths.entities.providerOperations
  ], () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'provider-result-history-worker.js'), {
      workerData: { rootDirectory }
    });
    let completed = false;
    const timeout = setTimeout(() => {
      worker.postMessage('cancel');
    }, 120_000);
    worker.once('message', (message: unknown) => {
      completed = message === 'completed';
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 && completed) resolve();
      else reject(new Error('Provider result history maintenance did not finish'));
    });
  }));
}
