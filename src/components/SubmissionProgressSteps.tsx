export type SubmissionProgressPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'requesting'
  | 'waiting'
  | 'completed'
  | 'uncertain'
  | 'failed'
  | 'submission_uncertain'
  | 'submission_failed';

const STEPS = [
  { id: 'prepare', label: '准备' },
  { id: 'request', label: '提交中' },
  { id: 'wait', label: '生成中' },
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
            : phase === 'submission_uncertain' || phase === 'submission_failed'
              ? 1
              : phase === 'uncertain' || phase === 'failed'
                ? 2
                : phase === 'completed'
                  ? 3
                  : -1;
  const completedThrough =
    phase === 'ready' || phase === 'requesting' ||
    phase === 'submission_uncertain' || phase === 'submission_failed'
      ? 0
      : phase === 'waiting' || phase === 'uncertain' || phase === 'failed'
        ? 1
        : phase === 'completed'
          ? 3
          : -1;
  const failurePhase = phase === 'failed' || phase === 'submission_failed';
  const uncertainPhase = phase === 'uncertain' || phase === 'submission_uncertain';

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
            index <= completedThrough;
          const active =
            phase !== 'completed' &&
            !failurePhase &&
            !uncertainPhase &&
            phase !== 'ready' &&
            index === activeIndex;
          const failed = failurePhase && index === activeIndex;
          const uncertain = uncertainPhase && index === activeIndex;
          const label = uncertain
            ? step.id === 'request' ? '提交状态待确认' : '生成状态待确认'
            : failed
              ? step.id === 'request' ? '提交失败' : '生成失败'
              : done && step.id === 'request'
                ? '提交成功'
                : step.label;
          return (
            <li
              className={[
                'uc-submission-progress__step',
                done ? 'is-done' : '',
                active ? 'is-active' : '',
                uncertain ? 'is-uncertain' : '',
                failed ? 'is-failed' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              key={step.id}
            >
              <span aria-hidden="true" className="uc-submission-progress__index">
                {index + 1}
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>
      {phase === 'ready' ? (
        <p className="uc-submission-progress__hint">
          准备已完成。请勾选下方确认项，再点击「确认并提交」。
        </p>
      ) : null}
      {failurePhase && failureMessage ? (
        <p className="uc-submission-progress__failure">{failureMessage}</p>
      ) : null}
      {uncertainPhase && failureMessage ? (
        <p className="uc-submission-progress__uncertain">{failureMessage}</p>
      ) : null}
    </div>
  );
}
