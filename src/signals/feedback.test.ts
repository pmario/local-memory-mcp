/**
 * Signals as feedback (local-memory-mcp-zpz): each signal names the check it predicts a failure of, what it matched,
 * and a write-time notice prefixed with that check. owner and work-session are priors: they score, but give no reason.
 * Replicate by hand: memory_learn({category: "pattern", content: "The cache turned out stale.", style: ["atomic", "factual"]})
 * answers with notice "factual: The text tells how it was found (turned out): …".
 */
import { describe, it, expect } from 'vitest';
import { SIGNALS, signalContext, writeNotices, firedSignals, reasons } from './index.js';

const ctx = (text: string, category = 'pattern', previous?: string[]) => signalContext([...(previous ?? []), text], category, ['Mario']);
const signal = (id: string) => SIGNALS.find((s) => s.id === id)!;

describe('signal checks', () => {
  it('maps each signal to the check it predicts, and owner and work-session to none', () => {
    const checks = Object.fromEntries(SIGNALS.map((s) => [s.id, s.check ?? null]));
    expect(checks).toEqual({
      scratch: 'factual',
      hedge: 'factual',
      'hedge-romance': 'factual',
      story: 'factual',
      maxim: 'factual',
      branch: 'factual',
      append: 'atomic',
      growth: 'atomic',
      dates: 'atomic',
      handoffs: 'atomic',
      owner: null,
      'work-session': null,
    });
  });
});

describe('what a signal matched, and its notice', () => {
  const cases: Array<[string, ReturnType<typeof ctx>, string[], string]> = [
    ['story', ctx('The cache turned out stale.'), ['turned out'], 'factual: '],
    ['maxim', ctx('Claim with `code` 3.\n\nAlways keep things simple and clean.'), ['Always keep things simple and clean.'], 'factual: '],
    ['branch', ctx('Built from branch feat/x-y at its head.'), ['branch feat/x-y'], 'factual: '],
    ['dates', ctx('Runs on 2026-01-01, 2026-01-02 and 2026-01-03.'), ['2026-01-01', '2026-01-02', '2026-01-03'], 'atomic: '],
    ['handoffs', ctx('See HANDOFF_a.md and HANDOFF_b.md.'), ['HANDOFF_a.md', 'HANDOFF_b.md'], 'atomic: '],
    ['growth', ctx('x'.repeat(145), 'pattern', ['x'.repeat(100)]), ['+45%'], 'atomic: '],
  ];
  for (const [id, c, matched, prefix] of cases) {
    it(`${id} names ${matched.join(', ')} and gives a ${prefix.trim()} notice naming it`, () => {
      expect(signal(id).fires(c)).toBe(true);
      expect(signal(id).matches!(c)).toEqual(matched);
      const notice = signal(id).notice!(c);
      expect(notice).not.toBeNull();
      expect(notice).toContain(matched[0]);
    });
  }

  it('prefixes every write-time notice with its check', () => {
    expect(writeNotices(ctx('It probably holds; see E:/tmp/p.js.'))).toEqual([
      expect.stringMatching(/^factual: .*E:\/tmp\/p\.js/),
      expect.stringMatching(/^factual: .*probably/),
    ]);
  });

  it('gives no notice for owner or work-session', () => {
    const c = ctx('Mario ruled it so, measured 2026-01-01 in `x.js`.', 'workflow');
    expect(signal('owner').fires(c)).toBe(true);
    expect(signal('work-session').fires(c)).toBe(true);
    expect(writeNotices(c)).toEqual([]);
  });
});

describe('scratch paths: tmp and temp', () => {
  const found = (text: string) => signal('scratch').matches!(ctx(text));

  it('finds a tmp or temp directory anywhere in a drive path, any case', () => {
    expect(found('Probe E:\\temp\\a.js ran.')).toEqual(['E:\\temp\\a.js']);
    expect(found('Kept in C:\\Users\\Mario\\AppData\\Local\\Temp\\claude\\x.txt.')).toEqual(['C:\\Users\\Mario\\AppData\\Local\\Temp\\claude\\x.txt']);
    expect(found('See e:/tmp/LLMs/p/x.mjs and E:/TMP/y.log.')).toEqual(['e:/tmp/LLMs/p/x.mjs', 'E:/TMP/y.log']);
  });

  it('finds POSIX and environment temp directories', () => {
    expect(found('Logs in /tmp/run.log and /var/tmp/keep.txt.')).toEqual(['/tmp/run.log', '/var/tmp/keep.txt']);
    expect(found('Wrote %TEMP%\\out.json and $TMPDIR/out.json.')).toEqual(['%TEMP%\\out.json', '$TMPDIR/out.json']);
  });

  // Cases from the store on 2026-11-04 (0e35459c, 0ca5d74b, 0105c70b, ca05236a).
  it('ignores a path inside a code span that holds a command, and keeps a code span that is only the path', () => {
    expect(found('Run `npm start -- --storage /tmp/pear-chat-user1 --name user1` in one terminal.')).toEqual([]);
    expect(found('Lint via `node eslint.js --stdin --stdin-filename core/x.js < E:/tmp/.../wt/core/x.js`.')).toEqual([]);
    expect(found('Running `cdp-errors.js 9335` (then in `E:/tmp/fluid-layout/`) dropped a draft.')).toEqual(['E:/tmp/fluid-layout/']);
    expect(found('It failed with actual `C:\\Users\\Mario\\AppData\\Local\\Temp\\fs-1\\Note_1.tid`.')).toEqual([
      'C:\\Users\\Mario\\AppData\\Local\\Temp\\fs-1\\Note_1.tid',
    ]);
  });

  it('pairs code spans left to right, so the prose between two spans is no command', () => {
    expect(found('Each peer gets its own `--storage` and the second starts with `npm start -- --storage /tmp/pear-chat-user2 --name user2`.')).toEqual([]);
  });

  it('ignores a path the writer kept on purpose in a fenced code block', () => {
    expect(found('The spec failed with:\n\n```\nactual C:\\Users\\Mario\\AppData\\Local\\Temp\\fs-1\\Note_1.tid\n```\n\nafter the scan.')).toEqual([]);
  });

  it('tells the writer the fenced code block in the notice', () => {
    expect(signal('scratch').notice!(ctx('Probe in E:/tmp/p.js.'))).toContain('fenced code block');
  });

  it('still finds a bare path next to a command span', () => {
    expect(found('Run `npm start -- --storage /tmp/a`; the log is in /tmp/run.log.')).toEqual(['/tmp/run.log']);
  });

  it('leaves template, temporary and tmp-named files alone', () => {
    expect(found('Read E:/git/templates/a.tid, E:/git/x/temporary/b.js and src/tmp.ts.')).toEqual([]);
  });
});

describe('reasons and fired signals, grouped by check', () => {
  it('lists the fired signals per check, without the priors', () => {
    const c = ctx('Mario says it probably holds on 2026-01-01, 2026-01-02 and 2026-01-03.', 'workflow');
    expect(reasons(c)).toEqual({ factual: ['hedge'], atomic: ['dates'] });
  });

  it('has no reasons for a clean research text', () => {
    expect(reasons(ctx('The walk stops at `import` in 3 of 3 runs.', 'research'))).toEqual({});
  });

  it('groups requested signals with what they matched, a prior under other', () => {
    const c = ctx('Mario: probe in E:/tmp/p.js, built from branch feat/x.', 'workflow');
    expect(firedSignals(c, ['scratch', 'branch', 'owner', 'dates'])).toEqual({
      factual: { scratch: ['E:/tmp/p.js'], branch: ['branch feat/x'] },
      other: { owner: [] },
    });
  });
});
