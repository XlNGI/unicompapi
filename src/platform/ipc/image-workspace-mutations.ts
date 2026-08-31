export class ImageWorkspaceMutationCoordinator {
  private queue: Promise<void> = Promise.resolve();

  wait(): Promise<void> {
    return this.queue;
  }

  enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
