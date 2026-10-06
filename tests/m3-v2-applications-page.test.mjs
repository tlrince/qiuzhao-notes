import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDirectory = process.env.M3_PAGE_MODEL_BUILD_DIR;
if (!buildDirectory) throw new Error('Set M3_PAGE_MODEL_BUILD_DIR to the isolated TypeScript output directory before running this test.');
const model = await import(pathToFileURL(join(buildDirectory, 'features/applications/applications-page-model.js')).href);

const application = (id, seasonId, company, role, city, updatedAt) => ({
  id, seasonId, company, role, city, updatedAt,
});

test('search is scoped to the selected season and matches company, role, and city without case sensitivity', () => {
  const rows = [
    application('a', 'fall-1', 'Northwind', 'Backend Engineer', '上海', '2026-09-16T10:00:00.000Z'),
    application('b', 'fall-1', 'Contoso', 'Data Engineer', '杭州', '2026-09-17T10:00:00.000Z'),
    application('c', 'fall-2', 'Northwind', 'Product Manager', '北京', '2026-09-17T11:00:00.000Z'),
  ];

  assert.deepEqual(model.filterApplicationsForSeason(rows, 'fall-1', 'NORTH'), [rows[0]]);
  assert.deepEqual(model.filterApplicationsForSeason(rows, 'fall-1', 'engineer'), [rows[1], rows[0]]);
  assert.deepEqual(model.filterApplicationsForSeason(rows, 'fall-1', '杭州'), [rows[1]]);
  assert.equal(model.filterApplicationsForSeason(rows, 'fall-1', 'PM').length, 0);
});

test('blank query returns the selected season in most recently updated order', () => {
  const rows = [
    application('a', 'fall-1', 'Old', 'Role', '', '2026-09-16T10:00:00.000Z'),
    application('b', 'fall-1', 'New', 'Role', '', '2026-09-17T10:00:00.000Z'),
  ];
  assert.deepEqual(model.filterApplicationsForSeason(rows, 'fall-1', '   ').map(row => row.id), ['b', 'a']);
});

test('external destinations accept only valid HTTP and HTTPS URLs', () => {
  assert.equal(model.safeExternalHttpUrl('https://example.com/jobs/1'), 'https://example.com/jobs/1');
  assert.equal(model.safeExternalHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(model.safeExternalHttpUrl('javascript:alert(1)'), null);
  assert.equal(model.safeExternalHttpUrl('file:///tmp/private'), null);
  assert.equal(model.safeExternalHttpUrl('not a url'), null);
  assert.equal(model.safeExternalHttpUrl(''), null);
});

test('pasted links without a scheme become https, while text and other schemes are left for validation', () => {
  assert.equal(model.normalizeUrlInput(' jobs.example.com/apply?id=1 '), 'https://jobs.example.com/apply?id=1');
  assert.equal(model.normalizeUrlInput('https://jobs.example.com'), 'https://jobs.example.com');
  assert.equal(model.normalizeUrlInput('boss投递'), 'boss投递');
  assert.equal(model.normalizeUrlInput('javascript:alert(1)'), 'javascript:alert(1)');
  assert.equal(model.normalizeUrlInput(''), '');
});

test('same company and position in the season are reported as earlier applications', () => {
  const rows = [
    application('a', 'fall-1', '星河科技', 'AI全栈开发工程师', '杭州', '2026-08-20T00:00:00.000Z'),
    application('b', 'fall-2', '星河科技', 'AI全栈开发工程师', '', '2026-09-11T00:00:00.000Z'),
  ];
  assert.deepEqual(model.sameRoleApplications(rows, 'fall-1', ' 星河科技 ', 'ai全栈开发工程师').map(item => item.id), ['a']);
  assert.deepEqual(model.sameRoleApplications(rows, 'fall-1', '星河科技', ''), []);
});
