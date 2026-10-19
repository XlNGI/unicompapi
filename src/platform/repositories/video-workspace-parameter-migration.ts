import type { VideoWorkspaceDraft } from '../../domain';

/** Retire only the removed local input; preserve all model values and revisions. */
export function migrateRetiredWwwVideoCost(draft: VideoWorkspaceDraft): VideoWorkspaceDraft {
  const selection = draft.featureSelection;
  if (!selection?.parameterSchemaId?.startsWith('parameters.unicompapi-www.') ||
      !Object.prototype.hasOwnProperty.call(selection.parameterValues, 'maximum_cost_cny')) return draft;
  const parameterValues = { ...selection.parameterValues };
  delete parameterValues.maximum_cost_cny;
  return { ...draft, featureSelection: { ...selection, parameterValues } };
}
