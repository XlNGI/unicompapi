/** Host-owned execution admission. Never accepted from Provider/tool arguments. */
export type ExecutionStopReason = 'timeout' | 'cancelled' | 'tool_call_limit' | 'budget_exceeded' |
  'failure_limit' | 'no_progress' | 'unknown_result';
export type ExecutionStage = 'execution' | 'prepare' | 'model' | 'tool' | 'design' | 'repair' |
  'render' | 'check' | 'publish' | 'register';
export interface ExecutionBudgetPolicy {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly maxToolCalls: number;
  /** Scheduling units, not currency or a Provider price. */
  readonly budgetUnits: number;
}
export interface ExecutionBudgetDiagnostic {
  readonly stopReason: ExecutionStopReason;
  readonly timeoutScope: ExecutionStage;
  readonly parentElapsedMs: number;
  readonly parentRemainingMs: number;
  readonly childElapsedMs?: number;
  readonly childRemainingMs?: number;
  readonly toolCallsUsed: number;
  readonly costUnitsUsed: number;
}
export class ExecutionBudgetError extends Error {
  constructor(readonly code: ExecutionStopReason, readonly scope: ExecutionStage = 'execution') {
    super(code);
    this.name = 'ExecutionBudgetError';
  }
}

export class HostExecutionBudget {
  readonly policy: ExecutionBudgetPolicy;
  private readonly controller = new AbortController();
  private readonly claims = new Map<string, number>();
  private readonly now: () => number;
  private readonly onDiagnostic?: (diagnostic: ExecutionBudgetDiagnostic) => void | Promise<unknown>;
  private timer?: ReturnType<typeof setTimeout>;
  private removeParent?: () => void;
  private disposed = false;
  private reason?: ExecutionStopReason;
  private usedUnits = 0;
  private readonly admittedAt: number;
  private readonly monotonicAt: number;
  private readonly admittedRemaining: number;

