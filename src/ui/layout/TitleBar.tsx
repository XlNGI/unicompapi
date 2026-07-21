import { ThemeSwitch } from '../../components/ThemeSwitch';
import { WindowControls } from './WindowControls';

export function TitleBar() {
  const platform = window.unicomp?.platform;
  const isMac = platform === 'darwin';

  return (
    <header className={isMac ? 'title-bar title-bar--mac' : 'title-bar'}>
      <div className="title-bar__brand">
        <div
          className="title-bar__brand-mark"
          aria-label="UniComp 品牌标识占位"
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
