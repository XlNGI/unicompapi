import { useEffect, useState } from 'react';
import { LuSparkles } from 'react-icons/lu';
import { EmptyState } from './EmptyState';

export interface GenerationResultPreviewProps {
  readonly workId?: string;
  readonly mediaKind: 'image' | 'video';
  readonly remoteUrls?: readonly string[];
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly loading?: boolean;
  readonly loadingTitle?: string;
  readonly loadingDescription?: string;
  readonly animateResult?: boolean;
  readonly compact?: boolean;
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
  emptyDescription = '结果必须经过本地文件校验后才会登记为作品。',
  loading = false,
  loadingTitle = '正在生成',
  loadingDescription = '完成后将校验结果并登记到本地。',
  animateResult = false,
  compact = false
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

  if (loading) {
    return (
      <div className="uc-image-quick__result-list">
        <article className="uc-image-quick__result-item uc-generation-result-preview">
          {compact ? null : <strong>本地作品预览</strong>}
          <div
            aria-live="polite"
            className="uc-generation-result-preview__loading"
            role="status"
          >
            <div className="uc-generation-result-preview__loading-content">
              <span
                aria-hidden="true"
                className="uc-generation-result-preview__indicator"
              >
                <span className="uc-generation-result-preview__ring" />
                <LuSparkles />
              </span>
              <div>
                <strong>{loadingTitle}</strong>
                <span>{loadingDescription}</span>
              </div>
            </div>
          </div>
        </article>
      </div>
    );
  }

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
        <article
          className={[
            'uc-image-quick__result-item',
            'uc-generation-result-preview',
            animateResult ? 'uc-generation-result-preview--animated' : ''
          ].filter(Boolean).join(' ')}
        >
          {compact ? null : <strong>本地作品预览</strong>}
          {mediaKind === 'image' ? (
            <img alt="生成结果预览" src={localUrl} />
          ) : (
            <video controls playsInline preload="metadata" src={localUrl} />
          )}
        </article>
      ) : null}
      {!localUrl && remoteUrls.map((url) => (
        <article
          className={[
            'uc-image-quick__result-item',
            'uc-generation-result-preview',
            animateResult ? 'uc-generation-result-preview--animated' : ''
          ].filter(Boolean).join(' ')}
          key={url}
        >
          {compact ? null : (
            <>
              <strong>{mediaKind === 'image' ? '图片链接' : '视频链接'}</strong>
              <a href={url} rel="noreferrer" target="_blank">{url}</a>
            </>
          )}
          {mediaKind === 'image' ? (
            <img alt="生成结果预览" src={url} />
          ) : (
            <video controls playsInline preload="metadata" src={url} />
          )}
        </article>
      ))}
      {workId && !compact ? (
        <p className="uc-image-quick__hint" role="status">
          本地作品已登记：{workId}
          {localError ? `（${localError}）` : null}
        </p>
      ) : null}
    </div>
  );
}
