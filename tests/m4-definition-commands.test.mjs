import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.M4_DEFINITION_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const { acceptanceSnapshot } = await moduleAt('fixtures/acceptance.js');
const { migrateV1Snapshot, validateV2Snapshot } = await moduleAt('domain/v2/index.js');
const { createMemorySnapshotStoreV2 } = await moduleAt('repositories/storage-v2-contract.js');
const { createDefinitionCommands } = await moduleAt('repositories/v2/definition-commands.js');

const workspaceId = 'local';
const migrationTime = '2026-09-17T00:00:00.000Z';

function setup() {
  const seed = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: migrationTime });
  const store = createMemorySnapshotStoreV2(seed);
  let tick = 1;
  let serial = 0;
  const commands = createDefinitionCommands(store, {
    now: () => `2026-09-17T00:00:${String(tick++).padStart(2, '0')}.000Z`,
    id: () => `m4-${++serial}`,
  });
  return { store, commands };
}

async function current(store) {
  return store.read();
}

const withRevision = async (store, extra = {}) => ({
  workspaceId,
  expectedRevision: (await current(store)).revision,
  ...extra,
});

test('新增环节和状态要求当前 workspace，并按 stageId 派生语义快照', async () => {
  const { store, commands } = setup();
  const before = await current(store);
  await assert.rejects(commands.createStage({
    workspaceId: 'other-workspace', expectedRevision: before.revision,
    id: 'mgr-chat', name: '主管沟通', category: 'interview', sortOrder: 130, countsAsInterview: true,
  }), error => error.code === 'VALIDATION');
  assert.deepEqual(await current(store), before);

  const stage = await commands.createStage({
    workspaceId, expectedRevision: before.revision,
    id: 'mgr-chat', name: '  主管沟通  ', category: 'interview', sortOrder: 130, countsAsInterview: true,
  });
  assert.equal(stage.value.name, '主管沟通');
  const status = await commands.createStatus({
    ...await withRevision(store), id: 'mgr-chat-active', name: '沟通中', color: '#886644', sortOrder: 131,
    semantic: 'stage', stageId: 'mgr-chat', defaultPhase: 'in_progress', statisticsCategory: 'human_interview',
  });
  assert.equal(status.value.version, 1);
  assert.deepEqual(status.value.semanticsHistory[0], {
    version: 1, semantic: 'stage', stageId: 'mgr-chat', stageCategory: 'interview',
    defaultPhase: 'in_progress', statisticsCategory: 'human_interview', countsAsInterview: true,
  });
  validateV2Snapshot((await current(store)).data);
});

test('新增状态拒绝不存在环节、错误 phase 和不匹配的类别/结果', async () => {
  const { store, commands } = setup();
  const base = await current(store);
  const create = overrides => commands.createStatus({
    workspaceId, expectedRevision: base.revision, id: 'bad-status', name: '结果', color: '#886644', sortOrder: 1,
    semantic: 'offer_declined', stageId: 'interview_1', defaultPhase: 'unknown', statisticsCategory: null,
    ...overrides,
  });
  await assert.rejects(create({}), error => error.code === 'VALIDATION');
  await assert.rejects(create({ stageId: 'not-a-stage' }), error => error.code === 'NOT_FOUND');
  await assert.rejects(create({ semantic: 'stage', stageId: null }), error => error.code === 'VALIDATION');
  await assert.rejects(create({ semantic: 'submitted', stageId: null, defaultPhase: 'in_progress' }), error => error.code === 'VALIDATION');
  assert.deepEqual(await current(store), base);

  const valid = await commands.createStatus({
    ...await withRevision(store), id: 'new-offer-declined', name: '拒绝 Offer', color: '#886644', sortOrder: 999,
    semantic: 'offer_declined', stageId: 'offer', defaultPhase: 'unknown', statisticsCategory: 'offer_declined',
  });
  assert.equal(valid.value.semanticsHistory[0].stageCategory, 'offer');
});

