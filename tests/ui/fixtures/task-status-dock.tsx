import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CustomProvider } from 'rsuite';
import { TaskStatusDock } from '../../../src/ui/layout/TaskStatusDock';
import { refreshTaskReadStore } from '../../../src/ui/task-read-store';
import { PROJECT_SESSION_CHANGED_EVENT } from '../../../src/ui/project-session-events';
import type { StorageTaskSummaryDto } from '../../../src/shared/storage-ipc';
import '../../../src/styles/tokens.css';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../../src/styles/rsuite-bridge.css';
import '../../../src/styles.css';

let scenario = new URLSearchParams(location.search).get('scenario') ?? 'mixed';
let projectId = 'fixture-project';
const tasks = ['needs_user_action', 'downloading', 'processing', 'completed'].map((state, index): StorageTaskSummaryDto => ({
  taskId: `fixture-${index}`, projectId: 'fixture-project', projectName: '验收示例项目',
  kind: index % 2 ? 'image_generation' : 'video_generation',
  createdAt: new Date().toISOString(), executionCount: 1, latestExecutionState: state,
  latestExecutionUpdatedAt: new Date().toISOString()
}));
Object.defineProperty(window, 'unicomp', { value: { storage: {
  listTasks: async () => {
    if (scenario === 'loading') await new Promise(() => undefined);
    if (scenario === 'error') return { ok: false };
    return { ok: true, value: { items: scenario === 'idle' ? [] : scenario === 'completed' ? [tasks[3]] : tasks,
      issues: scenario === 'issues' ? [{ projectId, projectName: '验收示例项目', reason: 'invalid_data' }] : [] } };
  },
  getProjectSession: async () => ({ ok: true, value: { projectId, projectName: '验收示例项目' } }),
  onLocalStorageChanged: () => () => undefined
} } });

function Fixture() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [message, setMessage] = useState(false);
  const [navigation, setNavigation] = useState('对话');
  return <CustomProvider theme={theme}>
    <div className="app-shell app-shell--compact">
      <header style={{display:'flex',gap:12,padding:8,flexWrap:'wrap'}}>
        <strong>UniComp AI · 独立验收</strong>
        <label>场景 <select aria-label="场景" defaultValue={scenario} onChange={async event => {
          scenario = event.target.value; await refreshTaskReadStore();
        }}><option value="mixed">混合任务</option><option value="completed">仅完成</option><option value="idle">空闲</option><option value="error">读取失败</option><option value="issues">数据不完整</option></select></label>
        <button onClick={() => {const next=theme==='light'?'dark':'light';document.documentElement.dataset.theme=next;setTheme(next);}}>切换主题</button>
        <button onClick={() => setMessage(value => !value)}>页面异常</button>
        <button onClick={() => {projectId=projectId==='fixture-project'?'other-project':'fixture-project';window.dispatchEvent(new Event(PROJECT_SESSION_CHANGED_EVENT));}}>切换项目</button>
      </header>
      <div className="app-body">
        <aside className="sidebar"><strong>当前项目</strong><span>验收示例项目</span></aside>
        <main className="workspace" style={{display:'flex',flexDirection:'column'}}>
          <h2>{navigation}</h2><p>合成数据；此页面渲染生产底栏组件，未接入服务商或用户数据库。</p>
          <div style={{flex:1}} />
          <label>编辑内容<textarea aria-label="编辑内容" defaultValue="保留当前输入，点击底栏展开任务。" style={{display:'block',width:'100%',minHeight:100}} /></label>
        </main>
        <TaskStatusDock fallbackStatus={{label:'项目状态',content:message?'本地保存失败，请保留当前内容并检查项目目录。'.repeat(4):`当前场景：${navigation}`,tone:message?'danger':'neutral',role:message?'alert':'status'}} onNavigate={target => setNavigation(target==='tasks'?'任务中心':'作品库')} />
      </div>
    </div>
  </CustomProvider>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Fixture />);
