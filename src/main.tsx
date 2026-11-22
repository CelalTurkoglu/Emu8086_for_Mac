import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import { isElectron } from './platform';
import './index.css';

// Register offline PWA service worker when running as a deployed web application
if (
  typeof window !== 'undefined' &&
  !isElectron() &&
  'serviceWorker' in navigator &&
  import.meta.env.PROD
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // ignore service worker registration errors on restricted origins
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider defaultLocale="tr">
      <App />
    </I18nProvider>
  </React.StrictMode>
);
