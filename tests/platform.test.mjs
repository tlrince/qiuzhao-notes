import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlatform, createMockPlatform } from '../dist/platform/index.js';
import { validateExternalUrl, validateBackupSize, MAX_BACKUP_BYTES } from '../dist/platform/validation.js';
import { createMemorySnapshotStore } from '../dist/repositories/storage-contract.js';
import { acceptanceSnapshot } from '../dist/fixtures/acceptance.js';

test('Web 平台可在无 DOM 与无原生 runtime 下选择，不加载原生 API', async () => {
  const platform = await loadPlatform('web', { version: '1.2.3' });
  assert.equal(platform.kind, 'web'); assert.equal(platform.storageLabel, '此浏览器');
  assert.equal(await platform.getAppVersion(), '1.2.3'); assert.equal(await platform.loadLastRoute(), null);
  (await platform.subscribeWindowAction(() => assert.fail('Web 不接收原生事件')))();
});
test('备份取消不写入，Web requested 与 Mac saved 分开，原始文本不提前解析', async () => {
  const web = createMockPlatform({ file: 'not JSON' }), mac = createMockPlatform({ kind: 'macos' });
  assert.equal(await web.readBackupFile(), 'not JSON'); assert.equal(await mac.readBackupFile(), null);
  assert.equal(await web.saveBackupFile('backup.json', '{}'), 'requested');
  assert.equal(await mac.saveBackupFile('backup.json', '{}'), 'saved');
  const cancelled = createMockPlatform({ saveResult: 'cancelled' });
  assert.equal(await cancelled.saveBackupFile('backup.json', '{}'), 'cancelled'); assert.deepEqual(cancelled.savedFiles, []);
  await assert.rejects(web.saveBackupFile('../backup.json', '{}'), { code: 'VALIDATION' });
});
test('外链只接受完整 http(s) 地址，拒绝协议绕过、凭据、相对路径和控制字符', async () => {
  assert.equal(validateExternalUrl('https://example.com/jobs?q=1'), 'https://example.com/jobs?q=1');
  const platform = createMockPlatform();
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', '//example.com', 'https:example.com', ' https://example.com', 'https://user:pass@example.com', 'https://example.com\n', 'https://example.com\\evil', 'https://', 'data:text/plain,hello']) {
    await assert.rejects(platform.openExternal(value), { code: 'VALIDATION' });
  }
  assert.deepEqual(platform.externalUrls, []);
  await platform.openExternal('http://example.com'); assert.deepEqual(platform.externalUrls, ['http://example.com/']);
});
test('备份 25 MB 上限按 UTF-8 字节而非字符计算', async () => {
  validateBackupSize(MAX_BACKUP_BYTES);
  assert.throws(() => validateBackupSize(MAX_BACKUP_BYTES + 1), { code: 'VALIDATION' });
  const platform = createMockPlatform({ file: '中'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3)) });
  await assert.rejects(platform.readBackupFile(), { code: 'VALIDATION' });
});
test('窗口生命周期 Mock 可以取消订阅，恢复路由不能指向外部地址', async () => {
  const platform = createMockPlatform({ kind: 'macos' }); const actions = []; let navigation = 0;
  const off = await platform.subscribeWindowAction(action => actions.push(action));
  const offNav = await platform.subscribeSettingsNavigation(() => navigation++);
  platform.emitWindowAction('close'); platform.emitSettingsNavigation(); off(); offNav();
  platform.emitWindowAction('quit'); platform.emitSettingsNavigation();
  assert.deepEqual(actions, ['close']); assert.equal(navigation, 1);
  const menu = []; const offMenu = await platform.subscribeMenuAction(action => menu.push(action));
  platform.emitMenuAction('new'); platform.emitMenuAction('find'); offMenu(); platform.emitMenuAction('backup');
  assert.deepEqual(menu, ['new', 'find']);
  await platform.finishWindowAction('close'); assert.deepEqual(platform.finishedActions, ['close']);
  await platform.saveLastRoute('/applications?stage=submitted'); assert.equal(await platform.loadLastRoute(), '/applications?stage=submitted');
  await assert.rejects(platform.saveLastRoute('https://example.com'), { code: 'VALIDATION' });
  await platform.saveLastRoute('/settings/definitions'); assert.equal(await platform.loadLastRoute(), '/settings/definitions');
  await assert.rejects(platform.saveLastRoute('/settings/unknown'), { code: 'VALIDATION' });
});
test('快照读写隔离并保留事件数组逻辑顺序', async () => {
  const seed = acceptanceSnapshot(), store = createMemorySnapshotStore(seed); const before = structuredClone(seed);
  seed.applications[0].company = 'outside mutation';
  const read = await store.read(); assert.equal(read.revision, 0); assert.deepEqual(read.data, before);
  read.data.applications[0].company = 'new company';
  assert.deepEqual((await store.read()).data, before);
  assert.equal(await store.commit(0, read.data), 1);
  read.data.applications[0].company = 'after commit mutation';
  const committed = await store.read(); assert.equal(committed.data.applications[0].company, 'new company');
  assert.deepEqual(committed.data.stageEvents, before.stageEvents);
});
test('同一 revision 并发写入仅一次成功，冲突不留下部分数据', async () => {
  const store = createMemorySnapshotStore(acceptanceSnapshot());
  const a = await store.read(), b = await store.read();
  a.data.applications[0].company = 'first'; b.data.applications = [];
  const results = await Promise.allSettled([store.commit(a.revision, a.data), store.commit(b.revision, b.data)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'CONFLICT');
  const final = await store.read(); assert.equal(final.revision, 1); assert.deepEqual(final.data, a.data);
});
test('快照复制失败不提交且不增加 revision，关闭后拒绝读写', async () => {
  const store = createMemorySnapshotStore(); const before = await store.read();
  await assert.rejects(store.commit(0, { ...before.data, invalid: () => {} }));
  assert.deepEqual(await store.read(), before);
  await store.close(); await store.close();
  await assert.rejects(store.read(), { code: 'STORAGE' }); await assert.rejects(store.commit(0, before.data), { code: 'STORAGE' });
});
