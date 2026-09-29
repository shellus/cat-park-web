import { createRoot } from 'react-dom/client';
import './styles.css';
import { installDiagnostics, reportClientError } from './client/diagnostics';
import { installInstallPrompt } from './client/install';

installDiagnostics();
installInstallPrompt();
void import('./App').then(({ default: App }) => createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => reportClientError('react.uncaught', error, info),
  onCaughtError: (error, info) => reportClientError('react.caught', error, info),
  onRecoverableError: (error, info) => reportClientError('react.recoverable', error, info),
}).render(<App />)).catch(error => reportClientError('app.bootstrap', error));
