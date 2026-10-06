import { expect, test } from '@playwright/test';

test('M3 详情页可确认删除投递，并完整管理日程的增删改、完成和取消', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('名称').fill('M3 日程闭环招聘季');
  await page.getByRole('button', { name: '创建并设为当前' }).click();
  await expect(page.getByText('招聘季已创建并设为当前招聘季。')).toBeVisible();

  await page.goto('/applications');
  await page.getByRole('button', { name: /新建草稿/ }).first().click();
  const create = page.getByRole('dialog', { name: '新建投递草稿' });
  await create.getByLabel('公司').fill('M3 日程公司');
  await create.getByLabel('岗位').fill('客户端工程师');
  await create.getByRole('button', { name: '创建空进度草稿' }).click();
  const row = page.getByRole('row', { name: /M3 日程公司.*客户端工程师/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /M3 日程公司/ }).click();

  const drawer = page.getByRole('dialog', { name: 'M3 日程公司' });
  const schedules = drawer.getByRole('region', { name: '日程管理' });
  await schedules.getByRole('button', { name: '添加日程' }).click();
  const createSchedule = schedules.getByRole('form', { name: '添加日程' });
  await createSchedule.getByLabel('类型').selectOption('interview');
  await createSchedule.getByLabel('标题').fill('技术一面');
  await createSchedule.getByLabel('开始时间').fill('2026-09-20T10:30');
  await createSchedule.getByLabel('备注').fill('会议链接待确认');
  await createSchedule.getByRole('button', { name: '添加日程' }).click();

  let item = schedules.locator('.applications-v2__schedule-list li').filter({ hasText: '技术一面' });
  await expect(item).toContainText('面试');
  await expect(item).toContainText('待办');
  await item.getByRole('button', { name: '编辑' }).click();
  const editSchedule = schedules.getByRole('form', { name: '编辑日程' });
  await editSchedule.getByLabel('标题').fill('技术一面（线上）');
  await editSchedule.getByLabel('备注').fill('腾讯会议');
  await editSchedule.getByRole('button', { name: '保存日程' }).click();
  item = schedules.locator('.applications-v2__schedule-list li').filter({ hasText: '技术一面（线上）' });
  await expect(item).toContainText('腾讯会议');

  await item.getByRole('button', { name: '完成' }).click();
  await expect(item).toContainText('已完成');
  await item.getByRole('button', { name: '恢复待办' }).click();
  await expect(item).toContainText('待办');
  await item.getByRole('button', { name: '取消日程' }).click();
  await expect(item).toContainText('已取消');

  await item.getByRole('button', { name: '删除' }).click();
  const deleteScheduleConfirm = page.getByRole('dialog', { name: '删除这条日程？' });
  await deleteScheduleConfirm.getByRole('button', { name: '删除日程' }).click();
  await expect(schedules.getByText('还没有安排日程。')).toBeVisible();

  await drawer.getByRole('button', { name: '删除投递' }).click();
  const keepApplication = page.getByRole('dialog', { name: '删除这条投递？' });
  await keepApplication.getByRole('button', { name: '保留投递' }).click();
  await expect(row).toBeVisible();
  await drawer.getByRole('button', { name: '删除投递' }).click();
  const deleteApplicationConfirm = page.getByRole('dialog', { name: '删除这条投递？' });
  await expect(deleteApplicationConfirm).toContainText('全部进度历史、日程和旧历史副本');
  await deleteApplicationConfirm.getByRole('button', { name: '删除投递' }).click();
  await expect(page.getByRole('row', { name: /M3 日程公司.*客户端工程师/ })).toHaveCount(0);
  await expect(page.getByText('投递及关联进度、日程和旧历史已删除；删除前的数据快照已保留。')).toBeVisible();
});
