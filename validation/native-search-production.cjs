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
// UNICOMP_TEST_NATIVE_SCENARIO: explicit (existing search), fresh (latest facts
// without a search verb), unavailable (gateway without capability), offline,
// or declined. Every scenario uses isolated synthetic transport and storage.
const scenario = process.env.UNICOMP_TEST_NATIVE_SCENARIO || 'explicit';
assert.ok(['explicit', 'fresh', 'unavailable', 'offline', 'declined'].includes(scenario), 'Unknown native search scenario');
const useGlm = process.env.UNICOMP_TEST_NATIVE_PROTOCOL === 'glm';
const usePpt = process.env.UNICOMP_TEST_NATIVE_DOCUMENT === 'ppt' || scenario !== 'explicit';
const useGateway = useGlm || scenario === 'unavailable';
const expectsSearch = ['explicit', 'fresh'].includes(scenario);
const expectsDocument = usePpt && scenario !== 'unavailable';
const modelKey = useGlm ? 'glm-5.2' : 'kimi-k3';
const useFreshTopic=['fresh','unavailable','declined'].includes(scenario);
const outputTitle=useFreshTopic?'新能源汽车政策与市场数据':'太阳系科普';
const outputContent = usePpt ? JSON.stringify({kind:'ppt',title:outputTitle,sections:[{heading:useFreshTopic?'政策与市场资料概览':'太阳系的基本组成',level:1,pageKind:'insight',takeaway:useFreshTopic?'本页仅为隔离验收的合成内容':'太阳及其周围天体组成太阳系',blocks:[{type:'bullets',items:useFreshTopic?['政策范围：本条为合成示例。','市场数据：本条不含真实统计值。','时效说明：不可用于实际政策判断。']:['恒星：太阳是太阳系的中心天体。','行星：八大行星环绕太阳运行。','其他天体：卫星、小行星和彗星也属于太阳系。']}]}]}) : '公开新闻检索已完成（合成协议验收）。';
const cls=require(path.join(base,'dist-electron/src/platform/ipc/conversation-response-controller.js')).ConversationResponseController;
const original=cls.prototype.startValidated;
cls.prototype.startValidated=async function(...args){try{return await original.apply(this,args);}catch(e){console.log('startValidated',e.stack);throw e;}};
transport.ElectronNewApiHttpTransport.prototype.send = async function(request) {
  if(request.method === 'GET' && request.url.endsWith('/models')) return {status:200, headers:{'content-type':'application/json'}, body:new TextEncoder().encode(JSON.stringify({object:'list',data:[{id:modelKey,object:'model'}]}))};
  assert.equal(request.method,'POST');assert.ok(request.url.endsWith('/chat/completions'));
  const body=JSON.parse(new TextDecoder().decode(request.body));chatRequests.push(body);
  assert.notEqual(scenario,'unavailable','An unavailable search request must stop before model dispatch');
  const hasSearchTools=body.tools?.some(t=>t.type==='web_search'||t.type==='builtin_function')??false;
  assert.equal(hasSearchTools,expectsSearch,'Search tools must match the authorized scenario');
  if(expectsSearch)assert.ok(body.tools.some(t=>t.type===(useGlm?'web_search':'builtin_function')), 'Unexpected search protocol');
  const continued=!expectsSearch || useGlm || body.messages.some(m=>m.role==='tool');
  const chunk={id:'chatcmpl-synthetic-'+chatRequests.length,object:'chat.completion.chunk',created:1,model:modelKey,...(expectsSearch&&useGlm?{web_search:[{title:'合成资料来源',link:'https://example.com/source'}]}:{}),choices:[{index:0,delta:continued?{content:outputContent}:{tool_calls:[{index:0,id:'call_search_1',type:'function',function:{name:'$web_search',arguments:JSON.stringify({query:'公开新闻',usage:{total_tokens:12}})}}]},finish_reason:continued?'stop':'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}};
  return {status:200,headers:{'content-type':'text/event-stream'},stream:(async function*(){
    if(expectsSearch&&useGlm){
      yield new TextEncoder().encode('data: '+JSON.stringify({id:chunk.id,model:modelKey,choices:[],web_search:chunk.web_search})+'\n\n');
      await pause(3000);
      delete chunk.web_search;
    }
    yield new TextEncoder().encode('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n');
  })()};
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
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message',(_e,_l,m)=>console.log('renderer:',m));
  const setup = await win.webContents.executeJavaScript(`(async()=>{
    const p=window.unicomp.providers;
    const added=await p.addConnection({packageId:${JSON.stringify(useGateway?'provider-package-unicompapi':'provider-package-kimi')},templateId:${JSON.stringify(useGateway?'unicompapi-official':'kimi-official')},name:'Synthetic search',credentials:{api_key:'synthetic-offline-only'}});
    if(!added.ok)throw new Error(JSON.stringify(added));
    const reg=await p.getRegistry();if(!reg.ok)throw new Error(JSON.stringify(reg));
    const model=reg.value.models.find(m=>m.providerModelKey===${JSON.stringify(modelKey)});if(!model)throw new Error(JSON.stringify(reg));
    const enabled=await p.setModelEnabled(model.modelId,true);if(!enabled.ok)throw new Error(JSON.stringify(enabled));
    if(${useGlm&&scenario!=='unavailable'}){const r=await p.getRegistry();const m=r.value.models.find(m=>m.modelId===model.modelId);const n=await p.setNativeSearch({modelId:m.modelId,expectedRevision:m.revision,protocol:'glm_web_search',enabled:true,evidenceUrl:'https://docs.bigmodel.cn/cn/guide/tools/web-search'});if(!n.ok)throw new Error(JSON.stringify(n));}return true;
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
  const prompt=scenario==='explicit'?(usePpt?'联网查询公开资料，制作3页太阳系科普PPT':'联网查询公开新闻'):
    scenario==='offline'?'制作3页太阳系科普PPT':'制作3页新能源汽车最新政策和市场数据PPT';
  await send(prompt);
  if(scenario!=='offline'){
    for(let i=0;i<100;i++){
      const page=await win.webContents.executeJavaScript('document.body.innerText');
      if(scenario==='unavailable'?/没有发起搜索|未发起搜索|尚无可用|未配置.*搜索/u.test(page):/是否允许本次联网/u.test(page))break;
      await pause(100);
    }
    const before=await win.webContents.executeJavaScript('document.body.innerText');
    assert.equal(chatRequests.length,0,'Fresh information must be gated before any model call');
    assert.ok(!before.includes('.pptx'),'No document may be published before search authorization is resolved');
    if(scenario==='unavailable'){
      assert.match(before,/没有发起搜索|未发起搜索|尚无可用|未配置.*搜索/u);
    }else{
      assert.match(before,/是否允许本次联网/u);
      await send(scenario==='declined'?'不要联网':'允许本次联网');
    }
  }
  let sawLiveSources=false;
  if(expectsSearch&&useGlm){
    for(let i=0;i<25;i++){
      const visible=await win.webContents.executeJavaScript(`(()=>{
        const source=[...document.querySelectorAll('.uc-chat-page__message-content p')].find(e=>e.textContent.includes('已收到服务商返回的 1 条结构化搜索来源'));
        const region=document.querySelector('.uc-chat-page__messages')?.getBoundingClientRect();
        const composer=document.querySelector('.uc-chat-page__composer')?.getBoundingClientRect();
        const rect=source?.getBoundingClientRect();
        return Boolean(rect&&region&&composer&&rect.top>=region.top&&rect.bottom<=composer.top&&!document.body.innerText.includes('已收到服务商的搜索执行记录'));
      })()`);
      if(visible){sawLiveSources=true;break;}
      await pause(100);
    }
    if(!sawLiveSources){
      console.log('Live source geometry:',JSON.stringify(await win.webContents.executeJavaScript(`(()=>{
        const region=document.querySelector('.uc-chat-page__messages');
        return {texts:[...document.querySelectorAll('.uc-chat-page__message-content')].map(e=>({text:e.innerText,rect:e.getBoundingClientRect().toJSON()})),region:region?.getBoundingClientRect().toJSON(),scroll:region&&{top:region.scrollTop,height:region.scrollHeight,client:region.clientHeight},layout:['.uc-chat-page__messages-inner','.uc-chat-page__message-list'].map(s=>{const e=document.querySelector(s);const c=getComputedStyle(e);return {selector:s,rect:e.getBoundingClientRect().toJSON(),height:c.height,minHeight:c.minHeight,padding:c.padding,boxSizing:c.boxSizing};}),composer:document.querySelector('.uc-chat-page__composer')?.getBoundingClientRect().toJSON()};
      })()`)));
    }
    assert.ok(sawLiveSources,'Structured sources must be visible while the response is still streaming');
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(runRoot,'live-search-sources.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  }
  if(scenario!=='unavailable'){
    for(let i=0;i<120;i++){if(await win.webContents.executeJavaScript(`document.body.textContent.includes(${JSON.stringify(usePpt?outputTitle:'公开新闻检索已完成（合成协议验收）')})`))break;await pause(100);}
    if(expectsDocument){for(let i=0;i<250;i++){if(await win.webContents.executeJavaScript('document.body.textContent.includes(".pptx")'))break;await pause(100);}}
  }
  const after=await win.webContents.executeJavaScript('document.body.innerText');
  if(scenario!=='unavailable')assert.ok(after.includes(usePpt?outputTitle:'公开新闻检索已完成（合成协议验收）'),after);
  if(expectsSearch)assert.ok(after.includes('已收到服务商的搜索执行记录'),after);
  else if(expectsDocument)assert.match(after,/未联网|没有联网|不联网/u,'Offline document creation must visibly disclose that no web search was used');
  const expectedRequests=expectsSearch?(useGlm?1:2):expectsDocument?1:0;
  assert.equal(chatRequests.length,expectedRequests);assert.equal(networkRequests,0);
  if(expectsSearch)assert.equal(chatRequests[0].messages.filter(m=>m.role==='user').length,1);
  assert.ok(!JSON.stringify(chatRequests).includes('允许本次联网'));
  if(expectsDocument){
    assert.ok(after.includes('.pptx'),after);
    const list=await fs.readdir(path.join(runRoot,'project/files/documents'));
    const files=list.filter(f=>f.endsWith('.pptx'));assert.equal(files.length,1);
    const zip=await require('jszip').loadAsync(await fs.readFile(path.join(runRoot,'project/files/documents',files[0])));
    const slides=Object.keys(zip.files).filter(f=>/^ppt\/slides\/slide\d+\.xml$/.test(f));assert.equal(slides.length,3);
    const saved=await win.webContents.executeJavaScript(`(async()=>{const l=await window.unicomp.chatContexts.listConversations(true,false);const c=await window.unicomp.chatContexts.getConversation(l.value[0].conversationId);return c.value.messages.some(m=>m.documentResult?.workId);})()`);
    assert.equal(saved,true);
  }
  const ledger=await fs.readFile(path.join(runRoot,'project/entities/conversation-native-search.json'),'utf8')
    .then(value=>JSON.parse(value)).catch(error=>{if(error.code==='ENOENT')return {sessions:[]};throw error;});
  if(expectsSearch)assert.equal(ledger.sessions.at(-1).evidence.status,'completed');
  else{
    assert.ok(ledger.sessions.every(entry=>entry.status!=='submitted'&&!entry.evidence),'Offline or unavailable work must not record search execution');
    assert.ok(!after.includes('已收到服务商的搜索执行记录'),'Offline work must not claim search completion');
  }
  const stored=await win.webContents.executeJavaScript(`(async()=>{const l=await window.unicomp.chatContexts.listConversations(true,false);if(!l.ok)throw new Error(JSON.stringify(l));const c=await window.unicomp.chatContexts.getConversation(l.value[0].conversationId);if(!c.ok)throw new Error(JSON.stringify(c));return c.value.messages;})()`);
  if(expectsSearch)assert.ok(stored.some(message=>message.workflowReply?.workflowId.endsWith('-request-started')&&message.content.includes('正在等待服务商返回搜索记录')));
  if(!expectsSearch&&expectsDocument){
    assert.ok(stored.some(message=>message.role==='assistant'&&/未联网|没有联网|不联网/u.test(message.content)),'The offline notice must be a persisted assistant message');
  }
  if(scenario==='unavailable')assert.ok(stored.every(message=>!message.documentResult?.workId),'Unavailable search must not publish a Work');
  const artifactName='native-search-'+(useGlm?'glm':'kimi')+(usePpt?'-ppt':'')+(scenario==='explicit'?'':'-'+scenario);
  win.setSize(1400,900);await pause(200);
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(runRoot,artifactName+'-production.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  await fs.writeFile(path.join(runRoot,artifactName+'-production-result.json'),JSON.stringify({passed:true,scenario,mockedModelRequests:chatRequests.length,mockedSearchRequests:expectsSearch?chatRequests.length:0,realNetworkRequests:networkRequests,scope:'synthetic current task only',protocol:expectsSearch?(useGlm?'glm_web_search':'kimi_builtin'):null,document:expectsDocument?'ppt':null,evidence:ledger.sessions.at(-1)?.evidence??null},null,2));
  console.log('Production renderer -> preload -> IPC -> workflow -> JSON persistence: passed');
  clearTimeout(deadline);app.quit();
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