test('重命名、调色、排序不改语义版本；语义修改新增版本且旧事件快照不变', async () => {
  const { store, commands } = setup();
  const initial = await current(store);
  const statusId = 'legacy_interview_1_unknown';
  const event = initial.data.progressRecords.flatMap(record => record.events).find(item => item.statusId === statusId);
  assert.ok(event);
  const initialLabel = event.statusNameSnapshot;
  const initialMeaning = structuredClone(event.semantics);

  let result = await commands.updateStatus({
    ...await withRevision(store), statusId,
    patch: { name: '主管已沟通', color: '#123456', sortOrder: 707 },
  });
  assert.equal(result.value.version, 1);
  result = await commands.updateStatus({
    ...await withRevision(store), statusId,
    patch: { stageId: 'interview_2', statisticsCategory: 'custom_interview' },
  });
  assert.equal(result.value.version, 2);
  assert.equal(result.value.semanticsHistory.length, 2);
  assert.equal(result.value.semanticsHistory[0].stageId, 'interview_1');
  assert.equal(result.value.semanticsHistory[1].stageId, 'interview_2');
  const after = await current(store);
  const retained = after.data.progressRecords.flatMap(record => record.events).find(item => item.id === event.id);
  assert.equal(retained.statusNameSnapshot, initialLabel);
  assert.deepEqual(retained.semantics, initialMeaning);
  assert.equal(retained.definitionVersion, 1);
  validateV2Snapshot(after.data);
});

test('stage 统计语义变化为关联状态追加配置版本，不重写既有事件', async () => {
  const { store, commands } = setup();
  const stage = await commands.createStage({
    ...await withRevision(store), id: 'custom-chat', name: '主管沟通', category: 'custom', sortOrder: 900,
  });
  const status = await commands.createStatus({
    ...await withRevision(store), id: 'custom-chat-status', name: '主管沟通', color: '#668844', sortOrder: 900,
    semantic: 'custom', stageId: stage.value.id, defaultPhase: 'unknown', statisticsCategory: 'custom',
  });
  const changed = await commands.updateStage({
    ...await withRevision(store), stageId: stage.value.id,
    patch: { category: 'interview', countsAsInterview: true },
  });
  assert.equal(changed.value.category, 'interview');
  const snapshot = await current(store);
  const updated = snapshot.data.definitions.statuses.find(item => item.id === status.value.id);
  assert.equal(updated.version, 2);
  assert.equal(updated.semanticsHistory[0].stageCategory, 'custom');
  assert.equal(updated.semanticsHistory[0].countsAsInterview, false);
  assert.equal(updated.semanticsHistory[1].stageCategory, 'interview');
  assert.equal(updated.semanticsHistory[1].countsAsInterview, true);
  validateV2Snapshot(snapshot.data);
});

test('归档环节同步归档所属状态，引用的定义拒绝硬删除', async () => {
  const { store, commands } = setup();
  const createdStage = await commands.createStage({
    ...await withRevision(store), id: 'custom-pool', name: '候选池', category: 'pool', sortOrder: 800,
  });
  const createdStatus = await commands.createStatus({
    ...await withRevision(store), id: 'custom-pool-state', name: '池中', color: '#886644', sortOrder: 801,
    semantic: 'pool', stageId: 'custom-pool', defaultPhase: 'unknown', statisticsCategory: null,
  });
  const archived = await commands.archiveStage({
    ...await withRevision(store), stageId: createdStage.value.id, at: '2026-09-17T01:00:00.000Z',
  });
  assert.equal(archived.value.archivedAt, '2026-09-17T01:00:00.000Z');
  const snapshot = await current(store);
  assert.equal(snapshot.data.definitions.statuses.find(item => item.id === createdStatus.value.id).archivedAt, archived.value.archivedAt);
  await assert.rejects(commands.deleteStage(await withRevision(store, { stageId: createdStage.value.id })), error => error.code === 'VALIDATION');
  await commands.archiveStatus(await withRevision(store, { statusId: 'submitted' }));
  await assert.rejects(commands.deleteStatus(await withRevision(store, { statusId: 'submitted' })), error => error.code === 'VALIDATION');
  await commands.deleteStatus(await withRevision(store, { statusId: createdStatus.value.id }));
  await commands.deleteStage(await withRevision(store, { stageId: createdStage.value.id }));
  assert.equal((await current(store)).data.definitions.stages.some(item => item.id === createdStage.value.id), false);
});

