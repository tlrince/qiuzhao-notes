import { defaultR1Definitions } from './definitions.js';
import { appendProgressEvent, createProgressRecord, type AppendProgressInput } from './progress.js';
import type { ProgressRecord, R1DefinitionsSnapshot } from './types.js';

/** Deterministic R1 acceptance stories. They are opt-in fixtures and never loaded by the app. */
export interface R1MockCases { definitions: R1DefinitionsSnapshot; records: Record<string, ProgressRecord> }
export function createR1MockCases(): R1MockCases {
  const definitions = defaultR1Definitions(); let n = 0;
  const add = (record: ProgressRecord, input: AppendProgressInput) => { const turn = ++n; let serial = 0; return appendProgressEvent(record, definitions, input, { now: `2026-09-${String(Math.min(turn, 28)).padStart(2, '0')}T12:00:00.000Z`, id: () => `r1-${record.applicationId}-${turn}-${++serial}` }).record; };
  const record = (id: string, ...inputs: AppendProgressInput[]) => inputs.reduce(add, createProgressRecord(id));
  const submitted = (commandId: string): AppendProgressInput => ({ commandId, statusId: 'submitted', occurredOn: '2026-09-01' });
  return {
    definitions,
    records: {
      repeatScreening: record('mock-screening', submitted('screen-submit'),
        { commandId: 'screen-1', statusId: 'screening', occurredOn: '2026-09-02' },
        { commandId: 'written-1', statusId: 'written_test_active', occurredOn: '2026-09-03' },
        { commandId: 'screen-2', statusId: 'screening', occurredOn: '2026-09-04' },
        { commandId: 'ai-1', statusId: 'ai_active', occurredOn: '2026-09-05' }),
      repeatPool: record('mock-pool', submitted('pool-submit'),
        { commandId: 'i1', statusId: 'interview_1_active', occurredOn: '2026-09-02' },
        { commandId: 'pool-1', statusId: 'pool', occurredOn: '2026-09-03' },
        { commandId: 'i2', statusId: 'interview_2_active', occurredOn: '2026-09-04' },
        { commandId: 'pool-2', statusId: 'pool', occurredOn: '2026-09-05' },
        { commandId: 'i3', statusId: 'interview_3_active', occurredOn: '2026-09-06' }),
      offerDeclined: record('mock-declined', submitted('offer-submit'),
        { commandId: 'got-offer', statusId: 'offer_received', occurredOn: '2026-09-10' },
        { commandId: 'declined-offer', statusId: 'offer_declined', occurredOn: '2026-09-12' }),
      directInterview: record('mock-direct-interview', submitted('direct-submit'),
        { commandId: 'direct-i2', statusId: 'interview_2_active', occurredOn: '2026-09-08' }),
      unknownFailure: record('mock-unknown-failure', submitted('failure-submit'),
        { commandId: 'failure-unknown', statusId: 'failed_unknown', occurredOn: '2026-09-10', failedAt: 'unknown' }),
    },
  };
}
