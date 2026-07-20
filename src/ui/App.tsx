const navigationItems = [
  '对话',
  '项目',
  '图片创作',
  '视频创作',
  '任务中心',
  '作品库',
  '模型与服务商',
  '本地设置'
];

export function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">U</div>
          <div>
            <div className="brand-title">UniComp</div>
            <div className="brand-subtitle">AI Creative Desktop</div>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {navigationItems.map((item, index) => (
            <button className={index === 0 ? 'nav-item active' : 'nav-item'} key={item}>
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">阶段 1 骨架</p>
            <h1>对话</h1>
          </div>
          <div className="status-pill">Electron · React · TypeScript</div>
        </header>

        <section className="hero-panel">
          <div>
            <p className="eyebrow">工程基线已建立</p>
            <h2>下一步对齐权威设计图，落地桌面壳与 Design Tokens。</h2>
            <p>
              当前页面是最小可运行骨架，保留 V1.2.1 冻结的八项一级导航。
              后续逐页接入项目、任务、作品、模型服务商和本地设置能力。
            </p>
          </div>
          <div className="platform-card">
            <span>运行平台</span>
            <strong>{window.unicomp?.platform ?? 'browser'}</strong>
          </div>
        </section>
      </section>
    </main>
  );
}
