import type { PlatformServices } from './contracts.js';
import { validateBackupName, validateBackupSize, validateExternalUrl } from './validation.js';
export function createWebPlatform(options: { version?: string } = {}): PlatformServices {
  return {
    kind: 'web', storageLabel: '此浏览器',
    readBackupFile() {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
        const cleanup = () => input.remove();
        input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });
        input.addEventListener('change', () => {
          const file = input.files?.[0]; cleanup();
          if (!file) { resolve(null); return; }
          try { validateBackupSize(file.size); } catch (error) { reject(error); return; }
          file.text().then(resolve, reject);
        }, { once: true });
        document.body.append(input);
        try { input.click(); } catch (error) { cleanup(); reject(error); }
      });
    },
    async saveBackupFile(name, json) {
      validateBackupName(name);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' }); validateBackupSize(blob.size);
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = name; anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      return 'requested';
    },
    async openExternal(value) {
      const url = validateExternalUrl(value);
      const anchor = document.createElement('a'); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      document.body.append(anchor); try { anchor.click(); } finally { anchor.remove(); }
    },
    async getAppVersion() { return options.version ?? '0.0.0'; },
    async loadLastRoute() { return null; }, async saveLastRoute() {},
    async subscribeWindowAction() { return () => {}; }, async subscribeSettingsNavigation() { return () => {}; }, async subscribeMenuAction() { return () => {}; },
    async finishWindowAction() {},
    async checkForUpdate() { return null; },
    async installUpdate() { throw new Error('网页版刷新页面即可使用最新版本'); },
  };
}
