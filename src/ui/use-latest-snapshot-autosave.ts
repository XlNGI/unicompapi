import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LatestSnapshotAutosave,
  type AutosaveError,
  type AutosavePhase,
  type AutosaveResult,
  type AutosaveState
} from '../application';
import { registerAutosaveFlush } from './autosave-flush-registry';

const initialState: AutosaveState = {
  phase: 'saved',
  hasInFlight: false,
  hasPending: false,
  retryAttempt: 0
};

interface UseLatestSnapshotAutosaveOptions<
  TSnapshot,
  TError extends AutosaveError
> {
  readonly save: (
    snapshot: TSnapshot
  ) => Promise<AutosaveResult<TSnapshot, TError>>;
  readonly rebase: (pending: TSnapshot, persisted: TSnapshot) => TSnapshot;
  readonly classifyError: (
    error: TError
  ) => 'retryable' | 'conflict' | 'terminal';
  readonly onPersisted: (
    persisted: TSnapshot,
    rebasedPending?: TSnapshot
  ) => void;
  readonly onError: (
    error: TError | Error,
    phase: 'retrying' | 'failed' | 'conflict'
  ) => void;
  readonly debounceMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly diagnostics?: {
    readonly surface: 'image_generation' | 'video_generation';
    readonly getDraftId: (snapshot: TSnapshot) => string;
  };
}

export interface LatestSnapshotAutosaveHandle<TSnapshot> {
  readonly phase: AutosavePhase;
  readonly hasUnsavedChanges: boolean;
  readonly queue: (snapshot: TSnapshot) => void;
  readonly flush: (deadlineMs?: number) => Promise<boolean>;
  readonly retry: () => Promise<boolean>;
  readonly reset: () => void;
}

export function useLatestSnapshotAutosave<
  TSnapshot,
  TError extends AutosaveError
>(
  options: UseLatestSnapshotAutosaveOptions<TSnapshot, TError>
): LatestSnapshotAutosaveHandle<TSnapshot> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);
  const diagnosticDraftIdRef = useRef('');
  const diagnosticErrorCodeRef = useRef<string>();
  const [state, setState] = useState(initialState);
  const coordinatorRef = useRef<LatestSnapshotAutosave<TSnapshot, TError>>();

  if (!coordinatorRef.current) {
    coordinatorRef.current = new LatestSnapshotAutosave({
      debounceMs: options.debounceMs ?? 1_000,
      retryDelaysMs: options.retryDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 8_000],
      save: (snapshot) => optionsRef.current.save(snapshot),
      rebase: (pending, persisted) => optionsRef.current.rebase(pending, persisted),
      classifyError: (error) => optionsRef.current.classifyError(error),
      onPersisted: (persisted, pending) => {
        diagnosticErrorCodeRef.current = undefined;
        optionsRef.current.onPersisted(persisted, pending);
      },
      onError: (error, phase) => {
        diagnosticErrorCodeRef.current = 'code' in error
          ? error.code
          : 'unexpected_error';
        optionsRef.current.onError(error, phase);
      },
      onStateChange: (next) => {
        if (mountedRef.current) setState(next);
      }
    });
  }

  const queue = useCallback((snapshot: TSnapshot) => {
    diagnosticDraftIdRef.current =
      optionsRef.current.diagnostics?.getDraftId(snapshot) ?? '';
    coordinatorRef.current?.queue(snapshot);
  }, []);

  const flush = useCallback(async (deadlineMs = 3_000) => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return true;
    const deadline = new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), deadlineMs);
    });
    return Promise.race([coordinator.flush(), deadline]);
  }, []);

  const retry = useCallback(
    () => coordinatorRef.current?.retry() ?? Promise.resolve(true),
    []
  );

  const reset = useCallback(() => coordinatorRef.current?.reset(), []);

  useEffect(() => {
    mountedRef.current = true;
    return registerAutosaveFlush(flush);
  }, [flush]);

  useEffect(() => {
    const diagnostics = optionsRef.current.diagnostics;
    const draftId = diagnosticDraftIdRef.current;
    if (!diagnostics || !draftId) return;
    window.unicomp?.autosaveDiagnostics.record({
      surface: diagnostics.surface,
      draftId,
      phase: state.phase,
      hasInFlight: state.hasInFlight,
      hasPending: state.hasPending,
      retryAttempt: state.retryAttempt,
      ...(diagnosticErrorCodeRef.current
        ? { errorCode: diagnosticErrorCodeRef.current }
        : {})
    });
  }, [state.hasInFlight, state.hasPending, state.phase, state.retryAttempt]);

  useEffect(() => {
    let allowClose = false;
    let closePending = false;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const coordinator = coordinatorRef.current;
      if (allowClose || !coordinator?.hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
      if (closePending) return;
      closePending = true;
      void flush(3_000).then((saved) => {
        closePending = false;
        if (!saved) return;
        allowClose = true;
        window.unicomp?.windowControls.close();
      });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flush]);

  useEffect(() => () => {
    mountedRef.current = false;
    if (coordinatorRef.current?.hasUnsavedChanges()) {
      void coordinatorRef.current.flush();
    }
  }, []);

  return {
    phase: state.phase,
    hasUnsavedChanges: state.hasInFlight || state.hasPending,
    queue,
    flush,
    retry,
    reset
  };
}
