import { describe, it, expect } from 'vitest';

import { isUserReport } from './user-reports.js';

describe('isUserReport', () => {
  const report = {
    channel: 'C_REPORTS',
    ts: '1.0',
    user: 'U_APP',
    bot_id: 'B_APP',
  };

  it('accepts a top-level bot post in the reports channel', () => {
    expect(isUserReport(report, 'C_REPORTS', 'U_BOT')).toBe(true);
    expect(
      isUserReport({ ...report, thread_ts: '1.0' }, 'C_REPORTS', 'U_BOT'),
    ).toBe(true);
  });

  it('is disabled when no reports channel is configured', () => {
    expect(isUserReport(report, undefined, 'U_BOT')).toBe(false);
  });

  it('rejects other channels, replies, humans and own posts', () => {
    expect(isUserReport(report, 'C_OTHER', 'U_BOT')).toBe(false);
    expect(
      isUserReport({ ...report, thread_ts: '0.5' }, 'C_REPORTS', 'U_BOT'),
    ).toBe(false);
    expect(
      isUserReport({ ...report, bot_id: undefined }, 'C_REPORTS', 'U_BOT'),
    ).toBe(false);
    expect(isUserReport(report, 'C_REPORTS', 'U_APP')).toBe(false);
  });
});
