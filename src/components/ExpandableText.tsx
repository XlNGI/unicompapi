import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button';

export function ExpandableText({ text }: { readonly text: string }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => { setExpanded(false); }, [text]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (!expanded) setOverflow(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <div className="uc-expandable-text">
    <p id={id} ref={ref} className={expanded ? 'is-expanded' : ''}>{text}</p>
    {overflow || expanded ? <Button variant="ghost" size="xs" aria-controls={id}
      aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? '收起 ⌃' : '展开全部 ⌄'}
    </Button> : null}
  </div>;
}
