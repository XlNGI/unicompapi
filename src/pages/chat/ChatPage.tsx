import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';
import type { StorageProjectSessionDto } from '../../shared/storage-ipc';
import '../../styles/pages.css';

export function ChatPage() {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [session, setSession] = useState<StorageProjectSessionDto>();
  const [message, setMessage] = useState('');
  const storage = window.unicomp?.storage;

  useEffect(() => {
    let active = true;
    if (!storage) {
      setMessage('当前运行环境未连接桌面项目能力');
      return () => {
        active = false;
      };
    }

    void storage.getProjectSession()
      .then((result) => {
        if (!active) return;
        if (result.ok) setSession(result.value);
        else setMessage(`读取当前项目失败：${result.error.message}`);
      })
      .catch(() => {
        if (active) setMessage('读取当前项目失败，请重试');
      });

    return () => {
      active = false;
    };
  }, [storage]);

  function handleAttachments(event: ChangeEvent<HTMLInputElement>) {
    setAttachments(Array.from(event.target.files ?? [], (file) => file.name));
  }

  function clearCurrentConversation() {
    setInput('');
    setAttachments([]);
    setMessage('当前未发送内容已清空');
  }

  return (
    <section className="uc-chat-page" aria-labelledby="chat-page-title">
      <aside className="uc-chat-page__history" aria-label="对话列表">
        <div className="uc-chat-page__panel-heading">
          <h2>对话</h2>
          <StatusPill>仅当前窗口</StatusPill>
        </div>
        <div className="uc-chat-page__current" aria-current="true">
          <strong>当前临时对话</strong>
          <small>未保存</small>
        </div>
        <EmptyState
          title="暂无历史对话"
          description="阶段 3 不保存或伪造对话记录。"
          icon="对"
        />
      </aside>

      <section className="uc-chat-page__conversation" aria-label="当前对话">
        <header className="uc-chat-page__header">
          <div>
            <div className="uc-page-skeleton__heading-row">
              <h1 className="uc-page-skeleton__title" id="chat-page-title">对话</h1>
              <StatusPill tone="warning">服务未配置</StatusPill>
            </div>
            <p className="uc-page-skeleton__description">用于问答、分析、整理和项目上下文沉淀。</p>
          </div>
          <StatusPill tone="warning">离线</StatusPill>
        </header>

        <Card className="uc-chat-page__offline" role="status">
          <strong>AI 服务尚未配置</strong>
          <p>阶段 4 接入服务商后才能发送消息；当前不会生成或伪造 AI 回复。</p>
        </Card>

        <div className="uc-chat-page__messages" aria-live="polite">
          <EmptyState
            title="还没有对话内容"
            description="你可以先整理问题和选择附件，但离开页面后这些未发送内容会清空。"
            icon="聊"
          />
        </div>

        <section className="uc-chat-page__composer" aria-labelledby="chat-composer-title">
          <h2 id="chat-composer-title">整理当前问题</h2>
          <textarea
            aria-label="对话输入"
            maxLength={8000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入需要问答、分析或整理的内容"
            rows={5}
            value={input}
          />
          <div className="uc-chat-page__composer-footer">
            <label className="uc-chat-page__attachment">
              选择当前对话附件
              <input multiple onChange={handleAttachments} type="file" />
            </label>
            <span>{input.length} / 8000</span>
          </div>
          {attachments.length > 0 && (
            <ul className="uc-chat-page__attachments" aria-label="当前对话附件">
              {attachments.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
            </ul>
          )}
          <div className="uc-chat-page__actions">
            <Button
              disabled={!input && attachments.length === 0}
              onClick={clearCurrentConversation}
              variant="secondary"
            >
              清空当前内容
            </Button>
            <Button disabled>服务未配置，无法发送</Button>
          </div>
        </section>
        <p className="uc-chat-page__message" aria-live="polite">{message}</p>
      </section>

      <aside className="uc-chat-page__context" aria-labelledby="context-draft-title">
        <div className="uc-chat-page__panel-heading">
          <h2 id="context-draft-title">项目上下文草稿</h2>
          <StatusPill tone={session ? 'info' : 'neutral'}>{session ? '待检查' : '无项目'}</StatusPill>
        </div>
        <Card className="uc-chat-page__context-target">
          <small>目标项目</small>
          <strong>{session?.projectName ?? '尚未打开项目'}</strong>
        </Card>
        <EmptyState
          title="尚未选择对话内容"
          description="只有用户明确选择的内容才能进入草稿；检查后才可保存到项目。"
          icon="摘"
        />
        <Button disabled>没有可保存的上下文</Button>
        <p className="uc-chat-page__notice">
          当前输入、附件和未保存草稿不会出现在项目页或创作页。
        </p>
      </aside>
    </section>
  );
}
