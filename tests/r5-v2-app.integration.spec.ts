import { expect, test } from '@playwright/test';

const COMPANY = 'R5 历史交互验收';

test('history node details, append, backfill, and correction invoke persisted R1 commands', async ({ page }) => {
  // Playwright creates a fresh, ephemeral browser context for this test. Let the
  // app initialize its own database there; never delete an existing user database.
  await page.goto('/settings');
  await page.getByLabel('名称').fill('R5 独立验收招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();

  await page.goto('/applications');
  await page.getByRole('button', { name: /新建草稿/ }).first().click();
  const createDialog = page.getByRole('dialog', { name: '新建投递草稿' });
  await createDialog.getByLabel('公司').fill(COMPANY);
  await createDialog.getByLabel('岗位').fill('客户端工程师');
  await createDialog.getByRole('button', { name: '创建空进度草稿' }).click();
  await expect(page.getByText('已创建一条尚未记录进度的草稿。')).toBeVisible();

  await page.goto('/board');
  await expect(page.getByText(COMPANY)).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`修改${COMPANY}的状态`) }).click();
  const drawer = page.locator('dialog.app-drawer');
  await expect(drawer.getByRole('heading', { name: `记录状态 · ${COMPANY}` })).toBeVisible();
  await drawer.locator('select').first().selectOption('screening');
  await drawer.locator('input[type="date"]').fill('2026-09-10');
  await drawer.getByRole('button', { name: '记录状态' }).click();

  await expect(drawer.getByRole('heading', { name: `进度历史 · ${COMPANY}` })).toBeVisible();
  let cards = drawer.locator('.progress-history__card');
  await expect(cards).toHaveCount(1);
  await cards.nth(0).getByRole('button', { name: '查看事件' }).click();
  const details = drawer.getByRole('complementary', { name: '选中事件详情' });
  await expect(details).toContainText('筛选中');
  await expect(details).toContainText('正常记录');
  await expect(details).toContainText('2026-09-10');

  await cards.nth(0).getByRole('button', { name: '＋ 追加记录' }).click();
  await expect(drawer.getByRole('form', { name: '追加进度状态' })).toBeVisible();
  await drawer.locator('select').first().selectOption('written_test_active');
  await drawer.locator('input[type="date"]').fill('2026-09-11');
  await drawer.getByRole('button', { name: '记录状态' }).click();
  await expect(drawer.getByRole('heading', { name: `进度历史 · ${COMPANY}` })).toBeVisible();
  cards = drawer.locator('.progress-history__card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toContainText('笔试中');
  const firstCardBounds = await cards.nth(0).boundingBox();
  const secondCardBounds = await cards.nth(1).boundingBox();
  const edgeBounds = await drawer.locator('.progress-history__edge').first().boundingBox();
  expect(firstCardBounds).not.toBeNull();
  expect(secondCardBounds).not.toBeNull();
  expect(edgeBounds).not.toBeNull();
  expect(secondCardBounds!.y).toBeGreaterThan(firstCardBounds!.y + firstCardBounds!.height);
  expect(Math.abs((edgeBounds!.x + edgeBounds!.width / 2) - (firstCardBounds!.x + firstCardBounds!.width / 2))).toBeLessThan(1);
  expect(edgeBounds!.height).toBeLessThanOrEqual(32);
  expect(firstCardBounds!.width).toBeGreaterThan(firstCardBounds!.height * 2);

  await cards.nth(0).getByRole('button', { name: '在此节点前补录' }).click();
  await expect(drawer.getByRole('form', { name: '在历史节点前补录' })).toBeVisible();
  await expect(drawer.getByRole('form', { name: '在历史节点前补录' })).toContainText('筛选中 · 2026-09-10');
  await drawer.locator('select').first().selectOption('submitted');
  await drawer.locator('input[type="date"]').fill('2026-09-09');
  await drawer.getByRole('button', { name: '保存补录' }).click();
  await expect(drawer.getByRole('heading', { name: `进度历史 · ${COMPANY}` })).toBeVisible();
  cards = drawer.locator('.progress-history__card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('已投递');
  await expect(cards.nth(1)).toContainText('筛选中');
  await expect(cards.nth(2)).toContainText('笔试中');
  await cards.nth(0).getByRole('button', { name: '查看事件' }).click();
  await expect(drawer.getByRole('complementary', { name: '选中事件详情' })).toContainText('历史补录');
  await expect(drawer.getByRole('complementary', { name: '选中事件详情' })).toContainText('补录锚点 ID');

  await cards.nth(0).getByRole('button', { name: '纠错' }).click();
  await expect(drawer.getByRole('form', { name: '纠正历史事件' })).toBeVisible();
  await expect(drawer.getByRole('form', { name: '纠正历史事件' })).toContainText('已投递 · 2026-09-09');
  await drawer.locator('select').first().selectOption('pool');
  await drawer.getByRole('button', { name: '保存纠错' }).click();
  await expect(drawer.getByRole('heading', { name: `进度历史 · ${COMPANY}` })).toBeVisible();
  cards = drawer.locator('.progress-history__card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('泡池子');
  await expect(cards.nth(1)).toContainText('筛选中');
  await expect(cards.nth(2)).toContainText('笔试中');
  await cards.nth(0).getByRole('button', { name: '查看事件' }).click();
  const correctedDetails = drawer.getByRole('complementary', { name: '选中事件详情' });
  await expect(correctedDetails).toContainText('纠正来源 ID');
});
