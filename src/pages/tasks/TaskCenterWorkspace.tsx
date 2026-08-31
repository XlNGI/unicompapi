import type { ReactNode } from 'react';

interface TaskCenterWorkspaceProps {
  readonly details: ReactNode;
  readonly detailsLabelledBy: string;
  readonly list: ReactNode;
  readonly listLabelledBy: string;
}

export function TaskCenterWorkspace({
  details,
  detailsLabelledBy,
  list,
  listLabelledBy
}: TaskCenterWorkspaceProps) {
  return (
    <div className="uc-task-center__workspace">
      <section
        aria-labelledby={listLabelledBy}
        className="uc-task-center__list uc-scrollbar"
      >
        {list}
      </section>
      <section
        aria-labelledby={detailsLabelledBy}
        className="uc-task-center__details uc-scrollbar"
      >
        {details}
      </section>
    </div>
  );
}
