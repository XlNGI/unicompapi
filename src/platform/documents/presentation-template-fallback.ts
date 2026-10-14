import type { PresentationDesignFallbackReason } from '../../domain/entities/presentation-design-contract';

/** Presentation failures only. Cancellation, budget, source identity and scope errors never enter this policy. */
const recoverableDesignCodes = new Set([
  'art_direction_timeout', 'art_direction_unavailable', 'art_direction_failed', 'art_direction_input_invalid',
  'art_direction_provider_response_incomplete', 'art_direction_output_budget_exceeded',
  'invalid_json', 'invalid_shape', 'unknown_field', 'invalid_enum', 'invalid_page_number', 'duplicate_page', 'missing_page',
  'invalid_content_reference', 'text_too_long', 'page_count_mismatch', 'invalid_design_tree', 'design_tree_missing',
  'invalid_content_organization', 'design_asset_unavailable', 'design_execution_failed',
  'font_below_minimum', 'layout_overlap', 'layout_overflow', 'content_too_dense', 'unsatisfied_constraint', 'invalid_region',
  'unsupported_content_type', 'unsupported_design_value', 'invalid_design_ir', 'invalid_layout_constraints',
  'unresolved_content_reference', 'invalid_render_plan', 'design_text_span_invalid', 'design_style_unsupported'
]);
export function presentationPlanningFallbackReason(diagnostics: readonly { readonly code: string }[]): PresentationDesignFallbackReason | undefined {
  if (!diagnostics.length || diagnostics.some(item => !recoverableDesignCodes.has(item.code))) return undefined;
  if (diagnostics.some(item => item.code === 'art_direction_timeout')) return 'art_direction_timeout';
  if (diagnostics.some(item => item.code === 'art_direction_unavailable')) return 'art_direction_unavailable';
  return diagnostics.some(item => item.code === 'design_execution_failed') ? 'design_layout_failed' : 'art_direction_invalid';
}
export function canFallbackFromPresentationQa(diagnostics: readonly { readonly code: string; readonly severity: string }[]): boolean {
  const errors = diagnostics.filter(item => item.severity === 'error');
  return errors.length > 0 && errors.every(item => ['text_overflow', 'overlap', 'element_overflow', 'font_missing', 'empty_page'].includes(item.code));
}
