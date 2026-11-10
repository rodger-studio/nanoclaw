import { describe, it, expect } from 'vitest';
import { ownerFollowsThread, userReportKind } from './user-reports.js';
describe('userReportKind', () => {
  const report = {
    channel: 'C_REPORTS',
    ts: '1.0',
    user: 'U_APP',
    bot_id: 'B_APP',
    text: ':envelope: Contact — Clutch: ma carte cadeau',
  };
  const followUp = { ...report, ts: '2.0', thread_ts: '1.0' };
  it('treats a top-level bot post in the reports channel as a new report', () => {
    expect(userReportKind(report, 'C_REPORTS', 'U_BOT')).toBe('new');
    expect(
      userReportKind({ ...report, thread_ts: '1.0' }, 'C_REPORTS', 'U_BOT'),
    ).toBe('new');
  });
  it('treats a feedback post replied in a thread as a follow-up', () => {
    expect(userReportKind(followUp, 'C_REPORTS', 'U_BOT')).toBe('follow-up');
    expect(
      userReportKind(
        { ...followUp, text: ':bug: Bug Report — Clutch: [Market report] x' },
        'C_REPORTS',
        'U_BOT',
      ),
    ).toBe('follow-up');
  });
  it('ignores other bot replies in a thread', () => {
    expect(
      userReportKind(
        { ...followUp, text: "✉️ Réponse envoyée à l'utilisateur :\n> ok" },
        'C_REPORTS',
        'U_BOT',
      ),
    ).toBeNull();
    expect(
      userReportKind({ ...followUp, text: undefined }, 'C_REPORTS', 'U_BOT'),
    ).toBeNull();
  });
  it('gives a Smash bug report its own triage', () => {
    const smashBug = {
      ...report,
      text: ':bug: *Bug Smash signalé par Damien (damien@rodgerstudio.com)*\n*Pour* : <@U0AA6SD1PCG>',
    };
    expect(userReportKind(smashBug, 'C_REPORTS', 'U_BOT')).toBe('smash-bug');
    // A reply in its thread is neither a report nor a follow-up.
    expect(
      userReportKind(
        { ...smashBug, ts: '2.0', thread_ts: '1.0' },
        'C_REPORTS',
        'U_BOT',
      ),
    ).toBeNull();
    // An app's bug report stays a user report.
    expect(
      userReportKind(
        { ...report, text: ':bug: Bug Report — Clutch: [Market report] x' },
        'C_REPORTS',
        'U_BOT',
      ),
    ).toBe('new');
  });
  it('is disabled when no reports channel is configured', () => {
    expect(userReportKind(report, undefined, 'U_BOT')).toBeNull();
  });
  it('rejects other channels, humans and own posts', () => {
    expect(userReportKind(report, 'C_OTHER', 'U_BOT')).toBeNull();
    expect(
      userReportKind({ ...report, bot_id: undefined }, 'C_REPORTS', 'U_BOT'),
    ).toBeNull();
    expect(userReportKind(report, 'C_REPORTS', 'U_APP')).toBeNull();
    expect(userReportKind(followUp, 'C_REPORTS', 'U_APP')).toBeNull();
  });
});

describe('ownerFollowsThread', () => {
  it('is false for a thread no owner joined', () => {
    expect(
      ownerFollowsThread([{ text: ':envelope: Contact — Clutch: x' }]),
    ).toBe(false);
  });
  it('is true once one owner replied or was mentioned', () => {
    expect(ownerFollowsThread([{ user: 'U09ULJQ2C86', text: 'ok' }])).toBe(
      true,
    );
    expect(
      ownerFollowsThread([{ user: 'U_BOT', text: 'cc <@U0AA6SD1PCG>' }]),
    ).toBe(true);
  });
});
