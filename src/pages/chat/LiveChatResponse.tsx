import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { LuChevronRight } from 'react-icons/lu';
import type { ConversationResponseExecutionDto } from '../../shared/chat-context-ipc';
import { liveReplyCue, reasoningExpanded } from './chatTurnView';
import { StreamingMarkdown } from './StreamingMarkdown';

export interface LiveChatResponseHandle {
  update(execution: ConversationResponseExecutionDto): void;
}

/** Only this reply rerenders for text batches; navigation and composer stay stable. */
function sameLiveReply(
  previous: { readonly execution: ConversationResponseExecutionDto; readonly stopping: boolean; readonly thoughtOpened?: boolean },
  next: { readonly execution: ConversationResponseExecutionDto; readonly stopping: boolean; readonly thoughtOpened?: boolean }
) {
  return previous.execution === next.execution && previous.stopping === next.stopping &&
    previous.thoughtOpened === next.thoughtOpened;
}

export const LiveChatResponse = memo(forwardRef<LiveChatResponseHandle, {
  readonly execution: ConversationResponseExecutionDto;
  readonly stopping: boolean;
  readonly thoughtOpened?: boolean;
  readonly onThoughtToggle: (opened: boolean) => void;
}>(function LiveChatResponse({ execution, stopping, thoughtOpened, onThoughtToggle }, ref) {
  const [snapshot, setSnapshot] = useState(execution);
  const latest = useRef(execution);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const shown = execution.streamSequence > snapshot.streamSequence ? execution : snapshot;
  useImperativeHandle(ref, () => ({
    update(next) {
      latest.current = next;
      if (timer.current !== undefined) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setSnapshot(latest.current);
      }, 100);
    }
  }), []);
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  const cue = liveReplyCue({ productFeature: shown.productFeature,
    reasoning: shown.reasoningContent, content: shown.content, inProgress: true });
  const label = stopping ? '正在停止回复…'
    : cue === 'organizing' ? '正在组织回答'
      : cue === 'thinking' && !shown.reasoningContent.trim() ? '正在思考' : '';
  const thoughtOpen = reasoningExpanded({ reasoning: shown.reasoningContent,
    content: shown.content, inProgress: true, opened: thoughtOpened });
  return <div data-live-response>
    {label ? <p className="uc-chat-page__response-status" aria-label="回复状态" role="status">{label}</p> : null}
    {shown.reasoningContent.trim() ? <div className="uc-chat-turn__thought">
      <button className="uc-chat-turn__disclosure" type="button" aria-expanded={thoughtOpen}
        onClick={() => onThoughtToggle(!thoughtOpen)}>
        <span>思考</span><LuChevronRight aria-hidden="true" />
      </button>
      {thoughtOpen ? <p className="uc-chat-turn__thought-body">{shown.reasoningContent}</p> : null}
    </div> : null}
    <StreamingMarkdown streaming content={shown.content} />
    <span className="uc-chat-page__caret" aria-hidden="true">▌</span>
  </div>;
}), sameLiveReply);
