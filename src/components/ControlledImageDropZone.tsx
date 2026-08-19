import { useState, type DragEvent, type ReactNode } from 'react';
import { LuImagePlus } from 'react-icons/lu';

interface ControlledImageDropZoneProps {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly hasImage: boolean;
  readonly onDropFile: (file: File, dropToken?: string) => void;
  readonly onReject: (message: string) => void;
}

export function ControlledImageDropZone({
  children,
  disabled = false,
  hasImage,
  onDropFile,
  onReject
}: ControlledImageDropZoneProps) {
  const [dragging, setDragging] = useState(false);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      onReject('一次只能添加一张图片。');
      return;
    }
    const [file] = files;
    if (file.type && !file.type.startsWith('image/')) {
      onReject('请拖入图片文件。');
      return;
    }
    const dropToken = event.currentTarget.dataset.unicompDropToken;
    delete event.currentTarget.dataset.unicompDropToken;
    onDropFile(file, dropToken);
  }

  return (
    <div
      aria-label={hasImage ? '拖入图片以替换当前图片' : '拖入图片'}
      className={`uc-controlled-image-drop-zone${dragging ? ' is-dragging' : ''}`}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      <span aria-hidden="true" className="uc-controlled-image-drop-zone__hint">
        <LuImagePlus />
        拖入图片
      </span>
      {dragging ? (
        <div aria-hidden="true" className="uc-controlled-image-drop-zone__overlay">
          松开添加图片
        </div>
      ) : null}
    </div>
  );
}

function hasFiles(event: DragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}
