/* Offline audit evidence. This reproduces current defects; it is not a product acceptance test. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const source = file => require(path.join(root, file));
const domain = source('src/domain/index.ts');
const { ConversationDocumentToolSessionService } = source('src/platform/documents/conversation-document-tool-session.ts');
const { createCanonicalToolRegistry } = source('src/domain/entities/canonical-tool-contract.ts');
const { AgentContextAssembler } = source('src/application/agent-context-assembler.ts');
const { collectArtDirectionRequestText } = source('src/application/document-generation-service.ts');
const { applyPresentationVisualRevision, parsePresentationVisualRevisionRequest } = source('src/application/presentation-design-revision.ts');
const { compilePresentationRenderPlan } = source('src/platform/documents/presentation-render-plan-compiler.ts');
const { resolvePresentationTemplate } = source('src/platform/documents/presentation-template.ts');
const { planExecutablePresentationDesign } = source('src/platform/documents/presentation-design-planning.ts');
const { autonomousOutline: outline, authoredFixtureDesign, splitTree } = source('tests/fixtures/presentation-autonomous-design.ts');
const at = domain.toIsoTimestamp('2026-10-17T12:00:00.000Z');
const projectId = domain.toProjectId('audit-synthetic-project');
const fresh = id => domain.createProjectConversation({ id: domain.toConversationId(id), projectId, title: 'Synthetic audit', createdAt: at });
const user = (conversation, id, content) => domain.addUserMessage(conversation, { id: domain.toMessageId(id), content, createdAt: at });

async function main() {
  const intentCases = [];
  const queries = [
    '先讨论PPT方案，不要直接生成', '不要马上制作PPT，先讨论', '我不想立即生成PPT，先分析内容',
    '先帮我设计PPT结构', '先讨论 Word 报告，不生成文件', '现在生成一份Excel预算表', '立即生成PPT'
  ];
  for (const [index, query] of queries.entries()) {
    const conversation = user(fresh(`audit-intent-${index}`), `audit-user-${index}`, query);
    const message = conversation.messages.at(-1);
    // No user repositories or files: prepare only receives this in-memory conversation.
    const conversations = { projectId, get: async () => conversation };
    const service = new ConversationDocumentToolSessionService({ rootDirectory: root, projectId, conversations, getCurrentProjectId: () => projectId });
    try {
      const draft = domain.createConversationResponseDraft({ id: domain.toConversationResponseDraftId(`audit-draft-${index}`), projectId,
        conversationId: conversation.id, conversationRevision: conversation.revision, userMessageId: message.id,
        userMessageRevision: message.revision, agentNative: true, productFeature: 'text_chat', createdAt: at });
      const selection = await service.prepare({ conversation, draft });
      intentCases.push({ query, kind: selection?.kind, generationRequired: selection?.generationRequired,
        generationAuthorization: selection?.generation?.authorizationStatus });
    } finally { await service.dispose(); }
  }
  assert(intentCases.slice(0, 3).every(item => item.generationRequired === true));
  assert.equal(intentCases.at(-1).generationRequired, true);

  const registry = createCanonicalToolRegistry();
  const providerTools = [...registry.values()].filter(item => item.exposure === 'provider').map(item => ({
    toolId: item.toolId, fields: Object.keys(item.input.fields)
  }));
  assert(providerTools.some(item => item.toolId === 'generate_pptx'));
  assert(!providerTools.some(item => /generate_(?:docx|xlsx|word|excel)|redesign|restyle/u.test(item.toolId)));

  const design = authoredFixtureDesign(outline, splitTree());
  const tokens = resolvePresentationTemplate('business_minimal').tokens;
  const baseline = compilePresentationRenderPlan(outline, design, tokens);
  assert.equal(baseline.renderPlanStatus, 'valid');
  const revisionCases = ['第二页更简洁一点', '把第二页改成科技感流程图'].map(query => {
    try {
      applyPresentationVisualRevision({ outline, designIR: design, revision: parsePresentationVisualRevisionRequest(query, 3) });
      return { query, status: 'unexpected_success' };
    } catch (error) {
      return { query, status: 'rejected', errorCode: error.code ?? error.message,
        diagnostics: error.diagnostics?.map(item => ({ code: item.code, path: item.path })) };
    }
  });
  assert(revisionCases.every(item => item.errorCode === 'presentation_design_ir_invalid'));
  const accented = { ...design, globalDesign: { ...design.globalDesign, colorDirection: 'accent-led' } };
  const colorQuery = '第二页颜色更克制一些';
  const revision = parsePresentationVisualRevisionRequest(colorQuery, 3);
  const recolored = applyPresentationVisualRevision({ outline, designIR: accented, revision });
  const beforeColor = compilePresentationRenderPlan(outline, accented, tokens);
  const afterColor = compilePresentationRenderPlan(outline, recolored, tokens);
  const colorCase = { query: colorQuery, targetPages: revision.targetPageNumbers,
    globalColorDirection: [accented.globalDesign.colorDirection, recolored.globalDesign.colorDirection],
    beforeStatus: beforeColor.renderPlanStatus, afterStatus: afterColor.renderPlanStatus,
    renderedPagesUnchanged: JSON.stringify(beforeColor.plan.pages) === JSON.stringify(afterColor.plan.pages) };
  assert.equal(colorCase.renderedPagesUnchanged, true);

  let history = user(fresh('audit-context'), 'initial-constraint', 'STYLE_SENTINEL_20261017：先讨论，不生成文件。');
  for (let index = 0; index < 41; index += 1) history = user(history, `context-${index}`, `补充资料 ${index}`);
  const envelope = new AgentContextAssembler().assemble({ conversation: history, currentUserMessageId: history.messages.at(-1).id });
  const contextCase = { completedUserMessages: history.messages.length, truncated: envelope.budget.truncated,
    initialConstraintPresent: envelope.messages.some(message => message.content.includes('STYLE_SENTINEL_20261017')) };
  assert.equal(contextCase.initialConstraintPresent, false);
  let brief = user(fresh('audit-brief'), 'brief-original', '风格要求 STYLE_SENTINEL_20261017。');
  for (let index = 0; index < 8; index += 1) brief = user(brief, `brief-${index}`, `补充内容 ${index}`);
  brief = domain.addCompletedAssistantMessage(brief, { id: domain.toMessageId('brief-current-assistant'), content: '准备制作', createdAt: at });
  const briefText = collectArtDirectionRequestText(brief, brief.messages.at(-1).id);
  const briefCase = { helper: 'collectArtDirectionRequestText', selectedUserMessages: briefText.split('\n').length,
    initialConstraintPresent: briefText.includes('STYLE_SENTINEL_20261017'),
    nativePathEquivalentBound: 'conversation-document-tool-session.ts:1104 uses brief.length < 8' };
  assert.equal(briefCase.initialConstraintPresent, false);

  let planningRequests = 0;
  const planning = await planExecutablePresentationDesign({ outline, userRequirement: 'Synthetic offline audit',
    request: async () => { planningRequests += 1; return planningRequests === 1 ? '{' : design; },
    requireDesignTree: true, signal: new AbortController().signal, tokens, assets: [] });
  const planningCase = { planningRequests, validSecondResponseAvailable: true, designReturned: Boolean(planning.designIR), diagnostics: planning.diagnostics };
  assert.equal(planningRequests, 1);
  assert.equal(planningCase.designReturned, false);

  const files = [
    'src/platform/documents/conversation-document-tool-session.ts', 'src/domain/entities/canonical-tool-contract.ts',
    'src/application/conversation-context-builder.ts', 'src/application/agent-context-assembler.ts',
    'src/application/document-generation-service.ts', 'src/application/presentation-design-revision.ts',
    'src/domain/entities/presentation-design-contract.ts', 'src/platform/documents/presentation-design-planning.ts',
    'src/platform/documents/presentation-render-plan-compiler.ts', 'src/platform/documents/presentation-visual-audit.ts',
    'src/platform/documents/document-generation-runner.ts', 'src/pages/chat/ChatPage.tsx',
    'scripts/verify-agent-provider-mock-electron.cjs', 'tests/fixtures/presentation-autonomous-design.ts'
  ];
  const result = {
    schemaVersion: 1, date: '2026-10-17', recordedAt: new Date().toISOString(),
    status: 'audit_complete_defects_reproduced_not_fixed',
    baseline: { branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() },
    scope: { syntheticInputsOnly: true, businessSourceChanged: false, userDataChanged: false, credentialFilesRead: false,
      externalProviderRequests: 0, generatedPptFiles: 0, applicationRestarts: 0, imageFeatureExcluded: true,
      proposalAndDesignStarted: false },
    evidenceMeaning: 'Successful reproduction means an observed audit finding was confirmed. It does not mean the product defect passed acceptance.',
    intentCases, providerTools, revisionCases, colorCase, contextCase, briefCase, planningCase,
    deterministicVisualAudit: { baselineRenderPlanStatus: baseline.renderPlanStatus, visualAudit: baseline.visualAudit },
    sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
  };
  const output = path.join(__dirname, 'reproduction.json');
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, intentCases: intentCases.length,
    visualRevisionRejections: revisionCases.length, colorRevisionChangedRenderedPages: !colorCase.renderedPagesUnchanged,
    historyConstraintRetained: contextCase.initialConstraintPresent, briefConstraintRetained: briefCase.initialConstraintPresent,
    invalidInitialPlanRequests: planningRequests, providerToolIds: providerTools.map(item => item.toolId) }, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
