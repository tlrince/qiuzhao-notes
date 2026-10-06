import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import type { PlatformServices } from '../platform/index.js';
import { App } from './App.js';
import { PlatformProvider } from './PlatformContext.js';
import { PlatformLifecycle } from './PlatformLifecycle.js';
import { V2DataProvider } from './V2DataContext.js';
import type { SnapshotStoreV2 } from '../repositories/storage-v2-contract.js';

export function renderApp(platform: PlatformServices) {
  const Router = platform.kind === 'macos' ? HashRouter : BrowserRouter;
  const storePromise: Promise<SnapshotStoreV2> = platform.kind === 'macos'
    ? import('../repositories/desktop/sqlite-v2.js').then(({ createDesktopSnapshotStoreV2 }) => createDesktopSnapshotStoreV2())
    : import('../repositories/web/indexeddb-v2.js').then(({ createIndexedDbSnapshotStoreV2 }) => createIndexedDbSnapshotStoreV2({ channelName: 'autumn-applications-v2' }));
  void storePromise.then(async store => {
    // Complete and validate v1 → v2 migration before mounting any business route.
    const initial = await store.read();
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode><PlatformProvider platform={platform}><V2DataProvider store={store} initial={initial}><Router><PlatformLifecycle /><App /></Router></V2DataProvider></PlatformProvider></React.StrictMode>,
    );
  }).catch(error => {
    const root = document.getElementById('root')!;
    const message = document.createElement('p'); message.setAttribute('role', 'alert');
    message.textContent = `数据层启动失败：${error instanceof Error ? error.message : String(error)}。请检查本地存储权限后重试。`;
    root.replaceChildren(message);
  });
}