test('归档后的未引用定义可以删除，删除依赖状态后可再删除环节', async () => {
  const { store, commands } = setup();
  const stage = await commands.createStage({
    ...await withRevision(store), id: 'unused-stage', name: '未使用环节', category: 'custom', sortOrder: 900,
  });
  const status = await commands.createStatus({
    ...await withRevision(store), id: 'unused-status', name: '未使用状态', color: '#886644', sortOrder: 900,
    semantic: 'custom', stageId: stage.value.id, defaultPhase: 'unknown', statisticsCategory: null,
  });
  await commands.archiveStage({ ...await withRevision(store), stageId: stage.value.id });
  await commands.deleteStatus(await withRevision(store, { statusId: status.value.id }));
  await commands.deleteStage(await withRevision(store, { stageId: stage.value.id }));
  const snapshot = await current(store);
  assert.equal(snapshot.data.definitions.stages.some(item => item.id === stage.value.id), false);
  assert.equal(snapshot.data.definitions.statuses.some(item => item.id === status.value.id), false);
  validateV2Snapshot(snapshot.data);
});

test('错误 workspace 与陈旧 revision 均不提交配置变更', async () => {
  const { store, commands } = setup();
  const before = await current(store);
  const input = {
    workspaceId, expectedRevision: before.revision,
    id: 'cas-stage', name: 'CAS', category: 'custom', sortOrder: 900,
  };
  const first = await commands.createStage(input);
  await assert.rejects(commands.createStage({ ...input, id: 'stale-stage' }), error => error.code === 'CONFLICT');
  await assert.rejects(commands.createStage({ ...await withRevision(store), workspaceId: 'wrong', id: 'wrong-stage', name: '错', category: 'custom', sortOrder: 2 }), error => error.code === 'VALIDATION');
  const after = await current(store);
  assert.equal(first.revision, before.revision + 1);
  assert.equal(after.data.definitions.stages.some(item => item.id === 'stale-stage'), false);
  assert.equal(after.data.definitions.stages.some(item => item.id === 'wrong-stage'), false);
});

test('a new stage brings its usual statuses, renames carry over, and archived definitions can be restored', async () => {
  const { store, commands } = setup();
  const hr = await commands.createStage({ ...await withRevision(store), name: 'HR 面', category: 'interview', sortOrder: 95, countsAsInterview: true, withStatuses: true });
  let statuses = (await current(store)).data.definitions.statuses.filter(item => item.stageId === hr.value.id);
  assert.deepEqual(statuses.map(item => item.name), ['待HR 面', 'HR 面中', 'HR 面待结果', 'HR 面通过', 'HR 面挂']);
  assert.ok(statuses.every(item => item.semanticsHistory[0].countsAsInterview));

  await commands.updateStage({ ...await withRevision(store), stageId: hr.value.id, patch: { name: '主管面' } });
  statuses = (await current(store)).data.definitions.statuses.filter(item => item.stageId === hr.value.id);
  assert.deepEqual(statuses.map(item => item.name), ['待主管面', '主管面中', '主管面待结果', '主管面通过', '主管面挂'], '改环节名后状态名同步');

  const archivedAlone = statuses[3];
  await commands.archiveStatus({ ...await withRevision(store), statusId: archivedAlone.id, at: '2026-09-17T02:00:00.000Z' });
  await commands.archiveStage({ ...await withRevision(store), stageId: hr.value.id, at: '2026-09-17T03:00:00.000Z' });
  await assert.rejects(commands.unarchiveStatus({ ...await withRevision(store), statusId: statuses[0].id }), /先恢复环节/);
  await commands.unarchiveStage({ ...await withRevision(store), stageId: hr.value.id });
  const restored = (await current(store)).data.definitions;
  assert.equal(restored.stages.find(item => item.id === hr.value.id).archivedAt, null);
  assert.deepEqual(restored.statuses.filter(item => item.stageId === hr.value.id && item.archivedAt !== null).map(item => item.id), [archivedAlone.id], '单独归档过的状态保持归档');
  await commands.unarchiveStatus({ ...await withRevision(store), statusId: archivedAlone.id });
  validateV2Snapshot((await current(store)).data);

  await commands.createStage({ ...await withRevision(store), name: '复筛', category: 'screening', sortOrder: 12, withStatuses: true });
  assert.deepEqual((await current(store)).data.definitions.statuses.filter(item => item.name.startsWith('复筛')).map(item => [item.name, item.semantic]), [['复筛中', 'screening'], ['复筛挂', 'failed']]);
});
