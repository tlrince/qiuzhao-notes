import type { BackupSaveResult, PlatformKind, PlatformServices, WindowAction } from './contracts.js';
import { validateBackupName, validateBackupSize, validateExternalUrl, validateRoute } from './validation.js';
export function createMockPlatform(options: { kind?: PlatformKind; file?: string | null; saveResult?: BackupSaveResult; version?: string } = {}) {
  const kind = options.kind ?? 'web';
  const savedFiles: { name: string; json: string }[] = [], externalUrls: string[] = [], finishedActions: WindowAction[] = [];
  const windowListeners = new Set<(action: WindowAction) => void>(), navigationListeners = new Set<() => void>();
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
    async finishWindowAction(action) { finishedActions.push(action); },
  };
  return Object.assign(services, { savedFiles, externalUrls, finishedActions,
    emitWindowAction(action: WindowAction) { windowListeners.forEach(listener => listener(action)); },
    emitSettingsNavigation() { navigationListeners.forEach(listener => listener()); },
  });
}
