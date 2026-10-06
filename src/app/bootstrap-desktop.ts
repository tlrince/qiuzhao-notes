import { createDesktopPlatform } from '../platform/desktop.js';
import { renderApp } from './render.js';

export async function start() {
  const platform = createDesktopPlatform();
  const lastRoute = await platform.loadLastRoute();
  if (lastRoute) window.history.replaceState(null, '', `#${lastRoute}`);
  renderApp(platform);
}
