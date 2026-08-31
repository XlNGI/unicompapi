export interface TaskReuseTarget {
  readonly mediaKind: 'image' | 'video';
  readonly draftId: string;
  readonly mode: string;
}
