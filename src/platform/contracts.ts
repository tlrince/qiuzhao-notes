export type PlatformKind = 'web' | 'macos';
export type BackupSaveResult = 'saved' | 'requested' | 'cancelled';
export type WindowAction = 'close' | 'quit';
export type Unsubscribe = () => void;
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
  finishWindowAction(action: WindowAction): Promise<void>;
}
