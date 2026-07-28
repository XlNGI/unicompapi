import { ThemeSwitch } from '../../components/ThemeSwitch';
import { WindowControls } from './WindowControls';

export function TitleBar() {
  const platform = window.unicomp?.platform;
  const isMac = platform === 'darwin';

  return (
    <header
      aria-label="应用标题栏"
      className={isMac ? 'title-bar title-bar--mac' : 'title-bar'}
    >
      <div className="title-bar__brand">
        <div
          aria-hidden="true"
          className="title-bar__brand-mark"
          title="正式品牌 Logo 待接入"
        >
          U
        </div>
        <span className="title-bar__brand-name">UniComp AI</span>
      </div>
      <div className="title-bar__drag-region" aria-hidden="true" />
      <div className="title-bar__actions">
        <ThemeSwitch />
        {platform === 'win32' ? <WindowControls /> : null}
      </div>
    </header>
  );
}
