import { useEffect, useRef, useState } from 'react';
import {
  LuBadgeCheck,
  LuFileText,
  LuImage,
  LuMessageCircle
} from 'react-icons/lu';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ConversationCandidateDto,
  ProjectContextCandidateDto
} from '../../shared/chat-context-ipc';

export interface WorkspaceContextReference {
  readonly kind: 'project_asset' | 'project_context' | 'saved_conversation';
  readonly referenceId: string;
  readonly contextRevision?: number;
  readonly includeInPrompt?: boolean;
}

interface WorkspaceContextSelectorProps {
  readonly disabled?: boolean;
  readonly references: readonly WorkspaceContextReference[];
  readonly onChange: (references: readonly WorkspaceContextReference[]) => void;
  readonly onMessage: (message: string) => void;
  readonly projectContextsOnly?: boolean;
}

type SelectableKind = 'project_context' | 'saved_conversation';

const sections: readonly {
  readonly kind: WorkspaceContextReference['kind'];
  readonly title: string;
  readonly description: string;
  readonly action: string;
}[] = [
  {
    kind: 'project_asset',
    title: '项目素材',
    description: '项目素材候选继续由独立受控素材端口负责。',
    action: '选择项目素材'
  },
  {
    kind: 'project_context',
    title: '项目上下文',
    description: '只展示当前项目已登记的安全内容预览。',
    action: '选择项目上下文'
  },
  {
    kind: 'saved_conversation',
    title: '已保存的对话',
    description: '只展示显式绑定当前项目的安全摘要。',
    action: '选择已保存对话'
  }
];

