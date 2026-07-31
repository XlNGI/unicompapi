import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const ownership = new AsyncLocalStorage<ReadonlySet<string>>();

export function normalizeAbsoluteStoragePath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new TypeError('Storage coordination requires an absolute path');
  }
  return path.normalize(path.resolve(value));
}

export class FileWriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(absolutePath: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizeAbsoluteStoragePath(absolutePath);
    const owned = ownership.getStore();
    if (owned?.has(key)) return operation();

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => barrier);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    const nextOwnership = new Set(owned ?? []);
    nextOwnership.add(key);
    try {
      return await ownership.run(nextOwnership, operation);
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async runExclusiveMany<T>(
    absolutePaths: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const keys = [...new Set(absolutePaths.map(normalizeAbsoluteStoragePath))].sort();
    const acquire = (index: number): Promise<T> =>
      index === keys.length
        ? operation()
        : this.runExclusive(keys[index], () => acquire(index + 1));
    return acquire(0);
  }
}

export const sharedFileWriteCoordinator = new FileWriteCoordinator();
