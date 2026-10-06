import { useState } from 'react';
import { Button } from '../shared/ui/components.js';
import { usePlatform } from './PlatformContext.js';

/** Explicit developer preview: never reads or imports business records automatically. */
export function PlatformPreview() {
  const { platform } = usePlatform();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<string>) {
    setBusy(true);
    try { setMessage(await action()); }
    catch (cause) { setMessage(`操作失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  }
  return <section className="component-panel" aria-label="平台能力预览">
    <h2>平台能力预览</h2>
    <p className="muted">当前平台：{platform.kind === 'macos' ? 'macOS 桌面应用' : '网页版'}。这里仅检查文件与窗口接口，不会导入或修改投递记录。</p>
    <div className="component-row">
      <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await platform.saveBackupFile('秋招手记_平台测试.json', JSON.stringify({ format: 'platform-preview', message: '文件读写测试，不包含业务数据。' }, null, 2));
        return result === 'saved' ? '测试文件已保存到所选位置' : result === 'requested' ? '已发起测试文件下载，请检查浏览器下载记录' : '已取消保存';
      })}>保存测试文件</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await platform.readBackupFile();
        return result === null ? '已取消选择文件' : `已在本机读取 ${new TextEncoder().encode(result).length} 字节，未导入业务数据`;
      })}>读取测试文件</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void run(async () => `应用版本：${await platform.getAppVersion()}`)}>查看应用版本</Button>
    </div>
    <p className="platform-result" role="status">{message}</p>
  </section>;
}
