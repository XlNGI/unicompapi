export type SubmissionProgressPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'requesting'
  | 'waiting'
  | 'completed'
  | 'failed';

const STEPS = [
  { id: 'prepare', label: '准备' },
  { id: 'request', label: '请求中' },
  { id: 'wait', label: '等待上游返回数据' },
  { id: 'done', label: '完成' }
] as const;

interface SubmissionProgressStepsProps {
  readonly phase: SubmissionProgressPhase;
  readonly failureMessage?: string;
}

export function SubmissionProgressSteps({
  phase,
  failureMessage
}: SubmissionProgressStepsProps) {
  if (phase === 'idle') return null;

  // ready = prepare finished; waiting for user confirm (no active execution step).
  const activeIndex =
    phase === 'preparing'
      ? 0
      : phase === 'ready'
        ? -1
        : phase === 'requesting'
          ? 1
          : phase === 'waiting'
            ? 2
            : phase === 'completed' || phase === 'failed'
              ? 3
              : -1;
  const completedThrough =
    phase === 'ready' || phase === 'requesting'
      ? 0
      : phase === 'waiting'
        ? 1
        : phase === 'completed'
          ? 3
          : phase === 'failed'
            ? Math.max(-1, activeIndex - 1)
            : -1;

  return (
    <div
      aria-live="polite"
      className="uc-submission-progress"
      role="status"
    >
      <ol className="uc-submission-progress__steps">
        {STEPS.map((step, index) => {
          const done =
            phase === 'completed' ||
            (phase !== 'failed' && index <= completedThrough);
          const active =
            phase !== 'completed' &&
            phase !== 'failed' &&
            phase !== 'ready' &&
            index === activeIndex;
          const failed = phase === 'failed' && index === Math.max(activeIndex, 0);
          return (
            <li
              className={[
                'uc-submission-progress__step',
                done ? 'is-done' : '',
                active ? 'is-active' : '',
                failed ? 'is-failed' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              key={step.id}
            >
              <span aria-hidden="true" className="uc-submission-progress__index">
                {index + 1}
              </span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>
      {phase === 'ready' ? (
        <p className="uc-submission-progress__hint">
          准备已完成。请勾选下方确认项，再点击「确认并提交」。
        </p>
      ) : null}
      {phase === 'failed' && failureMessage ? (
        <p className="uc-submission-progress__failure">{failureMessage}</p>
      ) : null}
    </div>
  );
}
