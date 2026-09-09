interface PageShellProps {
  title: string;
  description: string;
}

export function PageShell({ title, description }: PageShellProps) {
  return (
    <>
      <header className="workspace-header">
        <div>
          <p className="eyebrow">阶段 1 · 页面骨架</p>
          <h1>{title}</h1>
        </div>
        <div className="status-pill">桌面壳已就绪</div>
      </header>

      <section className="hero-panel" aria-labelledby="page-placeholder-title">
        <div>
          <p className="eyebrow">当前页面</p>
          <h2 id="page-placeholder-title">{title}</h2>
          <p>{description}</p>
        </div>
        <div className="platform-card">
          <span>运行平台</span>
          <strong>{window.unicomp?.platform ?? 'browser'}</strong>
        </div>
      </section>
    </>
  );
}
