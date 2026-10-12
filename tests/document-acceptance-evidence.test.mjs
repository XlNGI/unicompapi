import assert from 'node:assert/strict';
import test from 'node:test';
import evidence from '../scripts/lib/document-acceptance-evidence.cjs';

test('validates both completed tool observations in the final request after tools are removed', () => {
  const pages = [{ pageNumber: 1, contentText: 'MARKER-A' }, { pageNumber: 2, contentText: 'MARKER-B' }];
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'generation', function: { name: 'generate_pptx', arguments: '{"title":"Synthetic"}' } }] },
    { role: 'tool', tool_call_id: 'generation', content: JSON.stringify({ status: 'success', observation: { generated: true }, artifactRefs: [{ kind: 'work' }] }) },
    { role: 'assistant', tool_calls: [{ id: 'reading', function: { name: 'read_document_structure', arguments: '{"scope":"document"}' } }] },
    { role: 'tool', tool_call_id: 'reading', content: JSON.stringify({ status: 'success', observation: { scope: 'document', structureUnit: 'physical_page',
      pageCount: 2, totalPages: 2, revision: 123, sections: pages.map(page => ({ heading: `第 ${page.pageNumber} 页`, blocks: [{ text: page.contentText }] })) } }) }
  ];
  const proof = { pages, revision: 123, markers: ['MARKER-A', 'MARKER-B'] };
  const checked = evidence.verifyGeneratedReadTranscript(messages, proof);
  assert.equal(checked.observationMatchesPhysicalFile, true);
  assert.deepEqual(checked.toolCalls.map(call => call.toolId), ['generate_pptx', 'read_document_structure']);
  const wrongId = structuredClone(messages); wrongId[3].tool_call_id = 'generation';
  assert.throws(() => evidence.verifyGeneratedReadTranscript(wrongId, proof), /tool_call_id_mismatch/);
  const changedPage = structuredClone(messages);
  const result = JSON.parse(changedPage[3].content); result.observation.sections[1].blocks[0].text = 'changed page';
  changedPage[3].content = JSON.stringify(result);
  assert.throws(() => evidence.verifyGeneratedReadTranscript(changedPage, proof), /physical_page_text_mismatch/);
});

test('Art Direction evidence prevents a false no-generation-tool diagnosis', () => {
  assert.equal(evidence.generationFailure({ workCount: 0, terminalState: 'completed', artDirectionRequests: 1 }),
    'generation_started_without_registered_work');
  assert.equal(evidence.generationFailure({ workCount: 0, terminalState: 'completed' }), 'provider_no_generation_tool_call');
});

test('preserves local interception, tool, rendering and registration failure distinctions', () => {
  assert.equal(evidence.generationFailure({ workCount: 0, localRejections: ['output_budget_missing'] }), 'acceptance_local_interception');
  assert.equal(evidence.generationFailure({ workCount: 0, receipts: [{ toolId: 'generate_pptx', status: 'failed' }] }), 'generation_tool_failed');
  assert.equal(evidence.generationFailure({ workCount: 0, receipts: [{ toolId: 'generate_pptx', status: 'unknown' }] }), 'generation_result_unknown');
  for (const [code, expected] of [['document_render', 'document_render_failed'], ['document_register', 'document_registration_failed']]) {
    assert.equal(evidence.generationFailure({ workCount: 0, trace: [{ code, status: 'failed' }], localRejections: ['feedback_stopped'] }), expected);
  }
  assert.equal(evidence.generationFailure({ workCount: 0, trace: [{ code: 'document_check', status: 'failed' }],
    receipts: [{ toolId: 'generate_pptx', status: 'failed' }], localRejections: ['generation_tool_failed'] }), 'document_validation_failed');
  assert.equal(evidence.generationFailure({ workCount: 2 }), 'duplicate_generated_work');
  assert.equal(evidence.generationFailure({ workCount: 1, receipts: [{ toolId: 'generate_pptx', status: 'unknown' }] }), undefined);
});

test('malformed provider tool receipts remain classifiable evidence', () => {
  for (const content of ['null', '[]', '1', 'broken JSON', '{"status":"failed","diagnostics":{}}']) {
    const receipts = evidence.toolReceipts([
      { role: 'assistant', tool_calls: [{ id: 'call', function: { name: 'generate_pptx' } }] },
      { role: 'tool', tool_call_id: 'call', content }
    ]);
    assert.equal(evidence.generationFailure({ workCount: 0, receipts }), 'generation_tool_failed');
  }
});

test('summarizes actual tool results without exposing arguments, observations or paths', () => {
  const receipts = evidence.toolReceipts([
    { role: 'assistant', tool_calls: [{ id: 'call', function: { name: 'generate_pptx', arguments: 'private brief' } }] },
    { role: 'tool', tool_call_id: 'call', content: JSON.stringify({ status: 'failed', observation: 'private content',
      diagnostics: [{ code: 'verification_failed' }, { code: 'C:\\private\\file' }] }) }
  ]);
  assert.deepEqual(receipts, [{ toolId: 'generate_pptx', status: 'failed', diagnosticCodes: ['verification_failed'] }]);
  assert.equal(evidence.toolReceipts([{ role: 'tool', content: '{}' }]).length, 0);
});
