import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from './theme/ThemeProvider';
import { RSuiteThemeBridge } from './theme/RSuiteThemeBridge';
import { initializeTheme } from './theme/theme';
import { App } from './ui/App';
import { GlobalNotificationProvider } from './ui/notifications/GlobalNotificationProvider';
import './styles/tokens.css';
import 'rsuite/dist/rsuite-no-reset.min.css';
import './styles/rsuite-bridge.css';
import './styles.css';

initializeTheme();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <RSuiteThemeBridge>
        <GlobalNotificationProvider>
          <App />
        </GlobalNotificationProvider>
      </RSuiteThemeBridge>
    </ThemeProvider>
  </React.StrictMode>
);
