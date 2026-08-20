import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { StatusTone } from '../../components/StatusPill';

export interface ProjectStatusSnapshot {
  readonly label: ReactNode;
  readonly tone: StatusTone;
  readonly content: ReactNode;
  readonly role: 'status' | 'alert';
  readonly priority?: number;
}

interface ProjectStatusContextValue {
  readonly status: ProjectStatusSnapshot;
  readonly register: (id: string, status: ProjectStatusSnapshot) => void;
  readonly unregister: (id: string) => void;
}

const defaultStatus: ProjectStatusSnapshot = {
  label: '项目状态',
  tone: 'neutral',
  content: '当前项目状态会在这里显示。',
  role: 'status'
};

const ProjectStatusContext = createContext<ProjectStatusContextValue | undefined>(undefined);

export function ProjectStatusProvider({ children }: { readonly children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, ProjectStatusSnapshot>>(
    () => new Map()
  );
  const register = useCallback((id: string, status: ProjectStatusSnapshot) => {
    setEntries((current) => {
      const previous = current.get(id);
      if (previous && sameStatus(previous, status)) return current;
      const next = new Map(current);
      next.set(id, status);
      return next;
    });
  }, []);
  const unregister = useCallback((id: string) => {
    setEntries((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  const status = Array.from(entries.values())
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .at(0) ?? defaultStatus;
  const value = useMemo(
    () => ({ status, register, unregister }),
    [status, register, unregister]
  );
  return <ProjectStatusContext.Provider value={value}>{children}</ProjectStatusContext.Provider>;
}

export function useProjectStatus(): ProjectStatusContextValue {
  const context = useContext(ProjectStatusContext);
  if (!context) throw new Error('useProjectStatus must be used inside ProjectStatusProvider');
  return context;
}

function sameStatus(left: ProjectStatusSnapshot, right: ProjectStatusSnapshot): boolean {
  return left.tone === right.tone &&
    left.role === right.role &&
    (left.priority ?? 0) === (right.priority ?? 0) &&
    String(left.label ?? '') === String(right.label ?? '') &&
    nodeText(left.content) === nodeText(right.content);
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { readonly props?: { readonly children?: ReactNode } }).props?.children);
  }
  return '';
}
