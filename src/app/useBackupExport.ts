import { useCallback, useState } from 'react';
import { localBusinessDate } from '../features/applications/progress-status-editor.js';
import { usePlatform } from './PlatformContext.js';
import { useV2Data } from './V2DataContext.js';

/** Exports the complete v2 backup through the platform file service and returns a status message. */
export function useBackupExport() {
  const { backupCommands, recordBackupAt } = useV2Data();
  const { platform } = usePlatform();
  const [busy, setBusy] = useState(false);
  const exportBackup = useCallback(async (): Promise<string> => {
    setBusy(true);
    try {
      const backup = await backupCommands.exportAll(new Date().toISOString());
      const result = await platform.saveBackupFile(`秋招看板备份_${localBusinessDate()}.json`, JSON.stringify(backup, null, 2));
      if (result === 'cancelled') return '已取消导出，没有生成备份文件。';
      try {
        // The envelope time identifies the export; lastBackupAt records when
        // the native save completed or the browser download request was issued.
        await recordBackupAt(new Date().toISOString());
        return result === 'saved' ? '完整备份已保存到所选位置。' : '完整备份下载已发起；浏览器不会自动确认文件是否已写入磁盘。';
      } catch (cause) {
        return `备份文件已${result === 'saved' ? '保存' : '发起下载'}，但最近备份时间未能更新：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    } finally {
      setBusy(false);
    }
  }, [backupCommands, platform, recordBackupAt]);
  return { exportBackup, busy };
}
