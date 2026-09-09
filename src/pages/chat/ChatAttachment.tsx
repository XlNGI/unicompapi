import { useEffect, useState } from 'react';
import { LuFileText, LuImage, LuX } from 'react-icons/lu';
import { Modal } from 'rsuite';

export function ChatAttachment({ fileId, projectId, fileName, previewUrl, onRemove, disabled = false }: {
  readonly fileId: string;
  readonly projectId: string;
  readonly fileName: string;
  readonly previewUrl?: string;
  readonly onRemove?: () => void;
  readonly disabled?: boolean;
}) {
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(fileName);
  const storage = window.unicomp?.storage;
  const [url, setUrl] = useState(previewUrl);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setUrl(previewUrl);
    setFailed(false);
    if (!isImage || previewUrl) return;
    if (!storage?.createAttachmentMediaHandle) { setFailed(true); return; }
    void storage.createAttachmentMediaHandle(fileId, projectId).then(result => {
      if (!active) return;
      if (result.ok) setUrl(result.value.url);
      else setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [fileId, projectId, isImage, previewUrl, reload, storage]);

  return (
    <div className={`uc-chat-attachment${isImage ? ' uc-chat-attachment--image' : ''}`}>
      {isImage ? <button className="uc-chat-attachment__thumbnail" type="button"
        aria-label={`预览图片 ${fileName}`} onClick={() => { setReload(value => value + 1); setOpen(true); }}>
        {url && !failed ? <img src={url} alt={fileName} loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : <span><LuImage aria-hidden="true" />{failed ? '图片暂不可用' : '加载图片…'}</span>}
      </button> : <div className="uc-chat-attachment__file" title={fileName}>
        <LuFileText aria-hidden="true" /><span>{fileName}</span><small>{fileName.split('.').at(-1)?.toUpperCase()}</small>
      </div>}
      {onRemove ? <button className="uc-chat-attachment__remove" aria-label={`移除附件 ${fileName}`}
        type="button" disabled={disabled} onClick={onRemove}><LuX aria-hidden="true" /></button> : null}
      <Modal open={open} onClose={() => setOpen(false)} size="lg" className="uc-chat-image-preview">
        <Modal.Header><Modal.Title>图片预览</Modal.Title></Modal.Header>
        <Modal.Body>{url && !failed ? <img src={url} alt={fileName} onError={() => setFailed(true)} />
          : <p role="status">{failed ? '图片暂不可用，请检查本地文件是否仍然存在。' : '正在加载图片…'}</p>}</Modal.Body>
      </Modal>
    </div>
  );
}
