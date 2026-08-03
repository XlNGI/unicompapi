import {
  createConversationResponseStreamEvent,
  projectConversationResponseExecution,
  toControlledConversationResponseStreamEventDto,
  type ControlledConversationResponseStreamEventDtoV1,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionRepository,
  type ConversationResponseExecutionV1,
  type ConversationResponseInterruptionReason,
  type ConversationResponseStreamEventId,
  type ConversationResponseStreamEventType,
  type ConversationResponseStreamEventV1,
  type IsoTimestamp
} from '../../domain';

export interface ConversationResponseStreamEventIdFactory {
  nextConversationResponseStreamEventId(): ConversationResponseStreamEventId;
}

export class ConversationResponseExecutionLifecycleError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationResponseExecutionLifecycleError';
  }
}

export class ConversationResponseExecutionLifecycle {
  constructor(
    private readonly repository: ConversationResponseExecutionRepository,
    private readonly ids: ConversationResponseStreamEventIdFactory,
    private readonly channel?: ControlledConversationResponseStreamChannel,
    private readonly now: () => IsoTimestamp = () => new Date().toISOString() as IsoTimestamp
  ) {}

  start(executionId: ConversationResponseExecutionId): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'stream_started');
  }

  appendContent(
    executionId: ConversationResponseExecutionId,
    contentDelta: string
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'content_delta', { contentDelta });
  }

  complete(
    executionId: ConversationResponseExecutionId
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'stream_completed');
  }

  requestCancel(
    executionId: ConversationResponseExecutionId
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'cancel_requested');
  }

  confirmCancelled(
    executionId: ConversationResponseExecutionId
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'stream_cancelled');
  }

  fail(
    executionId: ConversationResponseExecutionId,
    safeCode: string
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'stream_failed', { safeCode });
  }

  interrupt(
    executionId: ConversationResponseExecutionId,
    interruptionReason: ConversationResponseInterruptionReason
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'stream_interrupted', { interruptionReason });
  }

  resume(
    executionId: ConversationResponseExecutionId
  ): Promise<ConversationResponseStreamEventV1> {
    return this.append(executionId, 'stream_resumed');
  }

  async interruptActiveForApplicationShutdown(): Promise<number> {
    const active = (await this.repository.list()).filter(
      (execution) => execution.state === 'pending' || execution.state === 'streaming'
    );
    for (const execution of active) {
      await this.interrupt(execution.id, 'application_shutdown');
    }
    this.channel?.disconnectAll('application_shutdown');
    return active.length;
  }

  async readModel(executionId: ConversationResponseExecutionId) {
    const execution = await this.requireExecution(executionId);
    const events = await this.repository.listEvents(executionId);
    return projectConversationResponseExecution({ execution, events });
  }

  async replayControlledEvents(
    executionId: ConversationResponseExecutionId,
    afterSequence = 0
  ): Promise<readonly ControlledConversationResponseStreamEventDtoV1[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ConversationResponseExecutionLifecycleError(
        'Conversation response replay sequence is invalid'
      );
    }
    const execution = await this.requireExecution(executionId);
    return (await this.repository.listEvents(executionId))
      .filter((event) => event.sequence > afterSequence)
      .map((event) => toControlledConversationResponseStreamEventDto({ execution, event }));
  }

  private async append(
    executionId: ConversationResponseExecutionId,
    type: ConversationResponseStreamEventType,
    details: {
      readonly contentDelta?: string;
      readonly safeCode?: string;
      readonly interruptionReason?: ConversationResponseInterruptionReason;
    } = {}
  ): Promise<ConversationResponseStreamEventV1> {
    const execution = await this.requireExecution(executionId);
    const events = await this.repository.listEvents(executionId);
    const event = createConversationResponseStreamEvent({
      id: this.ids.nextConversationResponseStreamEventId(),
      responseExecutionId: executionId,
      sequence: events.length + 1,
      type,
      ...details,
      occurredAt: this.now()
    });
    await this.repository.appendEvent(event);
    this.channel?.publish(toControlledConversationResponseStreamEventDto({ execution, event }));
    return event;
  }

  private async requireExecution(
    executionId: ConversationResponseExecutionId
  ): Promise<ConversationResponseExecutionV1> {
    const execution = await this.repository.get(executionId);
    if (!execution) {
      throw new ConversationResponseExecutionLifecycleError(
        'Conversation response execution does not exist'
      );
    }
    return execution;
  }
}

export type ControlledConversationResponseDisconnectReason =
  | 'renderer_disconnected'
  | 'backpressure_exceeded'
  | 'application_shutdown';

interface ControlledSubscription {
  readonly subscriberId: string;
  readonly executionId: string;
  readonly maximumInFlight: number;
  readonly inFlight: Set<number>;
  readonly onEvent: (event: ControlledConversationResponseStreamEventDtoV1) => void;
  readonly onDisconnect?: (reason: ControlledConversationResponseDisconnectReason) => void;
}

export class ControlledConversationResponseStreamChannel {
  private readonly subscriptions = new Map<string, ControlledSubscription>();

  subscribe(input: {
    readonly subscriberId: string;
    readonly executionId: ConversationResponseExecutionId;
    readonly maximumInFlight?: number;
    readonly onEvent: (event: ControlledConversationResponseStreamEventDtoV1) => void;
    readonly onDisconnect?: (reason: ControlledConversationResponseDisconnectReason) => void;
  }): void {
    const subscriberId = input.subscriberId.trim();
    const maximumInFlight = input.maximumInFlight ?? 32;
    if (
      subscriberId.length === 0 ||
      this.subscriptions.has(subscriberId) ||
      !Number.isSafeInteger(maximumInFlight) ||
      maximumInFlight < 1 ||
      maximumInFlight > 1024
    ) {
      throw new ConversationResponseExecutionLifecycleError(
        'Controlled conversation response subscription is invalid'
      );
    }
    this.subscriptions.set(subscriberId, {
      subscriberId,
      executionId: input.executionId,
      maximumInFlight,
      inFlight: new Set(),
      onEvent: input.onEvent,
      ...(input.onDisconnect ? { onDisconnect: input.onDisconnect } : {})
    });
  }

  publish(event: ControlledConversationResponseStreamEventDtoV1): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.executionId !== event.responseExecutionId) continue;
      if (subscription.inFlight.size >= subscription.maximumInFlight) {
        this.disconnect(subscription.subscriberId, 'backpressure_exceeded');
        continue;
      }
      subscription.inFlight.add(event.sequence);
      try {
        subscription.onEvent(event);
      } catch {
        this.disconnect(subscription.subscriberId, 'renderer_disconnected');
      }
    }
  }

  acknowledge(subscriberId: string, sequence: number): void {
    const subscription = this.subscriptions.get(subscriberId);
    if (!subscription || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new ConversationResponseExecutionLifecycleError(
        'Controlled conversation response acknowledgement is invalid'
      );
    }
    for (const pending of [...subscription.inFlight]) {
      if (pending <= sequence) subscription.inFlight.delete(pending);
    }
  }

  disconnect(
    subscriberId: string,
    reason: ControlledConversationResponseDisconnectReason = 'renderer_disconnected'
  ): void {
    const subscription = this.subscriptions.get(subscriberId);
    if (!subscription) return;
    this.subscriptions.delete(subscriberId);
    subscription.onDisconnect?.(reason);
  }

  disconnectAll(reason: ControlledConversationResponseDisconnectReason): void {
    for (const subscriberId of [...this.subscriptions.keys()]) {
      this.disconnect(subscriberId, reason);
    }
  }
}
