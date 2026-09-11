import { useEffect, useRef, useState } from 'react';
import { LuMaximize2, LuMinimize2 } from 'react-icons/lu';

export function VideoPreview({ src }: { readonly src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  return (
    <div className={`uc-video-preview${expanded ? ' uc-video-preview--expanded' : ''}`}>
      <video
        controls
        controlsList="nofullscreen"
        playsInline
        preload="metadata"
        ref={videoRef}
        src={src}
      />
      <button
        aria-label={expanded ? '退出视频全屏预览' : '全屏预览视频'}
        aria-pressed={expanded}
        className="uc-video-preview__fullscreen"
        onClick={() => {
          setExpanded((value) => !value);
        }}
        title={expanded ? '退出全屏' : '全屏预览'}
        type="button"
      >
        {expanded ? <LuMinimize2 aria-hidden="true" /> : <LuMaximize2 aria-hidden="true" />}
      </button>
    </div>
  );
}
