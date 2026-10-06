import type { PlatformServices } from './contracts.js';
import { validateBackupName, validateBackupSize, validateExternalUrl, validateRoute } from './validation.js';
/** The native modules are evaluated only after desktop platform selection. */
export function createDesktopPlatform(): PlatformServices {
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => (await import('@tauri-apps/api/core')).invoke<T>(command, args);
  return {
    kind: 'macos', storageLabel: '本机',
    async readBackupFile() {
      const text = await invoke<string | null>('read_backup_file');
      if (text !== null) validateBackupSize(new TextEncoder().encode(text).byteLength);
      return text;
    },
    async saveBackupFile(name, json) {
      validateBackupName(name); validateBackupSize(new TextEncoder().encode(json).byteLength);
      return invoke<'saved' | 'cancelled'>('save_backup_file', { name, json });
    },
    async openExternal(url) { await invoke('open_external', { url: validateExternalUrl(url) }); },
    getAppVersion() { return invoke<string>('get_app_version'); },
    async loadLastRoute() { const route = await invoke<string | null>('load_last_route'); if (route !== null) validateRoute(route); return route; },
    async saveLastRoute(route) { validateRoute(route); await invoke('save_last_route', { route }); },
    async subscribeWindowAction(listener) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<unknown>('window-action-requested', ({ payload }) => { if (payload === 'close' || payload === 'quit') listener(payload); });
    },
    async subscribeSettingsNavigation(listener) {
      const { listen } = await import('@tauri-apps/api/event'); return listen('navigate-settings', () => listener());
    },
    async subscribeMenuAction(listener) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<unknown>('menu-action', ({ payload }) => { if (payload === 'new' || payload === 'backup' || payload === 'restore' || payload === 'find') listener(payload); });
    },
    async finishWindowAction(action) { await invoke('finish_window_action', { action }); },
  };
}
