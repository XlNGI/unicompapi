const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1686, height: 990 } });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.route('**/__timeline-check', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/node_modules/rsuite/dist/rsuite-no-reset.min.css"><link rel="stylesheet" href="/src/styles/rsuite-bridge.css"><link rel="stylesheet" href="/src/styles.css"></head><body><div id="check-root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const {VideoEditingPage} = await import('/src/pages/creation/video/VideoEditingPage.tsx');
      const canvas = document.createElement('canvas');
      canvas.width = 6400; canvas.height = 264;
      const ctx = canvas.getContext('2d');
      for (let i=0;i<40;i++) {
        ctx.fillStyle = i%2 ? '#256c76' : '#af405d'; ctx.fillRect(i*160,0,160,264);
        ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText(String(i+1),i*160+45,140);
      }
      const sheet = canvas.toDataURL();
      const ok = value => ({ok:true,value});
      const draft = {
        schemaVersion:1,kind:'video_basic_edit',draftId:'layout-check',projectId:'check',title:'时间线布局验证',revision:1,
        sourceIntent:{kind:'blank'},canvas:{aspectRatio:{kind:'source'},transformPolicy:'fit',background:{kind:'solid',color:'#000000'}},
        videoTrack:[{clipId:'clip',source:{fileId:'file',identity:{sizeBytes:100,durationUs:5042000,container:'mp4',width:678,height:1356}},
          sourceRange:{inUs:0,outUs:5042000},speed:{numerator:1,denominator:1},transform:{scalePermille:1000,positionXPermille:0,positionYPermille:0,rotationMilliDegrees:0,flipX:false,flipY:false,crop:null},sourceAudio:{muted:false,volumePermille:1000},transitionToNext:{kind:'none'}}],
        removedClips:[],textTrack:[],backgroundMusic:null,cover:null,
        outputPreference:{container:{kind:'auto'},videoCodec:{kind:'auto'},audioCodec:{kind:'auto'},resolution:{kind:'source'},frameRate:{kind:'source'},quality:{kind:'auto'},hardwareAcceleration:'auto',conflictPolicy:'create_unique_name'},
        canUndo:false,canRedo:false,createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:00:00Z'
      };
      window.unicomp = {
        storage:{getProjectSession:async()=>ok({projectId:'check',projectName:'布局验证'}),listWorks:async()=>ok({items:[]}),listTasks:async()=>ok({items:[]})},
        videoEditors:{list:async()=>ok([draft]),getSourceStatus:async()=>ok({clipId:'clip',state:'available',issues:[],referenceKind:'external_reference',relinkRequired:false}),
          createSourcePreview:async()=>ok({url:'data:video/mp4;base64,',expiresAt:'2099-01-01T00:00:00Z',mimeType:'video/mp4'}),requestPreviewArtifact:async()=>ok({url:sheet})}
      };
      createRoot(document.getElementById('check-root')).render(React.createElement(VideoEditingPage));
    </script></body></html>` }));
    await page.goto('http://localhost:5173/__timeline-check');
    const clip = page.locator('.uc-video-editor__seg').first();
    await clip.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.uc-video-editor__contact-sheet').length === 8);
    const initial = await clip.boundingBox();
    assert(Math.abs(initial.width - 403.36) < 1);
    assert.equal(await page.locator('.uc-video-editor__thumbnail').count(), 8);
    const assertFilledCells = async () => {
      const cells = await page.locator('.uc-video-editor__thumbnail').evaluateAll(slots => slots.map(slot => {
        const cell = slot.querySelector('.uc-video-editor__contact-sheet-cell');
        const image = cell?.querySelector('img');
        if (!image) return null;
        const bounds = slot.getBoundingClientRect();
        const inner = cell.getBoundingClientRect();
        const picture = image.getBoundingClientRect();
        return { slotWidth: slot.clientWidth, cellWidth: inner.width,
          frameWidth: picture.width / 40, height: picture.height, slotHeight: bounds.height };
      }));
      for (const cell of cells.filter(Boolean)) {
        assert(cell.cellWidth >= cell.slotWidth - 0.1, 'thumbnail cell leaves horizontal blank space');
        assert(cell.frameWidth >= cell.slotWidth - 0.1, 'source frame does not fill its cell');
        assert(cell.height >= cell.slotHeight - 0.1, 'source frame leaves vertical blank space');
      }
    };
    await assertFilledCells();
    const dimensions = await page.locator('.uc-video-editor__contact-sheet').first().evaluate(img => ({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,natural:img.naturalWidth}));
    assert.equal(dimensions.natural, 6400);
    assert(Math.abs(dimensions.width / dimensions.height - 6400/264) < 0.1);
    await page.screenshot({path:path.join(__dirname,'render-desktop.png'),fullPage:true});
    await page.mouse.move(initial.x+160,initial.y+35);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0,-360);
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('.uc-video-editor__thumbnail').length > 8);
    const enlarged = await page.locator('.uc-video-editor__thumbnail').count();
    assert(enlarged > 8);
    await assertFilledCells();
    assert.equal(await page.getByRole('button',{name:'适配全部',exact:true}).count(), 0);
    await page.setViewportSize({width:1024,height:768});
    await page.screenshot({path:path.join(__dirname,'render-compact.png'),fullPage:true});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({initialWidth:initial.width,initialFrames:8,enlargedFrames:enlarged,sprite:dimensions,errors}));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
