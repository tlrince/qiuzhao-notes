export type PlatformKind = 'web' | 'macos';
export type BackupSaveResult = 'saved' | 'requested' | 'cancelled';
export type WindowAction = 'close' | 'quit';
/** Native menu commands forwarded to the web view. */
export type MenuAction = 'new' | 'backup' | 'restore' | 'find';
export type Unsubscribe = () => void;
export interface AvailableUpdate { version: string; notes: string | null }
export interface PlatformServices {
  readonly kind: PlatformKind;
  readonly storageLabel: string;
  readBackupFile(): Promise<string | null>;
  saveBackupFile(name: string, json: string): Promise<BackupSaveResult>;
  openExternal(url: string): Promise<void>;
  getAppVersion(): Promise<string>;
  loadLastRoute(): Promise<string | null>;
  saveLastRoute(route: string): Promise<void>;
  subscribeWindowAction(listener: (action: WindowAction) => void): Promise<Unsubscribe>;
  subscribeSettingsNavigation(listener: () => void): Promise<Unsubscribe>;
  subscribeMenuAction(listener: (action: MenuAction) => void): Promise<Unsubscribe>;
  finishWindowAction(action: WindowAction): Promise<void>;
  /** Mac only: a newer signed release, or null when up to date (always null on the web). */
  checkForUpdate(): Promise<AvailableUpdate | null>;
  /** Mac only: download, install and restart into the newer release. */
  installUpdate(): Promise<void>;
}
