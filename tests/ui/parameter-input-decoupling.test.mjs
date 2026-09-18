import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * P3 contract: a keystroke must not replace the workspace draft.
 *
 * These are source-level contracts, not behaviour tests. The behaviour is
 * covered by tests/platform/dynamic-parameter-buffer.test.ts (buffer semantics)
 * and by Electron acceptance in P4 (real interaction). What is asserted here is
 * the *wiring* that makes the decoupling real: the form owns buffers, commits
 * only on a stable boundary, exposes a synchronous flush before save/submit,
 * and the parents compose commits from the latest snapshot.
 */

const form = await readFile('src/components/DynamicParameterForm.tsx', 'utf8');
const buffer = await readFile('src/components/dynamic-parameter-buffer.ts', 'utf8');
const videoPanel = await readFile(
  'src/pages/creation/video/VideoFeatureSubmissionPanel.tsx',
  'utf8'
);
const imagePanel = await readFile(
  'src/pages/creation/image/ImageFeatureSubmissionPanel.tsx',
  'utf8'
);
const autosave = await readFile('src/ui/use-latest-snapshot-autosave.ts', 'utf8');
const probe = await readFile('src/ui/parameter-input-performance-probe.ts', 'utf8');

test('the parameter form keeps per-field buffers instead of committing every keystroke', () => {
  const bufferedInput = form.slice(
    form.indexOf('const handleBufferedInput'),
    form.indexOf('const handleDiscreteChange')
  );
  assert.ok(bufferedInput.length > 0, 'handleBufferedInput must exist');
  // The input path only touches local state; it never calls the parent.
  assert.match(bufferedInput, /setBuffers\(/);
  assert.match(bufferedInput, /applyParameterFieldInput\(/);
  assert.match(bufferedInput, /PARAMETER_COMMIT_IDLE_MS/);
  assert.doesNotMatch(bufferedInput, /onChangeRef\.current/);
  assert.doesNotMatch(bufferedInput, /onDraftChange/);
});

test('a stable value is committed on blur, Enter, idle or an explicit flush', () => {
  assert.match(form, /onBlur=\{onCommit\}/);
  assert.match(form, /onKeyDown=\{commitOnEnter\}/);
  assert.match(form, /const commitField = useCallback\(/);
  assert.match(form, /clearIdleTimer\(fieldId\)/);
  assert.match(form, /setTimeout\(\(\) => \{[\s\S]*commitField\(fieldId\)/);
  // An invalid intermediate never reaches the parent.
  assert.match(form, /if \(buffer\.blocked \|\| buffer\.error\) return;/);
  assert.match(form, /normalizeCommittedBuffers\(/);
});

test('the form exposes a synchronous flush for the save and submit paths', () => {
  assert.match(form, /forwardRef</);
  assert.match(form, /useImperativeHandle\(ref/);
  assert.match(form, /flush\(\): DynamicParameterBufferFlush/);
  assert.match(form, /export interface DynamicParameterFormHandle/);
  // Leaving the page must not drop the last stable value either.
  assert.match(form, /hasPendingParameterBuffer\(pending\)/);
  assert.match(buffer, /export function hasPendingParameterBuffer/);
});

test('the buffer module owns parsing, keeps invalid text and reuses the validator', () => {
  assert.match(buffer, /JSON\.parse\(text\)/);
  assert.match(buffer, /validateDynamicParameterValue/);
  assert.match(buffer, /isPartialNumberText/);
  assert.match(buffer, /flushParameterFieldBuffers/);
  assert.match(buffer, /sameParameterValue/);
  // Wording stays owned by the shared validator, not duplicated here.
  assert.doesNotMatch(buffer, /请输入有效的 JSON 对象/);
});

test('both submission panels flush pending edits and re-validate before dispatch', () => {
  for (const panel of [videoPanel, imagePanel]) {
    assert.match(panel, /useRef<DynamicParameterFormHandle>\(null\)/);
    assert.match(panel, /ref=\{parameterFormRef\}/);
    assert.match(panel, /function commitPendingParameterEdits\(\)/);
    assert.match(panel, /handle\.flush\(\)/);
    assert.match(panel, /commitPendingParameterEdits\(\)/);
    assert.match(panel, /pendingEdits\.values/);
    assert.match(panel, /pendingEdits\.errors/);
    // Commits compose from the latest snapshot, so two fields committed in one
    // tick cannot overwrite each other.
    assert.match(panel, /draftRef\.current = next;/);
    assert.doesNotMatch(panel, /featureSelection\.parameterValues \} as Record/);
  }
  assert.match(videoPanel, /surface="video_generation"/);
  assert.match(imagePanel, /surface="image_generation"/);
});

test('candidate reads and autosave IPC are attributed to a pending keystroke', () => {
  assert.match(videoPanel, /reportParameterInputCandidateRequest\(\)/);
  assert.match(imagePanel, /reportParameterInputCandidateRequest\(\)/);
  assert.match(autosave, /reportParameterInputAutosaveIpc\(\)/);
  assert.match(probe, /setActiveParameterInputProbe/);
  assert.match(probe, /export function reportParameterInputCandidateRequest/);
  assert.match(probe, /export function reportParameterInputAutosaveIpc/);
  // Counters belong to one keystroke.
  assert.match(probe, /pendingRenders = 0;\n      scheduleIdleFlush\(\);/);
  assert.match(probe, /parameterAreaRenderCount: pendingRenders/);
});
