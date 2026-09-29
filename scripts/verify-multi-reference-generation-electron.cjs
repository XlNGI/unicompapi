const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const checks = [];
let step = 'startup';
let rendererErrors = [];
let win;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (source) => win.webContents.executeJavaScript(source);
async function until(source) {
  for (let index = 0; index < 160; index += 1) {
    try {
      if (await js(source)) return;
    } catch (error) {
      throw new Error(`Renderer evaluation failed for ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await delay(50);
  }
  throw new Error(`Timed out: ${source}`);
}
async function labels() {
  return js(`Array.from(document.querySelectorAll('.uc-image-professional__reference-label')).map((node) => node.textContent)`);
}
async function setPrompt(value) {
  await js(`(() => { const input = document.querySelector('textarea[aria-label="原始创作需求"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await delay(750);
}
async function click(label) {
  step = `click:${label}`;
  await until(`Array.from(document.querySelectorAll('button')).some((button) => button.getAttribute('aria-label') === ${JSON.stringify(label)} && !button.disabled)`);
  await js(`Array.from(document.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === ${JSON.stringify(label)}).click()`);
  await delay(120);
}
async function selectFixtureModel(modelName, candidateCall, draftExpression, candidateId) {
  await until(`${candidateCall} > 0 && document.querySelector('.uc-model-select .rs-picker-toggle')`);
  await js(`document.querySelector('.uc-model-select .rs-picker-toggle').click()`);
  await until(`Array.from(document.querySelectorAll('.rs-picker-select-menu-item')).some((item) => item.textContent.includes(${JSON.stringify(modelName)}))`);
  await js(`Array.from(document.querySelectorAll('.rs-picker-select-menu-item')).find((item) => item.textContent.includes(${JSON.stringify(modelName)})).click()`);
  await until(`${draftExpression}?.featureSelection?.candidateId === ${JSON.stringify(candidateId)}`);
  const selected = await js(`${draftExpression}.featureSelection.candidateId`);
  assert.equal(selected, candidateId, `Model candidate was not selected: ${modelName}`);
  await until(`document.querySelector('.uc-model-select .rs-picker-toggle')?.innerText.includes(${JSON.stringify(modelName)})`);
}

async function assertPromptFillsSpareHeight(label) {
  const measured = await js(`(() => {
    const field = document.querySelector('.uc-image-professional__before-scroll > .uc-card:first-child > .uc-image-quick__field, .uc-generation-two-pane__preparation-flow > .uc-card:first-child > .uc-image-quick__field');
    const prompt = field?.querySelector('.uc-image-professional__prompt-textarea');
    if (!field || !prompt) return null;
    const previous = field.style.minHeight;
    field.style.minHeight = '640px';
    const fieldRect = field.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    field.style.minHeight = previous;
    return {
      fieldHeight: Math.round(fieldRect.height),
      slack: Math.round(fieldRect.bottom - promptRect.bottom)
    };
  })()`);
  assert.ok(measured, `${label} prompt field was not measured`);
  assert.ok(measured.fieldHeight >= 600, `${label} field did not grow: ${measured.fieldHeight}px`);
  assert.ok(measured.slack <= 8, `${label} prompt leaves ${measured.slack}px below the textarea`);
}
async function checkReferenceControls() {
  const controls = await js(`(() => {
    const add = document.querySelector('.uc-image-professional__reference-add').getBoundingClientRect();
    const deletes = Array.from(document.querySelectorAll('.uc-image-professional__reference-delete')).map((button) => {
      const rect = button.getBoundingClientRect();
      const frame = button.closest('.uc-image-professional__reference-thumbnail').getBoundingClientRect();
      return {
        contained: rect.top >= frame.top && rect.bottom <= frame.bottom && rect.left >= frame.left && rect.right <= frame.right,
        reachable: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      };
    });
    return { add: { width: add.width, height: add.height }, deletes };
  })()`);
  assert.deepEqual(controls.add, { width: 72, height: 72 });
  assert.ok(controls.deletes.length > 0);
  assert.ok(controls.deletes.every((button) => button.contained && button.reachable), JSON.stringify(controls));
}
async function run() {
  const build = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-multi-reference-'));
  await app.whenReady();
  await require('vite').build({ configFile: false, root, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir: build, emptyOutDir: true, rollupOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } }, lib: { entry: path.join(root, 'tests/harness/multi-reference-generation-harness.tsx'), formats: ['iife'], name: 'MultiReferenceHarness', fileName: () => 'harness.js' } } });
  await fs.writeFile(path.join(build, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  rendererErrors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) rendererErrors.push(message); });
  win.webContents.on('did-fail-load', (_event, code, description) => rendererErrors.push(`load:${code}:${description}`));
  await win.loadFile(path.join(build, 'index.html'));
  await js('window.onerror = (message, source, line, column, error) => { window.__multiReferenceError = { message, source, line, column, stack: error && error.stack }; }; undefined;');
  try {
    await until('window.multiReferenceHarness && document.querySelector("textarea[aria-label=\\"原始创作需求\\"]")');
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), errors: rendererErrors, body: await js('document.body.textContent'), state: await js('window.multiReferenceHarness?.state()') }, null, 2));
    throw error;
  }

  const emptyImageLayout = await js('(() => { const box = document.querySelector(".uc-image-professional__reference.is-empty"); const add = document.querySelector(".uc-image-professional__placeholder-button"); const prompt = document.querySelector(".uc-image-professional__prompt-input"); return { box: { width: box.getBoundingClientRect().width, height: box.getBoundingClientRect().height }, add: { width: add.getBoundingClientRect().width, height: add.getBoundingClientRect().height }, above: document.querySelector(".uc-image-professional__reference-field").getBoundingClientRect().bottom <= prompt.getBoundingClientRect().top }; })()');
  assert.deepEqual(emptyImageLayout, { box: { width: 72, height: 72 }, add: { width: 72, height: 72 }, above: true });
  const emptyImageGap = await js('Math.round(document.querySelector(".uc-image-professional__prompt-input").getBoundingClientRect().top - document.querySelector(".uc-image-professional__reference-field").getBoundingClientRect().bottom)');
  assert.ok(emptyImageGap <= 16, `Empty image reference area leaves ${emptyImageGap}px before the prompt`);
  checks.push('图生图空状态添加框位于提示词上方且为 72×72');

  step = 'image-add-1'; await click('添加图片');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 1');
  step = 'image-add-2'; await click('继续添加图片');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 2');
  step = 'image-add-3'; await click('继续添加图片');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 3');
  assert.deepEqual(await labels(), ['图1', '图2', '图3']);
  await checkReferenceControls();
  step = 'image-prompt'; await setPrompt('图1主体，图2服装，图3背景');
  assert.equal((await js('multiReferenceHarness.state().imageDraft.prompt.finalPrompt')), '图1主体，图2服装，图3背景');
  const size = await js('(() => { const rect = document.querySelector(".uc-image-professional__reference-thumbnail").getBoundingClientRect(); const item = document.querySelector(".uc-image-professional__reference-item"); const label = item.querySelector(".uc-image-professional__reference-label").getBoundingClientRect(); const frame = item.querySelector(".uc-image-professional__reference-thumbnail").getBoundingClientRect(); const button = item.querySelector(".uc-image-professional__reference-delete"); const remove = button.getBoundingClientRect(); const buttonStyle = getComputedStyle(button); const image = item.querySelector("img"); return { width: rect.width, height: rect.height, labelBelow: label.top >= frame.bottom, deleteBottomRight: remove.top >= frame.top && remove.right <= frame.right && remove.left > frame.left, deleteSize: { width: remove.width, height: remove.height }, deleteVisible: buttonStyle.display !== "none" && buttonStyle.visibility === "visible" && Number(buttonStyle.opacity) > 0, hasDeleteIcon: Boolean(button.querySelector("svg")), imageLoaded: image.complete && image.naturalWidth > 0, imageFit: getComputedStyle(image).objectFit }; })()');
  assert.deepEqual(size, {
    width: 72,
    height: 72,
    labelBelow: true,
    deleteBottomRight: true,
    deleteSize: { width: 24, height: 24 },
    deleteVisible: true,
    hasDeleteIcon: true,
    imageLoaded: true,
    imageFit: 'contain'
  });
  const imageLayout = await js('(() => { const reference = document.querySelector(".uc-image-professional__reference-field"); const prompt = document.querySelector(".uc-image-professional__prompt-input"); return { above: reference.getBoundingClientRect().bottom <= prompt.getBoundingClientRect().top, insidePrompt: Boolean(prompt.querySelector(".uc-controlled-image-drop-zone")), items: document.querySelectorAll(".uc-image-professional__reference-item").length, images: document.querySelectorAll(".uc-image-professional__reference-item img").length }; })()');
  assert.equal(imageLayout.above, true);
  assert.equal(imageLayout.insidePrompt, false);
  assert.equal(imageLayout.items, 3);
  assert.equal(imageLayout.images, 3);
  const imageGap = await js('Math.round(document.querySelector(".uc-image-professional__prompt-input").getBoundingClientRect().top - document.querySelector(".uc-image-professional__reference-field").getBoundingClientRect().bottom)');
  assert.ok(imageGap <= 16, `Image reference strip leaves ${imageGap}px before the prompt`);
  await assertPromptFillsSpareHeight('图生图');
  const imageScreenshot = path.join(os.tmpdir(), 'unicomp-multi-reference-image-acceptance.png');
  await selectFixtureModel('Fixture image', 'multiReferenceHarness.state().imageCandidateCalls', 'multiReferenceHarness.state().imageDraft', 'image-candidate');
  await fs.writeFile(imageScreenshot, (await win.webContents.capturePage()).toPNG());
  step = 'image-delete'; await click('删除图1');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 2');
  assert.deepEqual(await labels(), ['图1', '图2']);
  assert.match((await js('multiReferenceHarness.state().imageDraft.prompt.finalPrompt')), /图1（已失效）/);
  assert.equal(await js('document.querySelector(".uc-image-feature-panel__primary").disabled'), true);
  checks.push('图生图实际添加三张参考图、显示连续图号、删除后重排并阻断失效引用');

  step = 'switch-video'; await js('multiReferenceHarness.switchMode("video")');
  const emptyVideoLayout = await js('(() => { const box = document.querySelector(".uc-image-professional__reference.is-empty"); const add = document.querySelector(".uc-image-professional__placeholder-button"); const prompt = document.querySelector(".uc-image-professional__prompt-input"); return { box: { width: box.getBoundingClientRect().width, height: box.getBoundingClientRect().height }, add: { width: add.getBoundingClientRect().width, height: add.getBoundingClientRect().height }, above: document.querySelector(".uc-image-professional__reference-field").getBoundingClientRect().bottom <= prompt.getBoundingClientRect().top }; })()');
  assert.deepEqual(emptyVideoLayout, { box: { width: 72, height: 72 }, add: { width: 72, height: 72 }, above: true });
  const emptyVideoGap = await js('Math.round(document.querySelector(".uc-image-professional__prompt-input").getBoundingClientRect().top - document.querySelector(".uc-image-professional__reference-field").getBoundingClientRect().bottom)');
  assert.ok(emptyVideoGap <= 16, `Empty video reference area leaves ${emptyVideoGap}px before the prompt`);
  checks.push('图生视频空状态添加框位于提示词上方且为 72×72');
  step = 'video-add-1'; await click('添加图片');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 1');
  step = 'video-drop-real-file'; await js('multiReferenceHarness.dropImage()');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 2');
  assert.deepEqual(await js('multiReferenceHarness.state().importedVideoFile'), { name: 'drag-reference.png', type: 'image/png' });
  step = 'video-add-3'; await click('继续添加图片');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 3');
  assert.deepEqual(await labels(), ['图1', '图2', '图3']);
  step = 'video-prompt'; await setPrompt('图1作为人物，图2作为服装，图3作为背景');
  await checkReferenceControls();
  step = 'video-delete'; await click('删除图2');
  await until('document.querySelectorAll(".uc-image-professional__reference-label").length === 2');
  assert.deepEqual(await labels(), ['图1', '图2']);
  assert.match((await js('multiReferenceHarness.state().videoDraft.prompt.finalPrompt')), /图2（已失效）/);
  assert.equal(await js('document.querySelector(".uc-image-feature-panel__primary").disabled'), true);
  step = 'video-valid-prompt'; await setPrompt('图1作为人物，图2作为背景');
  assert.doesNotMatch((await js('multiReferenceHarness.state().videoDraft.prompt.finalPrompt')), /已失效/);
  await selectFixtureModel('Fixture video', 'multiReferenceHarness.state().videoCandidateCalls', 'multiReferenceHarness.state().videoDraft', 'video-candidate');
  const videoDesktopScreenshot = path.join(os.tmpdir(), 'unicomp-multi-reference-video-desktop-acceptance.png');
  await fs.writeFile(videoDesktopScreenshot, (await win.webContents.capturePage()).toPNG());
  await assertPromptFillsSpareHeight('图生视频');
  await win.setSize(800, 720);
  await delay(100);
  const layout = await js('(() => { const strip = document.querySelector(".uc-image-professional__reference-strip"); const rect = strip.getBoundingClientRect(); return { right: rect.right, viewport: innerWidth, item: document.querySelector(".uc-image-professional__reference-item").getBoundingClientRect().width }; })()');
  assert.ok(layout.right <= layout.viewport + 4);
  assert.equal(layout.item, 72);
  const videoLayout = await js('(() => { const reference = document.querySelector(".uc-image-professional__reference-field"); const prompt = document.querySelector(".uc-image-professional__prompt-input"); return { above: reference.getBoundingClientRect().bottom <= prompt.getBoundingClientRect().top, insidePrompt: Boolean(prompt.querySelector(".uc-controlled-image-drop-zone")), items: document.querySelectorAll(".uc-image-professional__reference-item").length, images: document.querySelectorAll(".uc-image-professional__reference-item img").length }; })()');
  assert.equal(videoLayout.above, true);
  assert.equal(videoLayout.insidePrompt, false);
  assert.equal(videoLayout.items, 2);
  assert.equal(videoLayout.images, 2);
  const videoGap = await js('Math.round(document.querySelector(".uc-image-professional__prompt-input").getBoundingClientRect().top - document.querySelector(".uc-image-professional__reference-field").getBoundingClientRect().bottom)');
  assert.ok(videoGap <= 16, `Video reference strip leaves ${videoGap}px before the prompt`);
  const videoPreviewState = await js('(() => ({ loaded: Array.from(document.querySelectorAll(".uc-image-professional__reference-item img")).every((image) => image.complete && image.naturalWidth > 0), indexes: multiReferenceHarness.state().videoPreviewTargets }))()');
  assert.equal(videoPreviewState.loaded, true, 'Every image-to-video reference preview must render a decoded image');
  assert.ok(videoPreviewState.indexes.includes(0) && videoPreviewState.indexes.includes(1), JSON.stringify(videoPreviewState));
  const videoScreenshot = path.join(os.tmpdir(), 'unicomp-multi-reference-video-acceptance.png');
  await fs.writeFile(videoScreenshot, (await win.webContents.capturePage()).toPNG());
  checks.push('图生视频实际添加三张共同参考图、删除后重排并阻断失效引用；窄窗口无横向溢出');
  assert.deepEqual(rendererErrors.filter((error) => !error.includes('Electron Security Warning')), []);
  console.log(JSON.stringify({ checks, measurements: { reference: size }, screenshots: [imageScreenshot, videoDesktopScreenshot, videoScreenshot], errors: rendererErrors }, null, 2));
}

const timer = setTimeout(() => { console.error('Multi-reference Electron acceptance timed out'); app.exit(1); }, 120000);
run().then(() => { clearTimeout(timer); win?.destroy(); app.exit(0); }).catch(async (error) => {
  clearTimeout(timer);
  console.error(`step=${step}`);
  console.error(JSON.stringify({ errors: rendererErrors, rendererError: win ? await js('window.__multiReferenceError') : undefined }, null, 2));
  console.error(error);
  win?.destroy();
  app.exit(1);
});
