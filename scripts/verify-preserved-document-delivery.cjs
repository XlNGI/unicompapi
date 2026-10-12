const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');

// Reconcile only persisted local facts. This script never instantiates a
// Provider transport, decrypts credentials or resumes any execution.
const { values } = parseArgs({ options: { 'report-directory': { type: 'string' }, 'expected-model': { type: 'string' } } });
const requireFact = (value, code) => { if (!value) throw new Error(code); };
let stage = 'scope';
async function run() {
  requireFact(values['report-directory'] && values['expected-model'], 'reconciliation_arguments_required');
  const output = path.resolve(values['report-directory']);
  const originalBytes = await fs.readFile(path.join(output, 'real-provider.json'));
  const original = JSON.parse(originalBytes.toString('utf8'));
  const location = JSON.parse(await fs.readFile(path.join(output, 'isolation-location.json'), 'utf8'));
  const project = path.resolve(location.projectDirectory), root = path.dirname(project);
  requireFact(path.dirname(root).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() &&
    path.basename(root).startsWith('unicomp-production-read-') && path.basename(project) === 'project', 'isolated_project_scope_invalid');
  requireFact(original.model === values['expected-model'] && original.actualWireModel === values['expected-model'] &&
    original.maximumNetworkRequests === 5 && original.networkRequests >= 4 && original.networkRequests <= 5 && original.automaticRetries === 0 &&
    original.protectedUserConfigurationUnchanged === true && original.isolatedProjectRetained === true, 'original_acceptance_scope_invalid');
  const entry = original.cases?.[0];
  requireFact(original.cases.length === 1 && entry.case === 'generate_and_read' && entry.terminalState === 'completed' &&
    entry.pathOrRuntimeContextLeak === false && entry.schemasCanonical === true && entry.finalPhysicalPageCountMatched === true && entry.finalAnswerRequests === 1,
  'original_wire_evidence_incomplete');
  requireFact(entry.wireToolReceipts?.length === 2 && entry.wireToolReceipts[0].toolId === 'generate_pptx' &&
    entry.wireToolReceipts[1].toolId === 'read_document_structure' && entry.wireToolReceipts.every(item => item.status === 'success'), 'original_wire_receipts_invalid');
  const platform = require('../dist-electron/src/platform');
  const domain = require('../dist-electron/src/domain');
  stage = 'response';
  const { ThreadFileRepository } = require('../dist-electron/src/platform/repositories/thread-file-repository');
  const { RegisteredPresentationReader } = require('../dist-electron/src/platform/documents/registered-presentation-reader');
  const raw = JSON.parse(await fs.readFile(path.join(project, 'entities/conversation-response-executions.json'), 'utf8'));
  requireFact(raw.executions?.length === 1, 'response_identity_ambiguous');
  const execution = raw.executions[0], projectId = execution.projectId;
  requireFact(execution.state === 'completed', 'response_not_completed');
  const storage = new platform.NodeProjectStorage(project);
  stage = 'physical_file';
  const works = await new platform.JsonWorkRepository(storage, projectId).list(projectId);
  requireFact(works.length === 1, 'expected_one_registered_work');
  const document = await new RegisteredPresentationReader({ rootDirectory: project, projectId }).read(works[0].id);
  const hash = createHash('sha256').update(document.buffer).digest('hex');
  requireFact(hash === document.file.checksumSha256 && hash === entry.physicalFile.sha256 && document.buffer.length === entry.physicalFile.sizeBytes,
    'physical_file_changed');
  const revision = Number.parseInt(createHash('sha256').update(JSON.stringify([
    document.work.id, document.file.id, document.work.sourceExecutionId, hash, document.file.updatedAt
  ])).digest('hex').slice(0, 12), 16);
  const tasks = (await new platform.JsonDocumentTaskRuntimeRepository(storage, projectId).list()).filter(task => task.executionId === execution.id);
  stage = 'observation';
  requireFact(tasks.length === 1 && tasks[0].status === 'completed' && tasks[0].conversationId === execution.snapshot.conversationId &&
    tasks[0].sourceMessageId === execution.snapshot.userMessageId, 'document_runtime_scope_invalid');
  requireFact(tasks[0].toolCalls.length === 2 && tasks[0].toolCalls.every(call => call.status === 'completed'), 'document_tools_incomplete');
  const read = tasks[0].observations.find(observation => observation.toolId === 'read_document_structure');
  requireFact(read?.ok === true && read.data?.readWorkId === document.work.id && read.data.revision === revision &&
    read.data.pageCount === document.pages.length && read.data.totalPages === document.pages.length && read.data.structureUnit === 'physical_page',
  'saved_read_observation_does_not_match_file');
  const markers = ['BLUE-ORBIT-471', 'GREEN-VALLEY-829'];
  stage = 'final_answer';
  const events = await new platform.JsonConversationResponseExecutionRepository(storage, projectId).listEvents(execution.id);
  const response = domain.projectConversationResponseExecution({ execution, events });
  requireFact(markers.every(marker => response.content.includes(marker) && document.pages.some(page => page.text.includes(marker))) &&
    Number(/文件页数\s*[：:]\s*(\d+)/u.exec(response.content)?.[1]) === document.pages.length, 'final_answer_physical_facts_mismatch');
  const items = await new ThreadFileRepository(project).readItems(execution.snapshot.conversationId);
  stage = 'thread';
  const tools = items.filter(item => ['tool_call_projection', 'tool_result_projection'].includes(item.type));
  const artifacts = items.filter(item => item.type === 'document_artifact_projection' && item.projectionSource?.workId === document.work.id);
  const assistant = items.find(item => item.type === 'assistant_message' && item.messageSource?.messageId === execution.snapshot.assistantMessageId);
  requireFact(tools.length === 4 && tools.every(item => item.status === 'completed') && artifacts.length === 1 && artifacts[0].status === 'completed' &&
    assistant?.status === 'completed' && assistant.legacyMessageSnapshot?.documentResult?.workId === document.work.id, 'committed_thread_delivery_incomplete');
  const result = { schemaVersion: 1, status: 'verified_delivery', model: original.model, networkRequests: original.networkRequests,
    reconciliationNetworkRequests: 0, automaticRetries: 0, cost: 'unknown', originalLiveGateStatus: original.status,
    originalSafeCode: original.safeCode, originalReportSha256: createHash('sha256').update(originalBytes).digest('hex'),
    file: { physicalPages: document.pages.length, sizeBytes: document.buffer.length, sha256: hash, hashVerified: true },
    workCount: works.length, responseState: execution.state, documentState: tasks[0].status,
    savedObservationMatchesPhysicalIdentity: true, finalAnswerMatchesPhysicalFacts: true,
    thread: { toolCalls: 2, toolResults: 2, artifacts: 1, assistantReceipt: true },
    limitations: ['Original final-request inspector returned before recording per-page wire text equality; this verifier checks saved Host observation identity and final answer without claiming that missing wire record was captured.'],
    finishedAt: new Date().toISOString() };
  await fs.writeFile(path.join(output, 'reconciled-delivery.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
}
run().catch(error => { process.stderr.write((/^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : `local_reconciliation_failed:${stage}:${error.name}`) + '\n'); process.exitCode = 1; });
