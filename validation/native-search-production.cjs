const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
require('node:fs').mkdirSync(path.join(base, 'tmp'), {recursive:true});
const runRoot = require('node:fs').mkdtempSync(path.join(base, 'tmp/native-e2e-'));
console.log('Synthetic E2E artifacts:', runRoot);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.setPath('userData', path.join(runRoot, 'user-data'));
const deadline = setTimeout(() => app.exit(1), 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, (...args) => { calls.push(channel); return listener(...args); });
const transport = require(path.join(base, 'dist-electron/electron/ipc/management-adapters.js'));
const chatRequests = [];
const useGlm = process.env.UNICOMP_TEST_NATIVE_PROTOCOL === 'glm';
const usePpt = process.env.UNICOMP_TEST_NATIVE_DOCUMENT === 'ppt';
const modelKey = useGlm ? 'glm-5.2' : 'kimi-k3';
const outputContent = usePpt ? JSON.stringify({kind:'ppt',title:'太阳系科普',sections:[{heading:'太阳系的基本组成',level:1,pageKind:'insight',takeaway:'太阳及其周围天体组成太阳系',blocks:[{type:'bullets',items:['恒星：太阳是太阳系的中心天体。','行星：八大行星环绕太阳运行。','其他天体：卫星、小行星和彗星也属于太阳系。']}]}]}) : '公开新闻检索已完成（合成协议验收）。';
const cls=require(path.join(base,'dist-electron/src/platform/ipc/conversation-response-controller.js')).ConversationResponseController;
const original=cls.prototype.startValidated;
cls.prototype.startValidated=async function(...args){try{return await original.apply(this,args);}catch(e){console.log('startValidated',e.stack);throw e;}};
transport.ElectronNewApiHttpTransport.prototype.send = async function(request) {
  if(request.method === 'GET' && request.url.endsWith('/models')) return {status:200, headers:{'content-type':'application/json'}, body:new TextEncoder().encode(JSON.stringify({object:'list',data:[{id:modelKey,object:'model'}]}))};
  assert.equal(request.method,'POST');assert.ok(request.url.endsWith('/chat/completions'));
  const body=JSON.parse(new TextDecoder().decode(request.body));chatRequests.push(body);
  assert.ok(body.tools?.some(t=>t.type===(useGlm?'web_search':'builtin_function')), 'Unexpected non-search model request');
  const continued=useGlm || body.messages.some(m=>m.role==='tool');
  const chunk={id:'chatcmpl-synthetic-'+chatRequests.length,object:'chat.completion.chunk',model:modelKey,...(useGlm?{web_search:[{title:'合成资料来源',link:'https://example.com/source'}]}:{}),choices:[{index:0,delta:continued?{content:outputContent}:{tool_calls:[{index:0,id:'call_search_1',type:'function',function:{name:'$web_search',arguments:JSON.stringify({query:'公开新闻',usage:{total_tokens:12}})}}]},finish_reason:continued?'stop':'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}};
  return {status:200,headers:{'content-type':'text/event-stream'},stream:(async function*(){yield new TextEncoder().encode('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n');})()};
};
// Isolated project/userData and synthetic HTTP responses only. Production
// renderer, preload, IPC, authorization, parsing, and repositories remain real.
const platform = require(path.join(base, 'dist-electron/src/platform'));
platform.StorageProjectSessionRegistry.prototype.get = () => ({
  projectId: 'project-ppt-live-e2e', projectName: 'PPT 追问实机验收', rootDirectory: path.join(runRoot, 'project')
});
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
(async () => {
  require('node:fs').mkdirSync(path.join(runRoot, 'project'), {recursive:true});
  require('node:fs').mkdirSync(app.getPath('userData'), {recursive:true});
  let networkRequests = 0;
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_request, callback) => { networkRequests++; callback({cancel:true}); }));
  require(path.join(base, 'dist-electron/electron/main.js'));
  await app.whenReady();
  let win;
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && await win.webContents.executeJavaScript('Boolean(document.querySelector(".app-shell"))').catch(() => false)) break;
    await pause(150);
  }
  assert.ok(win);
  win.webContents.on('console-message',(_e,_l,m)=>console.log('renderer:',m));
  const setup = await win.webContents.executeJavaScript(`(async()=>{
    const p=window.unicomp.providers;
    const added=await p.addConnection({packageId:${JSON.stringify(useGlm?'provider-package-unicompapi':'provider-package-kimi')},templateId:${JSON.stringify(useGlm?'unicompapi-official':'kimi-official')},name:'Synthetic search',credentials:{api_key:'synthetic-offline-only'}});
    if(!added.ok)throw new Error(JSON.stringify(added));
    const reg=await p.getRegistry();if(!reg.ok)throw new Error(JSON.stringify(reg));
    const model=reg.value.models.find(m=>m.providerModelKey===${JSON.stringify(modelKey)});if(!model)throw new Error(JSON.stringify(reg));
    const enabled=await p.setModelEnabled(model.modelId,true);if(!enabled.ok)throw new Error(JSON.stringify(enabled));
    if(${useGlm}){const r=await p.getRegistry();const m=r.value.models.find(m=>m.modelId===model.modelId);const n=await p.setNativeSearch({modelId:m.modelId,expectedRevision:m.revision,protocol:'glm_web_search',enabled:true,evidenceUrl:'https://docs.bigmodel.cn/cn/guide/tools/web-search'});if(!n.ok)throw new Error(JSON.stringify(n));}return true;
  })()`);
  assert.equal(setup,true);
  await win.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()==='对话');if(e)e.click();})()`);
  for(let i=0;i<60;i++){if(await win.webContents.executeJavaScript('!!document.querySelector("textarea")'))break;await pause(100);}
  await pause(600);
  await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('[aria-label=模型设置]');if(!e)throw new Error(document.body.innerText);e.click();})()`);
  await pause(250);
  await win.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes(${JSON.stringify(modelKey)}));if(!e)throw new Error(document.body.innerText);e.click();})()`);
  await pause(150);
  async function send(text){
    await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await pause(150);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("[aria-label=发送消息]").disabled'),false);
    await win.webContents.executeJavaScript('document.querySelector("[aria-label=发送消息]").click()');
  }
  await send(usePpt?'联网查询公开资料，制作3页太阳系科普PPT':'联网查询公开新闻');
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('document.body.textContent.includes("是否允许本次联网")'))break;await pause(100);}
  const before=await win.webContents.executeJavaScript('document.body.innerText');
  assert.ok(before.includes('是否允许本次联网'),before);
  assert.equal(chatRequests.length,0);
  await send('允许本次联网');
  for(let i=0;i<120;i++){if(await win.webContents.executeJavaScript(`document.body.textContent.includes(${JSON.stringify(usePpt?'太阳系科普':'公开新闻检索已完成（合成协议验收）')})`))break;await pause(100);}
  if(usePpt){for(let i=0;i<250;i++){if(await win.webContents.executeJavaScript('document.body.textContent.includes(".pptx")'))break;await pause(100);}}
  const after=await win.webContents.executeJavaScript('document.body.innerText');
  assert.ok(after.includes(usePpt?'太阳系科普':'公开新闻检索已完成（合成协议验收）'),after);
  assert.ok(after.includes('已收到服务商的搜索执行记录'),after);
  assert.equal(chatRequests.length,useGlm?1:2);assert.equal(networkRequests,0);
  assert.equal(chatRequests[0].messages.filter(m=>m.role==='user').length,1);
  assert.ok(!JSON.stringify(chatRequests).includes('允许本次联网'));
  if(usePpt){
    assert.ok(after.includes('.pptx'),after);
    const list=await fs.readdir(path.join(runRoot,'project/files/documents'));
    const files=list.filter(f=>f.endsWith('.pptx'));assert.equal(files.length,1);
    const zip=await require('jszip').loadAsync(await fs.readFile(path.join(runRoot,'project/files/documents',files[0])));
    const slides=Object.keys(zip.files).filter(f=>/^ppt\/slides\/slide\d+\.xml$/.test(f));assert.equal(slides.length,3);
    const saved=await win.webContents.executeJavaScript(`(async()=>{const l=await window.unicomp.chatContexts.listConversations(true,false);const c=await window.unicomp.chatContexts.getConversation(l.value[0].conversationId);return c.value.messages.some(m=>m.documentResult?.workId);})()`);
    assert.equal(saved,true);
  }
  const ledger=JSON.parse(await fs.readFile(path.join(runRoot,'project/entities/conversation-native-search.json'),'utf8'));
  assert.equal(ledger.sessions.at(-1).evidence.status,'completed');
  win.setSize(1400,900);await pause(200);
  await fs.writeFile(path.join(runRoot,'native-search-'+(useGlm?'glm':'kimi')+(usePpt?'-ppt':'')+'-production.png'),(await win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(runRoot,'native-search-'+(useGlm?'glm':'kimi')+(usePpt?'-ppt':'')+'-production-result.json'),JSON.stringify({passed:true,mockedSearchRequests:chatRequests.length,realNetworkRequests:networkRequests,scope:'synthetic current task only',protocol:useGlm?'glm_web_search':'kimi_builtin',document:usePpt?'ppt':null,evidence:ledger.sessions.at(-1).evidence},null,2));
  console.log('Production renderer -> preload -> IPC -> workflow -> JSON persistence: passed');
  clearTimeout(deadline);app.quit();
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
