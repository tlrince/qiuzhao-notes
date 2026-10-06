import { expect, test } from '@playwright/test';

const COMPANY = 'R5 历史交互验收';

test('history node details, append, backfill, and correction invoke persisted R1 commands', async ({ page }) => {
  // Playwright creates a fresh, ephemeral browser context for this test. Let the
  // app initialize its own database there; never delete an existing user database.
  await page.goto('/settings');
  await page.getByLabel('名称').fill('R5 独立验收招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();

  await page.goto('/board');
  await page.getByRole('button', { name: '新增投递' }).first().click();
  const createDialog = page.getByRole('dialog', { name: '新增投递' });
  await createDialog.getByLabel('公司').fill(COMPANY);
  await createDialog.getByLabel('岗位 *', { exact: true }).fill('客户端工程师');
  await createDialog.getByLabel('当前状态').selectOption('draft');
  await createDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('combobox', { name: new RegExp(`修改${COMPANY}的状态，当前待投递`) })).toBeVisible();

  await page.getByRole('button', { name: `展开${COMPANY}的进度流程` }).click();
  const flow = page.locator('.sheet__detail');
  await expect(flow.getByRole('heading', { name: `进度流程 · ${COMPANY}` })).toBeVisible();
  await flow.getByRole('button', { name: '记录状态' }).click();
  const drawer = page.locator('dialog.app-drawer[open]');
  await expect(drawer.getByRole('heading', { name: `记录状态 · ${COMPANY}` })).toBeVisible();
  await drawer.locator('select').first().selectOption('screening');
  await drawer.locator('input[type="date"]').fill('2026-09-10');
  await drawer.getByRole('button', { name: '记录状态' }).click();
  await expect(drawer).toHaveCount(0);

  let cards = flow.locator('.progress-history__card');
  await expect(cards).toHaveCount(1);
  await cards.nth(0).click();
  const details = flow.getByRole('complementary', { name: '选中事件详情' });
  await expect(details).toContainText('筛选中');
  await expect(details).toContainText('正常记录');
  await expect(details).toContainText('2026-09-10');
  await cards.nth(0).click();
  await expect(details).toHaveCount(0);

  await flow.getByRole('button', { name: '＋ 记录新进展' }).click();
  await expect(drawer.getByRole('form', { name: '追加进度状态' })).toBeVisible();
  await drawer.locator('select').first().selectOption('written_test_active');
  await drawer.locator('input[type="date"]').fill('2026-09-11');
  await drawer.getByRole('button', { name: '记录状态' }).click();
  await expect(drawer).toHaveCount(0);
  cards = flow.locator('.progress-history__card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toContainText('笔试中');
  const firstCardBounds = await cards.nth(0).boundingBox();
  const secondCardBounds = await cards.nth(1).boundingBox();
  const edgeBounds = await flow.locator('.progress-history__edge').first().boundingBox();
  expect(firstCardBounds).not.toBeNull();
  expect(secondCardBounds).not.toBeNull();
  expect(edgeBounds).not.toBeNull();
  // A horizontal timeline: the arrow sits between the two nodes on one line.
  expect(secondCardBounds!.x).toBeGreaterThan(firstCardBounds!.x + firstCardBounds!.width);
  expect(edgeBounds!.x).toBeGreaterThanOrEqual(firstCardBounds!.x + firstCardBounds!.width - 1);
  expect(edgeBounds!.x + edgeBounds!.width).toBeLessThanOrEqual(secondCardBounds!.x + 1);
  expect(Math.abs(secondCardBounds!.y - firstCardBounds!.y)).toBeLessThan(2);

  await cards.nth(0).click();
  await flow.getByRole('button', { name: '在此之前补录' }).click();
  await expect(drawer.getByRole('form', { name: '在历史节点前补录' })).toBeVisible();
  await expect(drawer.getByRole('form', { name: '在历史节点前补录' })).toContainText('筛选中 · 2026-09-10');
  await drawer.locator('select').first().selectOption('submitted');
  await drawer.locator('input[type="date"]').fill('2026-09-09');
  await drawer.getByRole('button', { name: '保存补录' }).click();
  await expect(drawer).toHaveCount(0);
  cards = flow.locator('.progress-history__card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('已投递');
  await expect(cards.nth(1)).toContainText('筛选中');
  await expect(cards.nth(2)).toContainText('笔试中');
  await cards.nth(0).click();
  await expect(flow.getByRole('complementary', { name: '选中事件详情' })).toContainText('历史补录');
  await expect(flow.getByRole('complementary', { name: '选中事件详情' })).toContainText('补录锚点 ID');

  await flow.getByRole('complementary', { name: '选中事件详情' }).getByRole('button', { name: '纠错' }).click();
  await expect(drawer.getByRole('form', { name: '纠正历史事件' })).toBeVisible();
  await expect(drawer.getByRole('form', { name: '纠正历史事件' })).toContainText('已投递 · 2026-09-09');
  await drawer.locator('select').first().selectOption('pool');
  await drawer.getByRole('button', { name: '保存纠错' }).click();
  await expect(drawer).toHaveCount(0);
  cards = flow.locator('.progress-history__card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('泡池子');
  await expect(cards.nth(1)).toContainText('筛选中');
  await expect(cards.nth(2)).toContainText('笔试中');
  await cards.nth(0).click();
  await expect(flow.getByRole('complementary', { name: '选中事件详情' })).toContainText('纠正来源 ID');
});

test('the sheet records forward progress in one stage as a single visit', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('同一轮验收招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();

  await page.goto('/board');
  await page.getByRole('button', { name: '新增投递' }).first().click();
  const createDialog = page.getByRole('dialog', { name: '新增投递' });
  await createDialog.getByLabel('公司').fill('同一轮公司');
  await createDialog.getByLabel('岗位 *', { exact: true }).fill('后端工程师');
  await createDialog.getByLabel('当前状态').selectOption({ label: '笔试中' });
  await createDialog.getByRole('button', { name: '保存' }).click();
  const status = page.getByRole('combobox', { name: /修改同一轮公司的状态/ });
  await expect(status).toHaveValue('written_test_active');
  // Every status of a stage is offered in the sheet, grouped under the stage.
  await expect(status.locator('optgroup[label="一面"] option')).toHaveText(['待一面', '一面中', '一面待结果', '一面通过', '一面挂']);

  // Record the finer result through the full editor: 笔试中 → 笔试通过 stays one visit.
  await page.getByRole('button', { name: '展开同一轮公司的进度流程' }).click();
  const flow = page.locator('.sheet__detail');
  await flow.getByRole('button', { name: '＋ 记录新进展' }).click();
  const drawer = page.locator('dialog.app-drawer[open]');
  await drawer.locator('select').first().selectOption('written_test_passed');
  await expect(drawer.getByRole('radio', { name: /同一轮的进展/ })).toBeChecked();
  await drawer.getByRole('button', { name: '记录状态' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(flow.locator('.sheet__stage').filter({ hasText: '笔试' })).not.toContainText('共 2 次');
  await expect(flow.locator('.progress-history__meta')).toHaveCount(0);
  await expect(status).toHaveValue('written_test_passed');

  // A mistaken record can be deleted from the timeline; the status falls back to the previous one.
  await flow.getByRole('button', { name: /查看事件：笔试通过/ }).click();
  await flow.getByRole('button', { name: '删除这条' }).click();
  await page.getByRole('dialog', { name: /删除「笔试通过」这条进展/ }).getByRole('button', { name: '删除' }).click();
  await expect(status).toHaveValue('written_test_active');
  await expect(page.locator('.toast').filter({ hasText: '已删除「笔试通过」这条进展' })).toBeVisible();

  // Deleting from the sheet can be undone from the toast without a full recovery copy.
  await page.getByRole('button', { name: '删除同一轮公司 · 后端工程师' }).click();
  await page.getByRole('dialog', { name: '删除这条记录？' }).getByRole('button', { name: '删除' }).click();
  await expect(status).toHaveCount(0);
  const toast = page.locator('.toast').filter({ hasText: '已删除「同一轮公司 · 后端工程师」' });
  await toast.getByRole('button', { name: '撤销' }).click();
  await expect(page.locator('.toast').filter({ hasText: '已恢复「同一轮公司 · 后端工程师」' })).toBeVisible();
  await expect(status).toHaveValue('written_test_active');
});
