import type { PlatformKind, PlatformServices } from './contracts.js';
import { createWebPlatform } from './web.js';
export * from './contracts.js';
export { createWebPlatform } from './web.js';
export { createDesktopPlatform } from './desktop.js';
export { createMockPlatform } from './mock.js';
export async function loadPlatform(kind: PlatformKind, options: { version?: string } = {}): Promise<PlatformServices> {
  if (kind === 'web') return createWebPlatform(options);
  const { createDesktopPlatform } = await import('./desktop.js');
  return createDesktopPlatform();
}
