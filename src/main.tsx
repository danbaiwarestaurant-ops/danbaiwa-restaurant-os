import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import './index.css';

/**
 * Never auto-reload a POS mid-transaction — surface a small dismissable banner and
 * let the cashier accept the update when idle instead of forcing a reload.
 */
function showUpdateBanner(message: string, onAccept: () => void): void {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;' +
    'justify-content:center;gap:12px;padding:10px 16px;background:#0f172a;color:#f8fafc;' +
    'font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,system-ui,sans-serif;';

  const text = document.createElement('span');
  text.textContent = message;

  const button = document.createElement('button');
  button.textContent = 'Reload';
  button.style.cssText =
    'background:#f59e0b;color:#0f172a;border:none;padding:6px 14px;font-weight:600;cursor:pointer;';
  button.onclick = onAccept;

  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.style.cssText = 'background:transparent;color:#f8fafc;border:1px solid #f8fafc;padding:6px 14px;cursor:pointer;';
  dismiss.onclick = () => bar.remove();

  bar.append(text, button, dismiss);
  document.body.appendChild(bar);
}

const updateSW = registerSW({
  onNeedRefresh() {
    showUpdateBanner('A new version of Ticket POS is ready.', () => updateSW(true));
  },
  onOfflineReady() {
    console.info('[PWA] Ticket POS is ready to work offline.');
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
