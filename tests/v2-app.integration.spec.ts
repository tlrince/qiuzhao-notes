import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const TEST_SEASON = 'E2E 2026 秋招';
const TEST_COMPANY = 'E2E 示例公司';
const TEST_ROLE = '质量保障工程师';

test('empty v1 browser database migrates on cold start and v2 data is shared across routes', async ({ page }) => {
  // Give the test page the app's origin without loading the app bundle. This lets us
  // clear only this ephemeral Playwright context before the first application boot.
  await page.route('**/__pw-cleanup', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Playwright storage cleanup</title></head><body>isolated test context</body></html>',
  }));
  await page.goto('/__pw-cleanup');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('autumn-notes-v1');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not clear test IndexedDB'));
    request.onblocked = () => reject(new Error('Test IndexedDB deletion was blocked'));
  }));
  await page.unroute('**/__pw-cleanup');

  // First route load must perform the empty v1 -> v2 initialization before mounting.
  await page.goto('/analytics');
  await expect(page.getByRole('heading', { name: '从数据里，找到方向。' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const initialDatabase = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('autumn-notes-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not inspect test IndexedDB'));
    });
    try {
      const state = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('meta', 'readonly').objectStore('meta').get('state');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Could not read v2 metadata'));
      });
      return { version: database.version, state };
    } finally {
      database.close();
    }
  });
  expect(initialDatabase.version).toBe(2);
  expect(initialDatabase.state).toMatchObject({ schemaVersion: 2, physicalVersion: 2 });

  await page.getByRole('link', { name: '数据与设置' }).click();
  await expect(page.getByRole('heading', { name: '管理你的工作空间。' })).toBeVisible();
  await page.getByLabel('名称').fill(TEST_SEASON);
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-12-31');
  await page.getByLabel('投递目标').fill('12');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();
  const desktopSeasonPicker = page.locator('#season-desktop');
  await expect(desktopSeasonPicker).toHaveValue(/.+/);
  await expect(desktopSeasonPicker.locator('option:checked')).toHaveText(TEST_SEASON);

  await page.getByRole('link', { name: '投递管理' }).click();
  await expect(page.getByRole('heading', { name: '投递记录' })).toBeVisible();
  await page.getByRole('button', { name: /新增投递/ }).first().click();
  const createDialog = page.getByRole('dialog', { name: '新增投递' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('公司').fill(TEST_COMPANY);
  await createDialog.getByLabel('岗位 *', { exact: true }).fill(TEST_ROLE);
  await createDialog.getByLabel('当前状态').selectOption('draft');
  await createDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(`已添加「${TEST_COMPANY} · ${TEST_ROLE}」`)).toBeVisible();
  const applicationRow = page.getByRole('row', { name: new RegExp(`${TEST_COMPANY}.*${TEST_ROLE}`) });
  await expect(applicationRow).toContainText('待投递');
  await expect(applicationRow).toContainText('空进度');

  await page.getByRole('link', { name: '进度看板' }).click();
  await expect(page.getByRole('heading', { name: '每一段经历，都有迹可循。' })).toBeVisible();
  await expect(page.locator('.sheet__co').getByText(TEST_COMPANY)).toBeVisible();
  const submittedStat = page.locator('.board-stat').filter({ hasText: '总投递' });
  await expect(submittedStat).toContainText('0', { useInnerText: true });
  const statusSelect = page.getByRole('combobox', { name: new RegExp(`修改${TEST_COMPANY}的状态，当前待投递`) });
  await expect(statusSelect).toBeVisible();
  await statusSelect.selectOption({ label: '筛选中' });
  const submissionConfirm = page.getByRole('dialog', { name: '这条还没有投递记录' });
  await submissionConfirm.getByRole('button', { name: '记录投递并更新状态' }).click();
  await expect(page.locator('.toast').filter({ hasText: '状态已更新为「筛选中」' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: new RegExp(`修改${TEST_COMPANY}的状态，当前筛选中`) })).toHaveValue('screening');
  await expect(page.getByText('已保存到此浏览器', { exact: true })).toBeVisible();
  await expect(submittedStat).toContainText('1', { useInnerText: true });

  await page.getByRole('link', { name: '深度分析' }).click();
  await expect(page.getByText('数据洞察 · 共 1 条记录，其中 1 条已投递', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '数据总览' }).click();
  await expect(page.getByRole('heading', { name: /每一步，都算数/ })).toBeVisible();
  await expect(page.getByText(TEST_COMPANY)).toBeVisible();

  // The same data should survive a browser reload and a fresh route mount.
  await page.reload();
  await expect(page.getByText(TEST_COMPANY)).toBeVisible();
  await page.goto('/board');
  await expect(page.getByRole('combobox', { name: new RegExp(`修改${TEST_COMPANY}的状态`) })).toHaveValue('screening');
});