export function WorkspaceContextSelector({
  disabled = false,
  references,
  onChange,
  onMessage,
  projectContextsOnly = false
}: WorkspaceContextSelectorProps) {
  const chat = window.unicomp?.chatContexts;
  const settings = window.unicomp?.settings;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [permissions, setPermissions] = useState<{
    readonly projectContexts: boolean;
    readonly savedChats: boolean;
  }>();
  const [openKind, setOpenKind] = useState<SelectableKind>();
  const [contexts, setContexts] = useState<readonly ProjectContextCandidateDto[]>([]);
  const [conversations, setConversations] = useState<readonly ConversationCandidateDto[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    if (!settings) return;
    void settings.getSnapshot().then((result) => {
      if (!active || !result.ok) return;
      setPermissions({
        projectContexts: result.value.values.privacy.readProjectContext,
        savedChats: result.value.values.privacy.readSavedProjectChats
      });
    }).catch(() => {
      if (active) onMessage('读取上下文隐私设置失败，候选保持不可用。');
    });
    return () => {
      active = false;
    };
  }, [onMessage, settings]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (openKind && dialog && !dialog.open) dialog.showModal();
  }, [openKind]);

  async function openSelector(kind: SelectableKind) {
    if (!chat || disabled || loading) return;
    if (kind === 'project_context' && !permissions?.projectContexts) {
      onMessage('隐私设置已关闭“读取项目上下文”，当前不会展示候选。');
      return;
    }
    if (kind === 'saved_conversation' && !permissions?.savedChats) {
      onMessage('隐私设置已关闭“读取已保存项目对话”，当前不会展示候选。');
      return;
    }
    setOpenKind(kind);
    setLoading(true);
    onMessage('');
    try {
      if (kind === 'project_context') {
        const result = await chat.listProjectContextCandidates();
        if (!result.ok) {
          onMessage(result.error.message);
          setContexts([]);
        } else {
          setContexts(result.value);
        }
      } else {
        const result = await chat.listConversationCandidates();
        if (!result.ok) {
          onMessage(result.error.message);
          setConversations([]);
        } else {
          setConversations(result.value);
        }
      }
    } catch {
      onMessage('读取上下文候选失败，请重试。');
    } finally {
      setLoading(false);
    }
  }

  function toggle(
    kind: SelectableKind,
    referenceId: string,
    checked: boolean,
    contextRevision?: number
  ) {
    if (kind === 'project_context' && contextRevision === undefined) {
      onMessage('项目上下文 revision 无效，请重新读取候选。');
      return;
    }
    const exists = references.some(
      (reference) => reference.kind === kind && reference.referenceId === referenceId
    );
    if (checked) {
      const next = kind === 'project_context'
        ? {
            kind,
            referenceId,
            contextRevision,
            includeInPrompt: true
          } as const
        : { kind, referenceId } as const;
      onChange([
        ...references.filter(
          (reference) =>
            reference.kind !== kind || reference.referenceId !== referenceId
        ),
        next
      ]);
    } else if (!checked && exists) {
      onChange(
        references.filter(
          (reference) =>
            reference.kind !== kind || reference.referenceId !== referenceId
        )
      );
    }
  }

  const candidates = openKind === 'project_context' ? contexts : conversations;
  const visibleSections = projectContextsOnly
    ? sections.filter((section) => section.kind === 'project_context')
    : sections;

  return (
    <>
      <div className="uc-image-professional__contexts">
        {visibleSections.map((section) => {
          const count = references.filter((reference) => reference.kind === section.kind).length;
          const permitted = section.kind === 'project_asset'
            ? false
            : section.kind === 'project_context'
              ? permissions?.projectContexts === true
              : permissions?.savedChats === true;
          return (
            <section className="uc-image-professional__context" key={section.kind}>
              <div>
                <strong>{section.title}</strong>
                <span>{section.description}</span>
              </div>
              <div className="uc-image-professional__context-action">
                <Button
                  disabled={disabled || !chat || !permitted}
                  onClick={() => {
                    if (section.kind !== 'project_asset') void openSelector(section.kind);
                  }}
                  title={
                    section.kind === 'project_asset'
                      ? '项目素材候选端口不在本次对话与上下文接线范围'
                      : permitted
                        ? undefined
                        : '隐私设置关闭或尚未读取'
                  }
                  variant="secondary"
                >
                  {section.kind === 'project_asset' ? (
                    <LuImage aria-hidden="true" />
                  ) : section.kind === 'project_context' ? (
                    <LuFileText aria-hidden="true" />
                  ) : (
                    <LuMessageCircle aria-hidden="true" />
                  )}
                  {section.action}
                </Button>
                <span>已明确选择 {count} 项</span>
              </div>
            </section>
          );
        })}
      </div>
      <p className="uc-image-quick__hint">
        候选只在点击后读取；保存草稿不构成向服务商外发授权。
      </p>

      {openKind ? (
        <dialog
          aria-labelledby="workspace-context-selector-title"
          className="uc-context-selector__dialog"
          onCancel={() => setOpenKind(undefined)}
          ref={dialogRef}
        >
          <header>
            <div>
              <h2 id="workspace-context-selector-title">
                {openKind === 'project_context' ? '选择项目上下文' : '选择已保存对话'}
              </h2>
              <p>
                {openKind === 'project_context'
                  ? '内容来自当前项目已登记版本。'
                  : '这里只显示安全摘要，不读取消息正文。'}
              </p>
            </div>
            <StatusPill>{references.filter((item) => item.kind === openKind).length} 项已选</StatusPill>
          </header>
          {loading ? (
            <EmptyState busy description="正在读取当前项目候选。" icon="读" title="读取中" />
          ) : candidates.length === 0 ? (
            <EmptyState
              description={
                openKind === 'project_context'
                  ? '请先在对话页明确选择内容并登记到当前项目。'
                  : '当前项目没有显式绑定且可用的已保存对话。'
              }
              icon="选"
              readOnly
              title="暂无候选"
            />
          ) : (
            <div className="uc-context-selector__list">
              {openKind === 'project_context'
                ? contexts.map((candidate) => (
                    <label key={candidate.contextId}>
                      <input
                        checked={references.some(
                          (item) =>
                            item.kind === openKind &&
                            item.referenceId === candidate.contextId &&
                            item.contextRevision === candidate.revision &&
                            item.includeInPrompt === true
                        )}
                        onChange={(event) => toggle(
                          openKind,
                          candidate.contextId,
                          event.target.checked,
                          candidate.revision
                        )}
                        type="checkbox"
                      />
                      <span>
                        <strong>{candidate.labels.join('、') || '未命名上下文'}</strong>
                        <small>{candidate.contentPreview}</small>
                        <small>revision {candidate.revision} · {sourceStatusLabel(candidate.sourceStatus)}</small>
                      </span>
                    </label>
                  ))
                : conversations.map((candidate) => (
                    <label key={candidate.conversationId}>
                      <input
                        checked={references.some((item) => item.kind === openKind && item.referenceId === candidate.conversationId)}
                        onChange={(event) => toggle(openKind, candidate.conversationId, event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{candidate.title}</strong>
                        <small>{candidate.status === 'archived' ? '已归档' : '进行中'} · {candidate.messageCount} 条消息 · {candidate.completedMessageCount} 条已完成</small>
                      </span>
                    </label>
                  ))}
            </div>
          )}
          <div className="uc-context-selector__actions">
            <Button onClick={() => setOpenKind(undefined)}>
              <LuBadgeCheck aria-hidden="true" />
              完成
            </Button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}

function sourceStatusLabel(status: ProjectContextCandidateDto['sourceStatus']) {
  if (status === 'source_deleted') return '来源对话已删除，登记快照仍有效';
  if (status === 'source_unavailable') return '来源暂不可用，登记快照仍保留';
  return '来源可用';
}
