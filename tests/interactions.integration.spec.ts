import { expect, test, type Page } from '@playwright/test';

async function createApplication(page: Page, company: string, role: string, cities: string[]) {
  await page.goto('/board');
  await page.getByRole('button', { name: '新增投递' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增投递' });
  await dialog.getByLabel('公司').fill(company);
  await dialog.getByLabel('岗位 *', { exact: true }).fill(role);
  for (const city of cities) {
    await dialog.getByRole('combobox', { name: '城市' }).fill(city);
    await page.keyboard.press('Enter');
  }
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('dialog.app-drawer[open]')).toHaveCount(0);
}

test('城市建议只在输入时出现，Esc、点别处、选择后都会收起', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('交互验收招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();
  await createApplication(page, '城市公司甲', '后端工程师', ['上海', '北京']);

  await page.getByRole('button', { name: '新增投递' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增投递' });
  const city = dialog.getByRole('combobox', { name: '城市' });
  const menu = dialog.getByRole('listbox');

  await city.focus();
  await expect(menu).toHaveCount(0); // focusing alone shows nothing

  await city.fill('上');
  await expect(menu.getByRole('option')).toHaveText(['上海']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible(); // Esc closed only the suggestions, not the drawer

  await city.fill('北京');
  await expect(menu).toBeVisible();
  await dialog.getByLabel('公司').click(); // clicking elsewhere closes it
  await expect(menu).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '移除北京' })).toBeVisible(); // pending text became a tag

  await city.fill('上');
  await menu.getByRole('option', { name: '上海' }).click();
  await expect(menu).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '移除上海' })).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
});

test('进度看板：点一行任意位置展开，地点可直接编辑', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('看板交互招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();
  await createApplication(page, '看板公司', '前端工程师', ['上海']);

  const row = page.locator('tr.sheet__row').filter({ hasText: '看板公司' });
  const detail = page.locator('.sheet__detail');

  // Anywhere on the row toggles the flow …
  await row.locator('.sheet__role').click();
  await expect(detail).toBeVisible();
  await row.locator('.sheet__role').click();
  await expect(detail).toHaveCount(0);

  // … except controls that do something else.
  await row.getByRole('button', { name: '编辑看板公司的备注' }).click();
  await expect(row.getByRole('textbox', { name: '看板公司的备注' })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Work location: Enter adds a tag, Enter on an empty input saves.
  await row.getByRole('button', { name: '编辑看板公司的工作地点' }).click();
  const input = row.getByRole('combobox', { name: '看板公司的工作地点' });
  await expect(input).toBeFocused();
  await expect(detail).toHaveCount(0);
  await input.fill('北京');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: '工作地点已保存' })).toBeVisible();
  await expect(row.locator('.sheet__city')).toHaveText(['上海', '北京']);

  // Clicking elsewhere saves what is still being typed; Esc cancels.
  await row.getByRole('button', { name: '编辑看板公司的工作地点' }).click();
  await row.getByRole('combobox', { name: '看板公司的工作地点' }).fill('杭州');
  await page.getByRole('heading', { level: 1 }).click();
  await expect(row.locator('.sheet__city')).toHaveText(['上海', '北京', '杭州']);

  await row.getByRole('button', { name: '编辑看板公司的工作地点' }).click();
  await row.getByRole('button', { name: '移除上海' }).click();
  await row.getByRole('combobox', { name: '看板公司的工作地点' }).press('Escape');
  await expect(row.locator('.sheet__city')).toHaveText(['上海', '北京', '杭州']);
});

test('数据总览：近期日程可以展开查看，并一键完成和撤销', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('日程总览招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();
  await createApplication(page, '日程公司', '算法工程师', []);

  await page.goto('/applications');
  await page.getByRole('row', { name: /日程公司.*算法工程师/ }).getByRole('button', { name: /日程公司/ }).click();
  const drawer = page.getByRole('dialog', { name: '日程公司' });
  const schedules = drawer.getByRole('region', { name: '日程管理' });
  await schedules.getByRole('button', { name: '添加日程' }).click();
  const form = schedules.getByRole('form', { name: '添加日程' });
  await form.getByLabel('类型').selectOption('interview');
  await form.getByLabel('标题').fill('二面');
  await form.getByLabel('开始时间').fill('2026-09-20T10:30');
  await form.getByLabel('备注').fill('带笔记本电脑');
  await form.getByRole('button', { name: '添加日程' }).click();
  await expect(schedules.locator('.applications-v2__schedule-list li').filter({ hasText: '二面' })).toBeVisible();
  await drawer.getByRole('button', { name: /关闭/ }).first().click();

  await page.goto('/overview');
  const item = page.locator('.upcoming__item').filter({ hasText: '二面' });
  await expect(item).toContainText('日程公司');
  await expect(item).toContainText('已逾期');

  await item.getByRole('button', { name: /^二面/ }).click();
  await expect(item.locator('.upcoming__detail')).toContainText('面试');
  await expect(item.locator('.upcoming__detail')).toContainText('日程公司 · 算法工程师');
  await expect(item.locator('.upcoming__detail')).toContainText('带笔记本电脑');

  await item.getByRole('button', { name: '完成日程：二面' }).click();
  await expect(page.locator('.upcoming__item').filter({ hasText: '二面' })).toHaveCount(0);
  const toast = page.locator('.toast').filter({ hasText: '已完成「二面」' });
  await toast.getByRole('button', { name: '撤销' }).click();
  await expect(page.locator('.upcoming__item').filter({ hasText: '二面' })).toBeVisible();

  // The restored item comes back still expanded.
  await page.getByRole('button', { name: '打开这条投递（改时间、取消、删除）' }).click();
  await expect(page.getByRole('dialog', { name: '日程公司' })).toBeVisible();
});
