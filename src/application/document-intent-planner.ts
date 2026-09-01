import {
  assessDocumentIntentPlan,
  type DocumentIntentAssessment,
  type DocumentIntentPlan
} from '../domain';
import {
  analyzeOfficeRequest,
  type OfficeRequestContext
} from './office-request-intent';

/**
 * Builds the high-confidence local path used before an LLM is considered.
 * The result is an application plan, not an execution command: opaque message
 * and work identifiers remain in the application context and are resolved later.
 */
export function buildLocalDocumentIntentPlan(
  rawText: string,
  context: OfficeRequestContext = {}
): DocumentIntentPlan {
  const intent = analyzeOfficeRequest(rawText, context);
  if (intent.kind === 'chat') {
    return {
      task: 'chat',
      sourcePolicy: 'internal_only',
      constraints: [],
      missing: [],
      ambiguities: [],
      confidence: 'high'
    };
  }

  const documentKind = intent.documentKind ?? 'auto';
  const isComplete = intent.missing.length === 0;
  const target =
    intent.targetMessageId === undefined
      ? undefined
      : context.documents
          ?.find((document) => document.messageId === intent.targetMessageId)
          ?.fileName;

  return {
    task: intent.action,
    documentKind,
    topic: rawText.trim().slice(0, 2_000),
    sourcePolicy: 'internal_only',
    constraints: [],
    missing: intent.missing,
    ambiguities: [],
    confidence: isComplete ? 'high' : 'low',
    ...(target !== undefined ? { target: { documentName: target } } : {})
  };
}

export function assessLocalDocumentIntent(
  rawText: string,
  context: OfficeRequestContext = {},
  options: { readonly externalSearchAuthorized?: boolean } = {}
): DocumentIntentAssessment {
  return assessDocumentIntentPlan(
    buildLocalDocumentIntentPlan(rawText, context),
    options
  );
}
