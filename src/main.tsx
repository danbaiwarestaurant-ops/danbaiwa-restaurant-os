import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initPwaUpdates } from './services/pwaUpdate';
import './index.css';

// Registers the service worker and starts the update checks. The prompt itself is a
// React component (components/common/UpdateBanner) rather than hand-built DOM, so it
// renders above the app instead of behind whatever the till is showing.
initPwaUpdates();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
