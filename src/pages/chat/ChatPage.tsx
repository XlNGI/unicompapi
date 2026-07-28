import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type {
  ChatContextIpcErrorCode,
  ConversationDto,
  MessageDto,
  ProjectContextCandidateDto,
  ProjectContextDraftPreviewDto
} from '../../shared/chat-context-ipc';
import type { StorageProjectSessionDto } from '../../shared/storage-ipc';
import '../../styles/pages.css';

const errorMessages: Record<ChatContextIpcErrorCode, string> = {
  invalid_request: '当前操作数据无效，请刷新后重试。',
  project_not_open: '请先打开目标项目。',
  project_scope_mismatch: '当前内容不属于已打开的项目。',
  conversation_not_found: '该对话已不存在。',
  conversation_not_saved: '未保存的对话不能登记为项目上下文。',
  conversation_deleted: '已删除的对话不能继续操作。',
  conversation_not_active: '请先恢复已归档对话。',
  draft_not_found: '上下文草稿已不存在，请重新选择。',
  context_not_found: '项目上下文已不存在。',
  message_not_found: '所选消息已不存在。',
  message_not_completed: '只有已完成的消息才能登记。',
  message_revision_changed: '消息内容已变化，请重新选择。',
  selection_out_of_range: '所选消息范围已经失效。',
  revision_conflict: '内容已在其他位置更新，请刷新后重试。',
  explicit_confirmation_required: '请先明确确认上下文预览。',
  adapter_unavailable: '尚未配置真实对话适配器。',
  storage_error: '本地保存失败，请检查存储状态后重试。'
};

