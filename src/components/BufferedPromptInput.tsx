import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { Input } from 'rsuite';
import { registerPendingEditor } from '../ui/autosave-flush-registry';

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  readonly value: string;
  readonly onChange: (value: string) => void;
};

export function BufferedPromptInput({ value, onChange, ...props }: Props) {
  const [text, setText] = useState(value);
  const pending = useRef<string>();
  const callback = useRef(onChange);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  callback.current = onChange;

  function commit(synchronous = true) {
    clearTimeout(timer.current);
    const next = pending.current;
    if (next === undefined) return;
    pending.current = undefined;
    if (synchronous) flushSync(() => callback.current(next));
    else callback.current(next);
  }

  function schedule() {
    clearTimeout(timer.current);
    if (!composing.current) timer.current = setTimeout(() => commit(), 180);
  }

  useEffect(() => {
    if (pending.current === undefined) setText(value);
  }, [value]);

  useLayoutEffect(() => {
    const unregister = registerPendingEditor(() => commit());
    return () => {
      unregister();
      commit(false);
    };
  }, []);

  return <Input
    {...props}
    value={text}
    onChange={(next) => {
      setText(next);
      pending.current = next;
      schedule();
    }}
    onCompositionStart={() => {
      composing.current = true;
      clearTimeout(timer.current);
    }}
    onCompositionEnd={() => {
      composing.current = false;
      schedule();
    }}
    onBlur={() => commit()}
  />;
}
