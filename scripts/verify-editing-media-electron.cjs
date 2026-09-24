const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9);
if (!source) throw new Error('--source=<absolute video path> required');
const output = path.join(root, 'outputs', 'editing-mp4');
const label = process.argv.includes('--after') ? 'after' : 'before';
app.setPath('userData', path.join(os.tmpdir(), `unicomp-editing-media-${process.pid}`));
app.commandLine.appendSwitch('disable-background-networking');
protocol.registerSchemesAsPrivileged([{ scheme: 'unicomp-media', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true
} }]);
let window;
const report = { source: path.basename(source), checks: [] };
const deadline = setTimeout(() => app.exit(1), 45000);
async function run() {
  const bundled = await require(require.resolve('esbuild', { paths: [require.resolve('vite')] })).build({
    entryPoints: [path.join(root, 'electron/ipc/local-media-response.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs'
  });
  const loaded = new Module(path.join(root, 'media-response-check.cjs'));
  loaded.filename = path.join(root, 'media-response-check.cjs');
  loaded.paths = module.paths;
  loaded._compile(bundled.outputFiles[0].text, loaded.filename);
  await app.whenReady();
  protocol.handle('unicomp-media', request => loaded.exports.createLocalMediaResponse(
    source, new URL(request.url).searchParams.get('mime') || undefined,
    request.method, request.headers.get('range') || undefined
  ));
  window = new BrowserWindow({ show: true, width: 960, height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_request, callback) => callback({ cancel: true }));
  await window.loadURL('data:text/html,<html><body style="margin:0;background:%23222"><video controls style="width:100%;height:600px"></video></body></html>');
  for (const mime of ['', path.extname(source) === '.mp4' ? 'video/mp4' : 'video/webm']) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const video = document.querySelector('video');
      video.src = ${JSON.stringify(`unicomp-media://local/probe?mime=${encodeURIComponent(mime)}`)};
      video.muted = true;
      const loaded = await new Promise(resolve => {
        const timer = setTimeout(() => resolve('timeout'), 8000);
        video.onloadeddata = () => { clearTimeout(timer); resolve('loaded'); };
        video.onerror = () => { clearTimeout(timer); resolve('error'); };
      });
      let playback;
      try { playback = await Promise.race([video.play().then(() => 'playing'), new Promise(resolve => setTimeout(() => resolve('play timeout'), 3000))]); } catch (e) { playback = e.message; }
      if (loaded === 'loaded') {
        await new Promise(resolve => { setTimeout(resolve, 3000); video.onseeked = resolve; video.currentTime = video.duration / 2; });
      }
      const seekTime = video.currentTime;
      const ended = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 15000);
        video.onended = () => { clearTimeout(timer); resolve(true); };
        video.onerror = () => { clearTimeout(timer); resolve(false); };
      });
      const result = {loaded, playback, error: video.error?.message, code: video.error?.code,
        duration: video.duration, width: video.videoWidth, seekTime, ended,
        advanced: video.currentTime > seekTime, time: video.currentTime, readyState: video.readyState};
      video.pause(); return result;
    })()`);
    report.checks.push({ mime: mime || 'omitted', ...result });
  }
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, `${label}.png`), (await window.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (label === 'after' && report.checks.some(check =>
    check.loaded !== 'loaded' || check.playback !== 'playing' || check.error ||
    !check.ended || !check.advanced || check.width <= 0
  )) throw new Error('MP4 playback acceptance failed');
}
run().then(() => { clearTimeout(deadline); app.exit(0); }).catch(error => {
  console.error(error); clearTimeout(deadline); app.exit(1);
});