const messageStateLabels: Record<MessageDto['state'], string> = {
  pending: '等待响应',
  streaming: '接收中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

export function ChatPage() {
  const chat = window.unicomp?.chatContexts;
  const storage = window.unicomp?.storage;
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [conversations, setConversations] = useState<readonly ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [newTitle, setNewTitle] = useState('');
  const [bindToProject, setBindToProject] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [input, setInput] = useState('');
  const [contextDraft, setContextDraft] = useState<ProjectContextDraftPreviewDto>();
  const [contextLabels, setContextLabels] = useState('');
  const [contextConfirmed, setContextConfirmed] = useState(false);
  const [registeredContexts, setRegisteredContexts] = useState<
    readonly ProjectContextCandidateDto[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === selectedId),
    [conversations, selectedId]
  );

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      if (!chat || !storage) {
        setNotice('当前运行环境未连接桌面对话能力。');
        setLoading(false);
        return;
      }
      try {
        const [sessionResult, conversationResult] = await Promise.all([
          storage.getProjectSession(),
          chat.listConversations(true, false)
        ]);
        if (!active) return;
        if (sessionResult.ok) setSession(sessionResult.value);
        else setNotice('读取当前项目失败，请重试。');
        if (conversationResult.ok) {
          setConversations(conversationResult.value);
          setSelectedId((current) =>
            conversationResult.value.some((item) => item.conversationId === current)
              ? current
              : conversationResult.value[0]?.conversationId
          );
        } else {
          setNotice(errorMessages[conversationResult.error.code]);
        }
        if (sessionResult.ok && sessionResult.value) {
          const contexts = await chat.listProjectContextCandidates();
          if (active && contexts.ok) setRegisteredContexts(contexts.value);
        }
      } catch {
        if (active) setNotice('读取本地对话失败，请重试。');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [chat, storage]);

  useEffect(() => {
    setRenameTitle(selected?.title ?? '');
    setContextDraft(undefined);
    setContextLabels('');
    setContextConfirmed(false);
  }, [selected?.conversationId, selected?.title]);

  function replaceConversation(conversation: ConversationDto) {
    setConversations((items) =>
      items.map((item) =>
        item.conversationId === conversation.conversationId ? conversation : item
      )
    );
  }

  async function createConversation() {
    if (!chat || busy || !newTitle.trim()) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await chat.createConversation(newTitle.trim(), bindToProject);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setConversations((items) => [result.value, ...items]);
      setSelectedId(result.value.conversationId);
      setNewTitle('');
      setNotice('对话已保存；尚未登记为项目上下文。');
    } catch {
      setNotice('创建对话失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function mutateConversation(
    operation: 'rename' | 'archive' | 'restore' | 'delete'
  ) {
    if (!chat || !selected || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = operation === 'rename'
        ? await chat.renameConversation(
            selected.conversationId,
            selected.revision,
            renameTitle.trim()
          )
        : operation === 'archive'
          ? await chat.archiveConversation(selected.conversationId, selected.revision)
          : operation === 'restore'
            ? await chat.restoreConversation(selected.conversationId, selected.revision)
            : await chat.deleteConversation(selected.conversationId, selected.revision);
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      if (operation === 'delete') {
        const remaining = conversations.filter(
          (item) => item.conversationId !== selected.conversationId
        );
        setConversations(remaining);
        setSelectedId(remaining[0]?.conversationId);
        setNotice('对话已移入墓碑；已登记的项目上下文不会被删除。');
      } else {
        replaceConversation(result.value);
        setNotice(
          operation === 'rename'
            ? '对话名称已更新。'
            : operation === 'archive'
              ? '对话已归档，不再允许追加消息。'
              : '对话已恢复，可以继续追加消息。'
        );
      }
    } catch {
      setNotice('更新对话失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveMessageAndRequestResponse() {
    if (!chat || !selected || selected.status !== 'active' || !input.trim() || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const saved = await chat.addUserMessage(
        selected.conversationId,
        selected.revision,
        input.trim()
      );
      if (!saved.ok) {
        setNotice(errorMessages[saved.error.code]);
        return;
      }
      replaceConversation(saved.value);
      setInput('');
      const response = await chat.requestAssistantResponse(
        saved.value.conversationId,
        saved.value.revision
      );
      if (!response.ok) {
        setNotice(
          response.error.code === 'adapter_unavailable'
            ? '消息已保存；尚未配置真实适配器，因此没有创建 AI 回复。'
            : errorMessages[response.error.code]
        );
        return;
      }
      replaceConversation(response.value);
    } catch {
      setNotice('保存消息失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function toggleMessageSelection(message: MessageDto, checked: boolean) {
    if (!chat || !selected || !session || busy) return;
    setBusy(true);
    setNotice('');
    try {
      let draft = contextDraft;
      if (!draft) {
        const created = await chat.createContextDraft(selected.conversationId);
        if (!created.ok) {
          setNotice(errorMessages[created.error.code]);
          return;
        }
        draft = created.value;
      }
      const existing = draft.fragments.find(
        (fragment) => fragment.messageId === message.messageId
      );
      const result = checked
        ? existing
          ? { ok: true as const, value: draft }
          : await chat.addContextMessageFragment(
              draft.draftId,
              draft.revision,
              message.messageId,
              0,
              message.content.length
            )
        : existing
          ? await chat.removeContextMessageFragment(
              draft.draftId,
              draft.revision,
              existing.fragmentId
            )
          : { ok: true as const, value: draft };
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setContextDraft(result.value);
      setContextConfirmed(false);
      setNotice(
        checked
          ? '消息内容已加入上下文草稿，请检查预览。'
          : '消息内容已从上下文草稿移除。'
      );
    } catch {
      setNotice('更新上下文草稿失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function saveContextLabels() {
    if (!chat || !contextDraft || busy) return;
    const labels = Array.from(new Set(
      contextLabels.split(/[,，]/).map((label) => label.trim()).filter(Boolean)
    ));
    setBusy(true);
    try {
      const result = await chat.updateContextDraftLabels(
        contextDraft.draftId,
        contextDraft.revision,
        labels
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      setContextDraft(result.value);
      setContextConfirmed(false);
      setNotice('上下文标签已更新，请重新确认预览。');
    } catch {
      setNotice('更新上下文标签失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function registerContext() {
    if (!chat || !contextDraft || !contextConfirmed || busy) return;
    setBusy(true);
    try {
      const result = await chat.registerContextDraft(
        contextDraft.draftId,
        contextDraft.revision,
        true
      );
      if (!result.ok) {
        setNotice(errorMessages[result.error.code]);
        return;
      }
      const candidates = await chat.listProjectContextCandidates();
      if (candidates.ok) setRegisteredContexts(candidates.value);
      setContextDraft(undefined);
      setContextLabels('');
      setContextConfirmed(false);
      setNotice(`项目上下文已登记为 revision ${result.value.revision}。`);
    } catch {
      setNotice('登记项目上下文失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  const completedMessages = selected?.messages.filter(
    (message) => message.state === 'completed'
  ) ?? [];

  return (
    <section className="uc-chat-page" aria-labelledby="chat-page-title">
      <aside className="uc-chat-page__history" aria-label="对话列表">
        <div className="uc-chat-page__panel-heading">
          <h2>对话</h2>
          <StatusPill>{conversations.length} 个</StatusPill>
        </div>
        <form
          className="uc-chat-page__new"
          onSubmit={(event) => {
            event.preventDefault();
            void createConversation();
          }}
        >
          <label>
            <span>新对话名称</span>
            <input
              maxLength={200}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="例如：品牌短片构思"
              value={newTitle}
            />
          </label>
          <label className="uc-chat-page__check">
            <input
              checked={bindToProject}
              disabled={!session}
              onChange={(event) => setBindToProject(event.target.checked)}
              type="checkbox"
            />
            绑定当前项目
          </label>
          <Button disabled={busy || !newTitle.trim()} type="submit">创建并保存</Button>
        </form>
        {loading ? (
          <EmptyState busy description="正在读取本地对话历史。" icon="读" title="读取中" />
        ) : conversations.length === 0 ? (
          <EmptyState description="新建后才会保存对话，不会生成示例记录。" icon="对" title="暂无历史对话" />
        ) : (
          <div className="uc-chat-page__history-list">
            {conversations.map((conversation) => (
              <button
                aria-current={conversation.conversationId === selectedId ? 'true' : undefined}
                className="uc-chat-page__history-item"
                key={conversation.conversationId}
                onClick={() => setSelectedId(conversation.conversationId)}
                type="button"
              >
                <strong>{conversation.title}</strong>
                <span>
                  {conversation.status === 'archived' ? '已归档' : '进行中'} ·{' '}
                  {conversation.messages.length} 条消息
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="uc-chat-page__conversation" aria-label="当前对话">
        <header className="uc-chat-page__header">
          <div>
            <div className="uc-page-skeleton__heading-row">
              <h1 className="uc-page-skeleton__title" id="chat-page-title">对话</h1>
              <StatusPill tone={selected?.status === 'active' ? 'info' : 'neutral'}>
                {selected ? (selected.status === 'active' ? '已保存' : '已归档') : '未选择'}
              </StatusPill>
            </div>
            <p className="uc-page-skeleton__description">用于问答、分析、整理和项目上下文沉淀。</p>
          </div>
          <StatusPill tone="warning">适配器不可用</StatusPill>
        </header>

        <Card className="uc-chat-page__offline" role="status">
          <strong>真实 AI 服务尚未接入</strong>
          <p>用户消息可以本地保存；请求回复会返回 adapter_unavailable，不会生成或伪造 AI 回复、进度或费用。</p>
        </Card>

        {!selected ? (
          <div className="uc-chat-page__messages">
            <EmptyState description="请从左侧选择或创建一个已保存对话。" icon="聊" title="尚未选择对话" />
          </div>
        ) : (
          <>
            <Card className="uc-chat-page__conversation-actions">
              <label>
                <span>对话名称</span>
                <input
                  disabled={selected.status === 'deleted'}
                  maxLength={200}
                  onChange={(event) => setRenameTitle(event.target.value)}
                  value={renameTitle}
                />
              </label>
              <div className="uc-chat-page__actions">
                <Button
                  disabled={busy || !renameTitle.trim() || renameTitle.trim() === selected.title}
                  onClick={() => void mutateConversation('rename')}
                  variant="secondary"
                >重命名</Button>
                {selected.status === 'active' ? (
                  <Button disabled={busy} onClick={() => void mutateConversation('archive')} variant="secondary">归档</Button>
                ) : (
                  <Button disabled={busy} onClick={() => void mutateConversation('restore')} variant="secondary">恢复</Button>
                )}
                <Button disabled={busy} onClick={() => void mutateConversation('delete')} variant="ghost">删除</Button>
              </div>
            </Card>
            <div className="uc-chat-page__messages" aria-live="polite">
              {selected.messages.length === 0 ? (
                <EmptyState description="保存第一条用户消息后，它才会进入本地对话历史。" icon="聊" title="还没有对话内容" />
              ) : (
                <ol className="uc-chat-page__message-list">
                  {selected.messages.map((item) => (
                    <li className={`uc-chat-page__message-item uc-chat-page__message-item--${item.role}`} key={item.messageId}>
                      <div>
                        <strong>{item.role === 'user' ? '你' : '助手'}</strong>
                        <StatusPill tone={item.state === 'failed' ? 'danger' : item.state === 'completed' ? 'info' : 'neutral'}>
                          {messageStateLabels[item.state]}
                        </StatusPill>
                      </div>
                      <p>{item.content || '尚无内容'}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}

        <section className="uc-chat-page__composer" aria-labelledby="chat-composer-title">
          <h2 id="chat-composer-title">保存用户消息</h2>
          <textarea
            aria-label="对话输入"
            disabled={!selected || selected.status !== 'active'}
            maxLength={8000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入需要问答、分析或整理的内容"
            rows={5}
            value={input}
          />
          <div className="uc-chat-page__composer-footer">
            <Button disabled title="原生附件登记将在独立小 PR 实现" variant="secondary">添加附件</Button>
            <span>{input.length} / 8000</span>
          </div>
          <div className="uc-chat-page__actions">
            <Button disabled={!input} onClick={() => setInput('')} variant="secondary">清空</Button>
            <Button
              disabled={!chat || !selected || selected.status !== 'active' || !input.trim() || busy}
              onClick={() => void saveMessageAndRequestResponse()}
            >保存消息并请求回复</Button>
          </div>
        </section>
        <p className="uc-chat-page__message" aria-live="polite">{notice}</p>
      </section>

      <aside className="uc-chat-page__context" aria-labelledby="context-draft-title">
        <div className="uc-chat-page__panel-heading">
          <h2 id="context-draft-title">项目上下文草稿</h2>
          <StatusPill tone={session ? 'info' : 'neutral'}>{session ? '当前项目' : '无项目'}</StatusPill>
        </div>
        <Card className="uc-chat-page__context-target">
          <small>目标项目</small>
          <strong>{session?.projectName ?? '尚未打开项目'}</strong>
          <span>已登记 {registeredContexts.length} 项</span>
        </Card>
        {!session ? (
          <EmptyState description="打开项目后才能选择已完成消息并登记上下文。" icon="项" readOnly title="需要目标项目" />
        ) : !selected ? (
          <EmptyState description="请先选择一个已保存对话。" icon="摘" readOnly title="尚未选择对话" />
        ) : completedMessages.length === 0 ? (
          <EmptyState description="pending、streaming、failed 或 cancelled 消息不能登记。" icon="摘" readOnly title="没有可登记消息" />
        ) : (
          <fieldset className="uc-chat-page__selection-list" disabled={busy}>
            <legend>选择整条消息内容</legend>
            {completedMessages.map((item) => (
              <label key={item.messageId}>
                <input
                  checked={Boolean(contextDraft?.fragments.some((fragment) => fragment.messageId === item.messageId))}
                  onChange={(event) => void toggleMessageSelection(item, event.target.checked)}
                  type="checkbox"
                />
                <span><strong>{item.role === 'user' ? '用户' : '助手'}</strong>{item.content}</span>
              </label>
            ))}
          </fieldset>
        )}
        {contextDraft ? (
          <>
            <Card className="uc-chat-page__context-preview">
              <small>草稿预览 · revision {contextDraft.revision}</small>
              <p>{contextDraft.contentPreview || '尚未选择内容'}</p>
            </Card>
            <label className="uc-chat-page__context-labels">
              <span>用户标签（逗号分隔）</span>
              <input
                maxLength={500}
                onChange={(event) => setContextLabels(event.target.value)}
                placeholder="例如：品牌语气，镜头约束"
                value={contextLabels}
              />
            </label>
            <Button disabled={busy} onClick={() => void saveContextLabels()} variant="secondary">更新标签</Button>
            <label className="uc-chat-page__check">
              <input
                checked={contextConfirmed}
                disabled={!contextDraft.canRegister}
                onChange={(event) => setContextConfirmed(event.target.checked)}
                type="checkbox"
              />
              我已检查目标项目、消息内容和标签
            </label>
            <Button
              disabled={!contextDraft.canRegister || !contextConfirmed || busy}
              onClick={() => void registerContext()}
            >确认登记到项目</Button>
          </>
        ) : null}
        <p className="uc-chat-page__notice">保存对话和登记项目上下文是两个独立操作；未选择内容不会被创作页读取。</p>
      </aside>
    </section>
  );
}