  constructor(policy: ExecutionBudgetPolicy, options: {
    readonly signal?: AbortSignal;
    readonly now?: () => number;
    readonly onDiagnostic?: (diagnostic: ExecutionBudgetDiagnostic) => void | Promise<unknown>;
  } = {}) {
    if (!Number.isSafeInteger(policy.startedAt) || !Number.isSafeInteger(policy.deadlineAt) ||
        policy.deadlineAt <= policy.startedAt || policy.deadlineAt - policy.startedAt > 900_000 ||
        !Number.isSafeInteger(policy.maxToolCalls) || policy.maxToolCalls < 1 || policy.maxToolCalls > 256 ||
        !Number.isSafeInteger(policy.budgetUnits) || policy.budgetUnits < 1 || policy.budgetUnits > 1_000_000) {
      throw new TypeError('invalid_execution_budget');
    }
    this.policy = Object.freeze({ ...policy });
    this.now = options.now ?? (() => Date.now());
    this.onDiagnostic = options.onDiagnostic;
    this.admittedAt = this.now();
    this.monotonicAt = performance.now();
    this.admittedRemaining = Math.max(0, this.policy.deadlineAt - this.admittedAt);
    const abort = () => this.cancel('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    this.removeParent = () => options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) abort();
    else if (this.admittedRemaining === 0) this.cancel('timeout');
    else this.timer = setTimeout(() => this.cancel('timeout'), this.admittedRemaining);
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get stopReason(): ExecutionStopReason | undefined { return this.reason; }
  remainingMs(): number {
    if (this.reason || this.disposed) return 0;
    // A backwards wall-clock adjustment cannot extend an admitted run.
    return Math.max(0, Math.min(this.policy.deadlineAt - this.now(),
      this.admittedRemaining - Math.max(0, performance.now() - this.monotonicAt)));
  }
  snapshot(reason: ExecutionStopReason, scope: ExecutionStage = 'execution'): ExecutionBudgetDiagnostic {
    return { stopReason: reason, timeoutScope: scope,
      parentElapsedMs: Math.max(0, Math.floor(Math.max(this.now() - this.policy.startedAt,
        this.admittedAt - this.policy.startedAt + performance.now() - this.monotonicAt))),
      parentRemainingMs: Math.floor(Math.max(0, Math.min(this.policy.deadlineAt - this.now(),
        this.admittedRemaining - Math.max(0, performance.now() - this.monotonicAt)))),
      toolCallsUsed: this.claims.size, costUnitsUsed: this.usedUnits };
  }
  assertCanProceed(stage: ExecutionStage = 'execution'): void {
    if (this.disposed) throw new ExecutionBudgetError('cancelled', stage);
    if (!this.reason && this.remainingMs() <= 0) this.cancel('timeout');
    if (this.reason || this.signal.aborted) throw new ExecutionBudgetError(this.reason ?? 'cancelled',
      this.reason === 'timeout' ? 'execution' : stage);
  }
  /** Idempotent claims are charged once, before a new host operation is admitted. */
  reserveToolCall(key: string, units: number): boolean {
    this.assertCanProceed('tool');
    if (!key || key.length > 512 || !Number.isSafeInteger(units) || units < 0 || units > this.policy.budgetUnits) {
      throw new TypeError('invalid_execution_budget_claim');
    }
    const previous = this.claims.get(key);
    if (previous !== undefined) {
      if (previous !== units) throw new TypeError('execution_budget_claim_conflict');
      return false;
    }
    if (this.claims.size >= this.policy.maxToolCalls) {
      this.cancel('tool_call_limit');
      throw new ExecutionBudgetError('tool_call_limit', 'tool');
    }
    if (this.usedUnits + units > this.policy.budgetUnits) {
      this.cancel('budget_exceeded');
      throw new ExecutionBudgetError('budget_exceeded', 'tool');
    }
    this.claims.set(key, units);
    this.usedUnits += units;
    return true;
  }
  /** Only known refusal/replay before execution may refund a newly acquired claim. */
  releaseToolCall(key: string): void {
    const units = this.claims.get(key);
    if (units === undefined) return;
    this.claims.delete(key);
    this.usedUnits -= units;
  }
  cancel(reason: ExecutionStopReason = 'cancelled'): void {
    if (this.reason || this.disposed) return;
    this.reason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort(new ExecutionBudgetError(reason));
    this.report(this.snapshot(reason));
  }

  /** Race cancellation even when a plugin ignores AbortSignal; never admit its late continuation. */
  async run<T>(stage: ExecutionStage, operation: (signal: AbortSignal) => Promise<T>, childTimeoutMs?: number): Promise<T> {
    this.assertCanProceed(stage);
    if (childTimeoutMs !== undefined && (!Number.isFinite(childTimeoutMs) || childTimeoutMs <= 0 || childTimeoutMs > 900_000)) {
      throw new TypeError('invalid_child_execution_timeout');
    }
    const child = new AbortController();
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop!: (error: ExecutionBudgetError) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    void stopped.catch(() => undefined);
    const onAbort = () => {
      const error = new ExecutionBudgetError(this.reason ?? 'cancelled', 'execution');
      child.abort(error);
      rejectStop(error);
    };
    this.signal.addEventListener('abort', onAbort, { once: true });
    if (this.signal.aborted) onAbort();
    if (childTimeoutMs !== undefined && childTimeoutMs < this.remainingMs()) {
      timer = setTimeout(() => {
        const error = new ExecutionBudgetError('timeout', stage);
        child.abort(error);
        this.report({ ...this.snapshot('timeout', stage), childElapsedMs: Math.max(0, this.now() - startedAt), childRemainingMs: 0 });
        rejectStop(error);
      }, childTimeoutMs);
    }
    let pending: Promise<T>;
    try {
      this.assertCanProceed(stage);
      pending = Promise.resolve(operation(child.signal));
      // A late rejection remains observed after the race has been won by Stop.
      void pending.catch(() => undefined);
      const result = await Promise.race([pending, stopped]);
      this.assertCanProceed(stage);
      return result;
    } catch (error) {
      this.assertCanProceed(stage);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.signal.removeEventListener('abort', onAbort);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.removeParent?.();
    this.controller.abort(new ExecutionBudgetError(this.reason ?? 'cancelled'));
  }
  private report(diagnostic: ExecutionBudgetDiagnostic): void {
    try { void Promise.resolve(this.onDiagnostic?.(diagnostic)).catch(() => undefined); }
    catch { /* Audit failure cannot authorize another operation. */ }
  }
}
