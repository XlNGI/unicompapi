import type { MessageDto } from "../../shared/chat-context-ipc";

export interface DocumentProgressProps {
  readonly state?: NonNullable<MessageDto["documentGenerationStatus"]>["state"];
  readonly detail: string;
}

const STEPS = [
  { id: "planning", label: "意图与大纲" },
  { id: "design", label: "版式设计" },
  { id: "rendering", label: "逐页渲染" },
  { id: "checking", label: "质量校验" }
] as const;

function getActiveStepIndex(state?: DocumentProgressProps["state"]): number {
  if (!state || state === "generating_content") return 0;
  if (state === "validating_outline") return 1;
  if (state === "generating_file") return 2;
  if (state === "completed") return 4;
  return 0;
}

/** Execution facts appear in the assistant reply, without a separate progress wizard. */
export function DocumentProgress({ state, detail }: DocumentProgressProps) {
  const activeIndex = getActiveStepIndex(state);
  const isFinished = state === "completed";
  const isFailed = state === "failed" || state === "cancelled" || state === "interrupted";

  return (
    <div className="uc-chat-document-progress" role="status" aria-live="polite">
      <div className="uc-chat-document-progress__steps" aria-label="生成步骤">
        {STEPS.map((step, idx) => {
          const isDone = isFinished || idx < activeIndex;
          const isCurrent = !isFinished && !isFailed && idx === activeIndex;
          return (
            <div
              key={step.id}
              className={`uc-chat-document-progress__step${
                isDone ? " uc-chat-document-progress__step--done" : ""
              }${isCurrent ? " uc-chat-document-progress__step--active" : ""}`}
            >
              <div className="uc-chat-document-progress__step-indicator">
                {isDone ? "✓" : idx + 1}
              </div>
              <span className="uc-chat-document-progress__step-label">{step.label}</span>
              {idx < STEPS.length - 1 && (
                <div className="uc-chat-document-progress__step-connector" />
              )}
            </div>
          );
        })}
      </div>
      <p className="uc-chat-document-progress__detail">{detail}</p>
    </div>
  );
}
