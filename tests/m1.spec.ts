import { expect, test, type Page } from '@playwright/test';

const routes = [
  ['/overview', '数据总览', '每一步，都算数。'],
  ['/applications', '投递管理', '投递记录'],
  ['/board', '进度看板', '每一段经历，都有迹可循。'],
  ['/analytics', '深度分析', '从数据里，找到方向。'],
  ['/settings', '数据与设置', '管理你的工作空间。'],
] as const;

async function navigate(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: '打开导航', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true }).click();
}

async function createResponsiveTestSeason(page: Page) {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('M1 响应式测试招聘季');
  await page.getByRole('button', { name: '创建并设为当前', exact: true }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。', { exact: true })).toBeVisible();
  await page.goto('/analytics');
}

test('默认入口、深链接、刷新和浏览器返回保持路由与查询', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('从数据里，找到方向。');
  await page.goto('/applications?keyword=%E8%AE%BE%E8%AE%A1&stage=submitted');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('投递记录');
  await page.reload();
  expect(new URL(page.url()).searchParams.get('keyword')).toBe('设计');
  await navigate(page, '深度分析');
  await expect(page).toHaveURL(/\/analytics$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('投递记录');
  expect(new URL(page.url()).searchParams.get('keyword')).toBe('设计');
  expect(new URL(page.url()).searchParams.get('stage')).toBe('submitted');
});

for (const [width, height] of [[2032, 1160], [1440, 900], [1024, 900], [768, 1024], [390, 844]]) {
  test(`${width}×${height} 布局无溢出、指标响应式与五个页面导航`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await createResponsiveTestSeason(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('从数据里，找到方向。');
    const columns = await page.locator('.analysis-v2__metrics').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width > 1100 ? 4 : 2);
    const chartColumns = await page.locator('.analysis-v2__chart-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(chartColumns).toBe(width > 1100 ? 2 : 1);
    const heatmapDay = page.locator('.analysis-v2__heatmap .analysis-v2__day').first();
    const heatmapDayBounds = await heatmapDay.boundingBox();
    expect(heatmapDayBounds).not.toBeNull();
    expect(heatmapDayBounds!.height).toBeLessThanOrEqual(width < 768 ? 12 : 15);
    const footerBounds = await page.locator('.analysis-v2__heatmap-footer').boundingBox();
    const legendBounds = await page.locator('.analysis-v2__legend').boundingBox();
    expect(footerBounds).not.toBeNull();
    expect(legendBounds).not.toBeNull();
    expect(legendBounds!.y + legendBounds!.height).toBeLessThanOrEqual(footerBounds!.y + footerBounds!.height + 1);
    await page.screenshot({ path: `artifacts/m1/${width}x${height}.png`, fullPage: true });
    for (const [path, name, heading] of routes) {
      await navigate(page, name);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width < 768) {
        await expect(page.getByRole('dialog', { name: '工作空间导航' })).not.toBeVisible();
        await page.getByRole('button', { name: '打开导航', exact: true }).click();
      }
      await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      if (width < 768) await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });
}

test('抽屉限制焦点、保护未保存输入并在关闭后恢复焦点', async ({ page }) => {
  await page.goto('/design-system');
  const trigger = page.getByRole('button', { name: '打开抽屉预览', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: '抽屉预览', exact: true });
  await expect(drawer).toBeVisible();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.getByLabel('预览备注', { exact: true }).fill('保留这条未保存备注');
  await page.keyboard.press('Escape');
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByLabel('预览备注', { exact: true })).toHaveValue('保留这条未保存备注');
  await page.keyboard.press('Escape');
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('保存状态可读且真实外壳不宣称已持久化', async ({ page }) => {
  await page.goto('/analytics');
  await expect(page.getByText('尚未保存', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('已保存到本机', { exact: true })).toHaveCount(0);
  await page.goto('/design-system');
  const selector = page.getByLabel('保存状态预览', { exact: true });
  for (const [value, label] of [['saving', '保存中'], ['saved', '已保存到此浏览器'], ['error', '保存失败'], ['idle', '尚未保存']]) {
    await selector.selectOption(value);
    await expect(page.locator('.component-status').getByText(label, { exact: true })).toBeVisible();
  }
  await page.reload();
  await expect(selector).toHaveValue('idle');
});
