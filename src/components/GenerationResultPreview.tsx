import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';

export interface GenerationResultPreviewProps {
  readonly workId?: string;
  readonly mediaKind: 'image' | 'video';
  readonly remoteUrls?: readonly string[];
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
}

/**
 * Shows a local registered work via controlled media handle, with optional
 * remote URL fallback. Feature submit UIs use this after completion.
 */
export function GenerationResultPreview({
  workId,
  mediaKind,
  remoteUrls = [],
  emptyTitle = '尚无真实生成结果',
  emptyDescription = '结果必须经过本地文件校验后才会登记为作品。'
}: GenerationResultPreviewProps) {
  const storage = window.unicomp?.storage;
  const [localUrl, setLocalUrl] = useState<string>();
  const [localError, setLocalError] = useState<string>();

  useEffect(() => {
    if (!workId || !storage) {
      setLocalUrl(undefined);
      setLocalError(undefined);
      return;
    }
    let cancelled = false;
    setLocalUrl(undefined);
    setLocalError(undefined);
    void storage.createWorkMediaHandle(workId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setLocalUrl(result.value.url);
        setLocalError(undefined);
        return;
      }
      setLocalUrl(undefined);
      setLocalError('本地预览暂不可用');
    });
    return () => {
      cancelled = true;
    };
  }, [storage, workId]);

  if (!workId && remoteUrls.length === 0) {
    return (
      <EmptyState
        description={emptyDescription}
        icon={mediaKind === 'video' ? '视' : '画'}
        readOnly
        title={emptyTitle}
      />
    );
  }

  return (
    <div className="uc-image-quick__result-list">
      {localUrl ? (
        <article className="uc-image-quick__result-item">
          <strong>本地作品预览</strong>
          {mediaKind === 'image' ? (
            <img alt="生成结果预览" src={localUrl} />
          ) : (
            <video controls playsInline preload="metadata" src={localUrl} />
          )}
        </article>
      ) : null}
      {!localUrl && remoteUrls.map((url) => (
        <article key={url} className="uc-image-quick__result-item">
          <strong>{mediaKind === 'image' ? '图片链接' : '视频链接'}</strong>
          <a href={url} rel="noreferrer" target="_blank">{url}</a>
          {mediaKind === 'image' ? (
            <img alt="生成结果预览" src={url} />
          ) : (
            <video controls playsInline preload="metadata" src={url} />
          )}
        </article>
      ))}
      {workId ? (
        <p className="uc-image-quick__hint" role="status">
          本地作品已登记：{workId}
          {localError ? `（${localError}）` : null}
        </p>
      ) : null}
    </div>
  );
}
