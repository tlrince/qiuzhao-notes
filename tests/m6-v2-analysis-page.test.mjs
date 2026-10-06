import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivityWeeks,
  businessDateAt,
  formatAnalysisRate,
  resolveAnalysisDateScope,
  twelveWeekWindow,
  weeklyActivityTotals,
} from '../src/features/analytics/analysis-page-model.ts';

const season = { startDate: '2026-08-15', endDate: '2026-12-31' };

test('season, recent-30-day, and custom controls resolve to appliedOn ranges', () => {
  assert.deepEqual(resolveAnalysisDateScope('season', season, '2026-09-17', { from: '', to: '' }), { valid: true });
  assert.deepEqual(resolveAnalysisDateScope('last30', season, '2026-09-17', { from: '', to: '' }), {
    valid: true, range: { from: '2026-08-19', to: '2026-09-17' },
  });
  assert.deepEqual(resolveAnalysisDateScope('custom', season, '2026-09-17', { from: '2026-09-01', to: '2026-09-12' }), {
    valid: true, range: { from: '2026-09-01', to: '2026-09-12' },
  });
});

test('last 30 days clamp to the season and reject a future season with no available dates', () => {
  assert.deepEqual(resolveAnalysisDateScope('last30', season, '2026-08-20', { from: '', to: '' }), {
    valid: true, range: { from: '2026-08-15', to: '2026-08-20' },
  });
  assert.equal(resolveAnalysisDateScope('last30', { startDate: '2026-10-01', endDate: '2026-12-31' }, '2026-09-17', { from: '', to: '' }).valid, false);
});

test('custom range rejects missing, reversed, out-of-season, and future dates instead of falling back to full-season data', () => {
  assert.equal(resolveAnalysisDateScope('custom', season, '2026-09-17', { from: '', to: '' }).valid, false);
  assert.equal(resolveAnalysisDateScope('custom', season, '2026-09-17', { from: '2026-09-10', to: '2026-09-01' }).valid, false);
  assert.equal(resolveAnalysisDateScope('custom', season, '2026-09-17', { from: '2026-08-01', to: '2026-09-01' }).valid, false);
  assert.equal(resolveAnalysisDateScope('custom', season, '2026-09-17', { from: '2026-09-01', to: '2026-09-18' }).valid, false);
});

test('business date follows the workspace timezone across UTC midnight', () => {
  assert.equal(businessDateAt('2026-09-16T16:30:00.000Z', 'Asia/Shanghai'), '2026-09-17');
  assert.equal(businessDateAt('2026-09-17T00:30:00.000Z', 'America/Los_Angeles'), '2026-09-16');
});

test('activity display is 12 Monday-aligned weeks, disables dates outside the selected result and future days', () => {
  const today = '2026-09-17';
  assert.deepEqual(twelveWeekWindow(today), { from: '2026-06-29', to: today });
  const weeks = buildActivityWeeks({
    activity: [{ date: '2026-09-15', count: 2, disabled: false }],
    activityWindow: { from: '2026-09-01', to: today },
  }, today);
  assert.equal(weeks.length, 12);
  assert.ok(weeks.every(week => week.length === 7));
  assert.equal(weeks[0][0].date, '2026-06-29', 'first cell begins on Monday');
  assert.equal(weeks.flat().length, 84);
  assert.equal(weeks.flat().find(cell => cell.date === '2026-09-15').count, 2);
  assert.equal(weeks.flat().find(cell => cell.date === '2026-08-31').disabled, true, 'dates before the selected range are disabled');
  assert.equal(weeks.flat().find(cell => cell.date === '2026-09-18').disabled, true, 'future dates are disabled');
  assert.deepEqual(weeklyActivityTotals(weeks).slice(-2), [0, 2]);
});

test('activity grid remains empty when the M5 display window has no intersection', () => {
  const weeks = buildActivityWeeks({ activity: [], activityWindow: null }, '2026-09-17');
  assert.ok(weeks.flat().every(cell => cell.disabled && cell.count === 0));
  assert.equal(formatAnalysisRate(null), '—');
  assert.equal(formatAnalysisRate(66.7), '66.7%');
});
