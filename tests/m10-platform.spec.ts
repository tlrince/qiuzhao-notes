import { expect, test } from '@playwright/test';

test('Web 平台读取用户选择的备份，保留原文且移除临时输入', async ({ page }) => {
  await page.goto('/settings');
  const chooser = page.waitForEvent('filechooser');
  const reading = page.evaluate(async () => {
    const { createWebPlatform } = await import('/src/platform/web.ts');
    return createWebPlatform().readBackupFile();
  });
  await (await chooser).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from('{"name":"秋招"}') });
  expect(await reading).toBe('{"name":"秋招"}');
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});

test('Web 取消选择返回 null，超限文件拒绝读取且清理输入', async ({ page }) => {
  await page.goto('/settings');
  const cancelled = await page.evaluate(async () => {
    const { createWebPlatform } = await import('/src/platform/web.ts');
    const original = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { this.dispatchEvent(new Event('cancel')); };
    try { return await createWebPlatform().readBackupFile(); } finally { HTMLInputElement.prototype.click = original; }
  });
  expect(cancelled).toBeNull();
  const chooser = page.waitForEvent('filechooser');
  const reading = page.evaluate(async () => {
    const { createWebPlatform } = await import('/src/platform/web.ts');
    try { await createWebPlatform().readBackupFile(); return 'unexpected success'; } catch (error) { return (error as Error).message; }
  });
  await (await chooser).setFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(25 * 1024 * 1024 + 1, 32) });
  expect(await reading).toContain('25 MB');
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});

test('Web 保存发起真实下载，只返回 requested，下载文件名正确', async ({ page }) => {
  await page.goto('/settings');
  const download = page.waitForEvent('download');
  const result = await page.evaluate(async () => {
    const { createWebPlatform } = await import('/src/platform/web.ts');
    return createWebPlatform().saveBackupFile('秋招备份.json', '{"test":true}');
  });
  expect(result).toBe('requested');
  const file = await download;
  expect(file.suggestedFilename()).toBe('秋招备份.json');
  expect(await file.failure()).toBeNull();
});
