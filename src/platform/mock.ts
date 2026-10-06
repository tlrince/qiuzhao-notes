import type { AvailableUpdate, BackupSaveResult, MenuAction, PlatformKind, PlatformServices, WindowAction } from './contracts.js';
import { validateBackupName, validateBackupSize, validateExternalUrl, validateRoute } from './validation.js';
export function createMockPlatform(options: { kind?: PlatformKind; file?: string | null; saveResult?: BackupSaveResult; version?: string; update?: AvailableUpdate | null } = {}) {
  const kind = options.kind ?? 'web';
  const savedFiles: { name: string; json: string }[] = [], externalUrls: string[] = [], finishedActions: WindowAction[] = [], installedUpdates: string[] = [];
  const windowListeners = new Set<(action: WindowAction) => void>(), navigationListeners = new Set<() => void>(), menuListeners = new Set<(action: MenuAction) => void>();
  let route: string | null = null;
  const services: PlatformServices = {
    kind, storageLabel: kind === 'macos' ? '本机' : '此浏览器',
    async readBackupFile() { const file = options.file ?? null; if (file !== null) validateBackupSize(new TextEncoder().encode(file).byteLength); return file; },
    async saveBackupFile(name, json) {
      validateBackupName(name); validateBackupSize(new TextEncoder().encode(json).byteLength);
      const result = options.saveResult ?? (kind === 'macos' ? 'saved' : 'requested');
      if (result !== 'cancelled') savedFiles.push({ name, json }); return result;
    },
    async openExternal(value) { externalUrls.push(validateExternalUrl(value)); },
    async getAppVersion() { return options.version ?? '0.0.0'; },
    async loadLastRoute() { return route; }, async saveLastRoute(value) { validateRoute(value); route = value; },
    async subscribeWindowAction(listener) { windowListeners.add(listener); return () => { windowListeners.delete(listener); }; },
    async subscribeSettingsNavigation(listener) { navigationListeners.add(listener); return () => { navigationListeners.delete(listener); }; },
    async subscribeMenuAction(listener) { menuListeners.add(listener); return () => { menuListeners.delete(listener); }; },
    async finishWindowAction(action) { finishedActions.push(action); },
    async checkForUpdate() { return options.update ?? null; },
    async installUpdate() { if (!options.update) throw new Error('已经是最新版本'); installedUpdates.push(options.update.version); },
  };
  return Object.assign(services, { savedFiles, externalUrls, finishedActions, installedUpdates,
    emitWindowAction(action: WindowAction) { windowListeners.forEach(listener => listener(action)); },
    emitSettingsNavigation() { navigationListeners.forEach(listener => listener()); },
    emitMenuAction(action: MenuAction) { menuListeners.forEach(listener => listener(action)); },
  });
}