test('M8 settings exports a complete v2 backup, previews it, and atomically restores it after confirmation', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('M8 备份招聘季 A');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^秋招看板备份_\d{4}-\d{2}-\d{2}\.json$/);
  const exportedText = await readFile(await download.path(), 'utf8');
  const envelope = JSON.parse(exportedText) as { format: string; schemaVersion: number; data: { seasons: unknown[]; applications: unknown[]; progressRecords: unknown[] } };
  expect(envelope).toMatchObject({ format: 'autumn-applications', schemaVersion: 2 });
  expect(envelope.data.seasons).toHaveLength(1);
  expect(envelope.data.applications).toHaveLength(0);
  expect(envelope.data.progressRecords).toHaveLength(0);

  await page.getByLabel('名称').fill('M8 备份招聘季 B');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('M8 备份招聘季 B · 当前')).toBeVisible();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择备份并预览' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: download.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(exportedText) });
  await expect(page.getByRole('heading', { name: '备份预览' })).toBeVisible();
  await expect(page.locator('.restore-preview')).toContainText('来源版本 v2');
  await expect(page.locator('.restore-preview')).toContainText('1 个招聘季 · 0 条投递');

  await page.getByRole('button', { name: '确认整体恢复' }).click();
  const confirm = page.getByRole('dialog', { name: '整体替换当前工作空间？' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '整体恢复' }).click();
  await expect(page.getByText('已从 v2 备份恢复 1 个招聘季、0 条投递。')).toBeVisible();
  await expect(page.getByText('M8 备份招聘季 A · 当前')).toBeVisible();
  await expect(page.locator('.settings-grid .overview-list').getByText('M8 备份招聘季 B')).toHaveCount(0);

  const recoveryList = page.locator('.recovery-list');
  const recoveryCapacity = page.getByTestId('recovery-capacity');
  await expect(recoveryList).toContainText('M8 备份招聘季 A、M8 备份招聘季 B · v2');
  await recoveryList.getByRole('button', { name: '预览并恢复' }).click();
  await expect(page.getByRole('heading', { name: '恢复副本预览' })).toBeVisible();
  const recoveryConfirm = page.getByRole('dialog', { name: '用这个恢复副本替换当前数据？' });
  await expect(recoveryConfirm).toBeVisible();
  await expect(recoveryConfirm).toContainText('当前快照会在同一事务中另存为一个新副本');
  await recoveryConfirm.getByRole('button', { name: '恢复此副本' }).click();
  await expect(page.getByText(/已恢复「M8 备份招聘季 A、M8 备份招聘季 B」的 v2 恢复副本/)).toBeVisible();
  await expect(page.getByText('M8 备份招聘季 B · 当前')).toBeVisible();
  await expect(page.locator('.settings-grid .overview-list')).toContainText('M8 备份招聘季 A');
  await expect(recoveryList).toContainText('M8 备份招聘季 A · v2');
  await expect(recoveryCapacity).toContainText('恢复副本 2 份');
  await expect(recoveryCapacity).toContainText('不等于 IndexedDB 或 SQLite 的实际磁盘占用');

  const selectedCopy = recoveryList.getByRole('listitem').filter({ hasText: 'M8 备份招聘季 A、M8 备份招聘季 B' });
  await expect(selectedCopy).toContainText('M8 备份招聘季 A、M8 备份招聘季 B');
  await expect(selectedCopy).toContainText('JSON UTF-8 序列化估算：');
  await selectedCopy.getByRole('button', { name: '删除此副本…' }).click();
  const deleteConfirm = page.getByRole('dialog', { name: '永久删除这份恢复副本？' });
  await expect(deleteConfirm).toContainText('restore-v2-3');
  await expect(deleteConfirm).toContainText('当前数据和其他恢复副本不受影响');
  await deleteConfirm.getByRole('button', { name: '保留此副本' }).click();
  await expect(selectedCopy).toBeVisible();

  const capacityBeforeDelete = await recoveryCapacity.textContent();
  await selectedCopy.getByRole('button', { name: '删除此副本…' }).click();
  await deleteConfirm.getByRole('button', { name: '永久删除此副本' }).click();
  await expect(page.getByText(/已删除恢复副本「M8 备份招聘季 A、M8 备份招聘季 B」/)).toBeVisible();
  await expect(selectedCopy).toHaveCount(0);
  await expect(recoveryCapacity).toContainText('恢复副本 1 份');
  expect(await recoveryCapacity.textContent()).not.toBe(capacityBeforeDelete);
  await expect(recoveryList).toContainText('M8 备份招聘季 A · v2');
  await expect(page.getByText('M8 备份招聘季 B · 当前')).toBeVisible();
  await page.reload();
  await expect(page.getByText('M8 备份招聘季 B · 当前')).toBeVisible();
  await expect(page.locator('.recovery-list').getByRole('listitem')).toHaveCount(1);
  await expect(page.locator('.recovery-list')).not.toContainText('M8 备份招聘季 A、M8 备份招聘季 B');
});

