// Safe summaries only: never retain tool arguments, observations or paths.
function toolReceipts(messages = []) {
  const names = new Map(messages.flatMap(message => (message.tool_calls ?? []).map(call => [call.id, call.function?.name])));
  return messages.filter(message => message.role === 'tool').flatMap(message => {
    const toolId = names.get(message.tool_call_id);
    if (!['generate_pptx', 'read_document_structure'].includes(toolId)) return [];
    let result;
    try { result = JSON.parse(message.content); } catch { return [{ toolId, status: 'invalid_result', diagnosticCodes: [] }]; }
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [{ toolId, status: 'invalid_result', diagnosticCodes: [] }];
    return [{ toolId, status: ['success', 'failed', 'unknown'].includes(result.status) ? result.status : 'invalid_result',
      diagnosticCodes: safeCodes(Array.isArray(result.diagnostics) ? result.diagnostics.map(item => item?.code) : []) }];
  });
}

function safeCodes(codes) {
  return codes.filter(code => typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(code));
}

function generationFailure(evidence) {
  if (evidence.workCount > 1) return 'duplicate_generated_work';
  if (evidence.workCount === 1) return undefined;
  const trace = evidence.trace ?? [];
  const receipts = evidence.receipts ?? [];
  // Local interception can coexist with a real rendering/registration failure.
  // Prefer the durable pipeline evidence while retaining both in the report.
  if (trace.some(event => event.code === 'document_register' && event.status === 'failed')) return 'document_registration_failed';
  if (trace.some(event => event.code === 'document_render' && event.status === 'failed')) return 'document_render_failed';
  if (trace.some(event => ['document_check', 'document_structure_check', 'document_hash_check', 'plan_validation'].includes(event.code) && event.status === 'failed')) return 'document_validation_failed';
  if (receipts.some(receipt => receipt.toolId === 'generate_pptx' && receipt.status === 'unknown')) return 'generation_result_unknown';
  if (receipts.some(receipt => receipt.toolId === 'generate_pptx' && ['failed', 'invalid_result'].includes(receipt.status))) return 'generation_tool_failed';
  if (evidence.localRejections?.length) return 'acceptance_local_interception';
  if (evidence.artDirectionRequests > 0 || receipts.some(receipt => receipt.toolId === 'generate_pptx') ||
      trace.some(event => event.code === 'tool_call' && event.tool === 'write_document')) return 'generation_started_without_registered_work';
  if (evidence.terminalState === 'completed') return 'provider_no_generation_tool_call';
  return 'generation_not_verified';
}

function verifyGeneratedReadTranscript(messages, proof) {
  const calls = messages.flatMap(message => message.tool_calls ?? []);
  const results = messages.filter(message => message.role === 'tool');
  if (calls.length !== 2 || results.length !== 2 || calls[0].function?.name !== 'generate_pptx' ||
      calls[1].function?.name !== 'read_document_structure' || !calls.every(call => typeof call.id === 'string') || calls[0].id === calls[1].id) throw new Error('final_answer_tool_sequence_invalid');
  const parsed = results.map((message, index) => {
    if (message.tool_call_id !== calls[index].id || typeof message.content !== 'string') throw new Error('tool_call_id_mismatch');
    const args = JSON.parse(calls[index].function.arguments);
    proof.validateCall?.(calls[index].function.name, args);
    if (index === 1 && args.scope !== 'document') throw new Error('unexpected_tool_scope');
    const result = JSON.parse(message.content);
    if (result.status !== 'success') throw new Error('generation_or_read_tool_failed');
    return result;
  });
  if (parsed[0].observation?.generated !== true || !parsed[0].artifactRefs?.some(ref => ref.kind === 'work')) throw new Error('generation_artifact_missing');
  const observation = parsed[1].observation;
  if (!proof.pages?.length || observation?.scope !== 'document' || observation.structureUnit !== 'physical_page' ||
      observation.pageCount !== proof.pages.length || observation.totalPages !== proof.pages.length ||
      observation.revision !== proof.revision || observation.sections?.length !== proof.pages.length) throw new Error('physical_observation_metadata_mismatch');
  for (const [index, page] of proof.pages.entries()) {
    const section = observation.sections[index];
    const text = section.blocks?.map(block => block.text ?? '').join('');
    if (section.heading !== `第 ${page.pageNumber} 页` || text?.trim() !== page.contentText.trim()) throw new Error('physical_page_text_mismatch');
  }
  if (!proof.markers.every(marker => results[1].content.includes(marker))) throw new Error('generated_marker_missing');
  return { toolCalls: calls.map((call, index) => ({ callRef: `call-${index + 1}`, toolId: call.function.name,
    ...(index === 1 ? { scope: 'document' } : {}) })), toolCallIdMatched: true,
    observationContainsExpectedFacts: true, observationMatchesPhysicalFile: true };
}

module.exports = { toolReceipts, safeCodes, generationFailure, verifyGeneratedReadTranscript };
