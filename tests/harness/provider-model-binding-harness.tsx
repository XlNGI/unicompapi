// Actual provider page and preload API; the Electron runner owns isolated storage.
import { createRoot } from 'react-dom/client';
import { ProvidersPage } from '../../src/pages/providers/ProvidersPage';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { RSuiteThemeBridge } from '../../src/theme/RSuiteThemeBridge';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles.css';
import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import '../../src/styles/rsuite-bridge.css';

createRoot(document.getElementById('root')!).render(<ThemeProvider><RSuiteThemeBridge><ProvidersPage /></RSuiteThemeBridge></ThemeProvider>);