test('M3 raw JSON import syncs without deleting, and can still replace only the selected season', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('M3 原始导入招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();

  await page.goto('/applications');
  await page.getByRole('button', { name: /新增投递/ }).first().click();
  const createDialog = page.getByRole('dialog', { name: '新增投递' });
  await createDialog.getByLabel('公司').fill('应被替换的旧记录');
  await createDialog.getByLabel('岗位 *', { exact: true }).fill('测试岗位');
  await createDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已添加「应被替换的旧记录 · 测试岗位」')).toBeVisible();

  const rows = [
    { id: 'raw-screening', company: '导入筛选公司', position: '后端工程师', location: '上海', channel: '官网', link: 'https://jobs.example.com/a', applyDate: '2026-09-01', status: '筛选中', createdAt: '2026-09-01T09:00:00+08:00', updatedAt: '2026-09-04T10:00:00+08:00', statusUpdatedAt: '2026-09-04T10:00:00+08:00' },
    { id: 'raw-failed', company: '导入挂掉公司', position: '产品经理', location: '杭州', channel: '官网', link: 'https://jobs.example.com/b', applyDate: '2026-09-02', status: '挂掉', createdAt: '2026-09-02T09:00:00+08:00', updatedAt: '2026-09-05T10:00:00+08:00', statusUpdatedAt: '2026-09-05T10:00:00+08:00' },
    { id: 'raw-draft', company: '导入待投递公司', position: '设计师', location: '北京', channel: '官网', link: '', applyDate: '2026-09-03', status: '待投递', createdAt: '2026-09-03T09:00:00+08:00', updatedAt: '2026-09-03T09:00:00+08:00', statusUpdatedAt: '2026-09-03T09:00:00+08:00' },
  ];
  const importFile = async (records: unknown[]) => {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入原始 JSON' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: '秋招投递记录.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(records)) });
    return page.getByRole('region', { name: '原始 JSON 导入预览' });
  };
  let preview = await importFile(rows);
  await expect(preview).toContainText('文件共有 3 条。按「同步」处理：新增 3 条，更新状态 0 条');
  await preview.getByRole('button', { name: '确认同步' }).click();
  await page.getByRole('dialog', { name: '同步这个文件？' }).getByRole('button', { name: '确认同步' }).click();
  await expect(page.getByText(/已同步：新增 3 条，更新 0 条状态，跳过 0 条/)).toBeVisible();
  await expect(page.getByText('应被替换的旧记录')).toBeVisible();
  await expect(page.getByRole('row', { name: /导入筛选公司.*后端工程师/ })).toContainText('筛选中');

  const later = rows.map(row => row.id === 'raw-screening' ? { ...row, status: '挂掉', updatedAt: '2026-09-20T10:00:00+08:00', statusUpdatedAt: '2026-09-20T10:00:00+08:00' } : row);
  preview = await importFile(later);
  await expect(preview).toContainText('新增 0 条，更新状态 1 条');
  await expect(preview).toContainText('导入筛选公司 · 后端工程师：筛选中 → 挂掉');
  await preview.getByRole('button', { name: '确认同步' }).click();
  await page.getByRole('dialog', { name: '同步这个文件？' }).getByRole('button', { name: '确认同步' }).click();
  await expect(page.getByRole('row', { name: /导入筛选公司.*后端工程师/ })).toContainText('挂掉（环节未知）');

  preview = await importFile(rows);
  await preview.getByText('改为整体替换这个招聘季…').click();
  await expect(preview.getByText('筛选中', { exact: true })).toBeVisible();
  await expect(preview.getByText('挂掉', { exact: true })).toBeVisible();
  await expect(preview.getByText('待投递', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '确认替换并导入 3 条' }).click();
  const confirm = page.getByRole('dialog', { name: '替换这个招聘季的全部记录？' });
  await confirm.getByRole('button', { name: '替换并导入' }).click();
  await expect(page.getByText('已导入 3 条记录到「M3 原始导入招聘季」；替换前的 4 条记录已保留为恢复副本。')).toBeVisible();
  await expect(page.getByText('应被替换的旧记录')).toHaveCount(0);
  const screeningRow = page.getByRole('row', { name: /导入筛选公司.*后端工程师/ });
  const failedRow = page.getByRole('row', { name: /导入挂掉公司.*产品经理/ });
  const draftRow = page.getByRole('row', { name: /导入待投递公司.*设计师/ });
  await expect(screeningRow).toBeVisible();
  await expect(screeningRow).toContainText('筛选中');
  await expect(failedRow).toBeVisible();
  await expect(failedRow).toContainText('挂掉（环节未知）');
  await expect(draftRow).toBeVisible();
  await expect(draftRow).toContainText('待投递');
  await expect(draftRow).toContainText('空进度');

  await page.reload();
  await expect(page.getByRole('row', { name: /导入筛选公司.*后端工程师/ })).toContainText('筛选中');
  await expect(page.getByRole('row', { name: /导入挂掉公司.*产品经理/ })).toContainText('挂掉（环节未知）');
});
