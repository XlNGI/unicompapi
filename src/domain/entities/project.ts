import type { ProjectId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';

export interface Project {
  readonly schemaVersion: 1;
  readonly id: ProjectId;
  readonly name: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createProject(input: Omit<Project, 'schemaVersion'>): Project {
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'project.name')
  };
}
