import fixtures from './conversation-semantic-responses.json';
import type { ConversationIntentClassifierPort } from '../../src/application/conversation-intent-orchestrator';
import { createConversationWorkflow, toConversationWorkflowId, type Conversation, type ConversationIntentPlan, type MessageId } from '../../src/domain';
import { ConversationDocumentToolSessionService } from '../../src/platform/documents/conversation-document-tool-session';

/** Fixed synthetic model responses for workflow/lease tests; no product intent inference. */
export const fixtureSemanticClassifier: ConversationIntentClassifierPort = {
  async classify({ rawText, context }) {
    const plans = fixtures.plans as unknown as Record<string, Record<string, ConversationIntentPlan>>;
    const variants = plans[rawText];
    if (!variants) return chatFixturePlan;
    const mode = context.currentTask?.plan.missing.includes('document_topic') ? 'topic'
      : context.currentTask?.plan.missing.includes('document_kind') ? 'kind'
        : context.latestDocumentKind ?? context.documents?.at(-1)?.kind ?? 'plain';
    const plan = structuredClone(variants[mode] ?? variants.plain);
    if (plan.kind === 'document' && plan.action !== 'create' && context.documents?.length) {
      const missing = plan.missing.filter(item => item !== 'document_target');
      return { ...plan, missing, confidence: missing.length ? 'low' : 'high',
        targetHint: { ...(plan.targetHint ?? { unit: 'document' }), name: context.documents.at(-1)!.fileName } };
    }
    return plan;
  }
};

export const chatFixturePlan = { schemaVersion: 1, kind: 'chat', parameters: {}, sourcePolicy: 'none', missing: [],
  ambiguities: [], confidence: 'high', needsConfirmation: false } as const;
export const pptFixturePlan = { schemaVersion: 1, kind: 'document', action: 'create', documentKind: 'ppt',
  parameters: { topic: '合成测试主题' }, sourcePolicy: 'none', missing: [], ambiguities: [], confidence: 'high', needsConfirmation: false } as const;

export async function fixtureToolInput(input: { readonly conversation: Conversation; readonly currentUserMessageId: MessageId; readonly query: string }) {
  const documents = input.conversation.messages.flatMap(message => message.documentResult ? [{ messageId: message.id,
    kind: message.documentResult.kind, fileName: message.documentResult.fileName }] : []);
  const selected = documents.find(document => input.query.includes(document.fileName));
  const rawText = selected ? input.query.split(selected.fileName).join('{{file}}') : input.query;
  const plan = await fixtureSemanticClassifier.classify({ rawText, context: {
    documents, latestDocumentKind: documents.at(-1)?.kind
  }, signal: new AbortController().signal }) as ConversationIntentPlan;
  return { ...input, plan: selected && plan.kind === 'document' && plan.action !== 'create'
    ? { ...plan, targetHint: { ...(plan.targetHint ?? { unit: 'document' as const }), name: selected.fileName } } : plan };
}

/** Inject a synthetic LLM plan at the exact input boundary used by the real controller. */
export function fixtureToolService(options: ConstructorParameters<typeof ConversationDocumentToolSessionService>[0]) {
  const service = new ConversationDocumentToolSessionService(options);
  const prepare = service.prepare.bind(service);
  service.prepare = async input => {
    if (input.workflow) return prepare(input);
    const message = input.conversation.messages.find(item => item.id === input.draft.userMessageId)!;
    const { plan } = await fixtureToolInput({ conversation: input.conversation, currentUserMessageId: message.id, query: message.displayContent ?? message.content });
    const workflow = createConversationWorkflow({ id: toConversationWorkflowId(`fixture-${message.id}`), projectId: options.projectId,
      conversationId: input.conversation.id, sourceMessageId: message.id, plan, createdAt: message.updatedAt });
    return prepare({ ...input, workflow });
  };
  return service;
}
