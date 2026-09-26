/**
 * Re-check signals (local-memory-mcp-w8u) through their API: signalContext() builds what a signal may see,
 * writeNotices() collects write-time notices, assess() scores and flags. A signal is a plugin: one module
 * implementing Signal, listed in SIGNALS; both entry points also take a list, which is how a new signal is tried.
 *
 * Replicate by hand (node, from the repo root, after npm run build):
 *   const s = await import('./dist/signals/index.js');
 *   s.writeNotices(s.signalContext(['Probe at E:/tmp/p.js, probably.'], 'research'))  // two notices
 *   s.assess(s.signalContext(['v1', 'v1\n\nMore.'], 'insight'))                         // score 2, not flagged
 */
import { describe, it, expect } from 'vitest';
import { SIGNALS, FLAG_SCORE, signalContext, writeNotices, assess, type Signal } from './index.js';
import { hedge } from './hedge.js';
import { hedgeRomance } from './hedge-romance.js';

const notices = (text: string, previous?: string) => writeNotices(signalContext(previous === undefined ? [text] : [previous, text], 'research'));

describe('writeNotices', () => {
  it('names each scratch path once: drive letter, backslashes and POSIX', () => {
    const [n] = notices('Probe at e:/tmp/toc/import-probe.js and E:\\tmp\\x.mjs, again e:/tmp/toc/import-probe.js; log in `/tmp/out/a.txt`.');
    expect(n).toContain('(e:/tmp/toc/import-probe.js, E:\\tmp\\x.mjs, /tmp/out/a.txt)');
  });

  it('ignores kept paths and words that only contain tmp', () => {
    expect(notices('Kept at ~/.beads-planning/TiddlyWiki5/keep/probe.js; the tmpfile option and C:/Users/tmpuser.')).toEqual([]);
  });

  it('names each hedge once, lowercased, and stays quiet on a measured statement', () => {
    expect(notices('It Probably holds, and likely on Windows too; it probably does.')[0]).toContain('(probably, likely)');
    expect(notices('Measured 2026-09-26: 3 of 3 runs returned 0.')).toEqual([]);
  });

  it('finds hedges in German, Spanish, Catalan, Portuguese, Italian and French, accented ones included', () => {
    const hedges = (text: string) => notices(text)[0] ?? '';
    expect(hedges('Der Aufruf schlägt vermutlich fehl, möglicherweise nur unter Windows.')).toContain('(vermutlich, möglicherweise)');
    expect(hedges('La llamada probablemente falla; parece que solo en Windows.')).toContain('(probablemente, parece que)');
    expect(hedges('La crida probablement falla; sembla que només a Windows.')).toContain('(probablement, sembla que)');
    expect(hedges('A chamada provavelmente falha, possivelmente só no Windows.')).toContain('(provavelmente, possivelmente)');
    expect(hedges('La chiamata probabilmente fallisce; sembra che accada solo su Windows.')).toContain('(probabilmente, sembra che)');
    expect(hedges("L'appel échoue présumément, sans doute sous Windows.")).toContain('(présumément, sans doute)');
  });

  it('keeps English and German in hedge and the five Romance languages in hedge-romance', () => {
    const fires = (signal: Signal, text: string) => signal.fires(signalContext([text], 'research'));
    expect([fires(hedge, 'It probably holds.'), fires(hedgeRomance, 'It probably holds.')]).toEqual([true, false]);
    expect([fires(hedge, 'Es gilt vermutlich.'), fires(hedgeRomance, 'Es gilt vermutlich.')]).toEqual([true, false]);
    expect([fires(hedge, 'Vale probablemente.'), fires(hedgeRomance, 'Vale probablemente.')]).toEqual([false, true]);
  });

  it('ignores a hedge inside quotation marks, where a verbatim quote has to keep it', () => {
    expect(notices('The maintainer reported: "There seems to be a problem with the front matter."')).toEqual([]);
    expect(notices('Er schrieb „das scheint kaputt“ und «il semble cassé» und “it probably fails”.')).toEqual([]);
    expect(notices('He wrote "it fails" and it probably does.')[0]).toContain('(probably)');
  });

  it('matches whole words only, and leaves out the Italian false friend possibilmente', () => {
    expect(notices('Die Wahrscheinlichkeit wurde gemessen: 3 von 3.')).toEqual([]);
    expect(notices('Rispondere possibilmente entro domani.')).toEqual([]);
    expect(notices('A likelyhood-free parser; improbably named.')).toEqual([]);
  });

  it('notices paragraphs added anywhere to an old text, not a rewrite or an added link', () => {
    expect(notices('Rule.\n\nCase.\n\nLater finding.\n\nRelated: [[aaaaaaaa]].', 'Rule.\n\nCase.\n\nRelated: [[aaaaaaaa]].')[0]).toContain('first line');
    expect(notices('Rule, restated.\n\nCase.\n\nMore.', 'Rule.\n\nCase.')).toEqual([]);
    expect(notices('Rule.\n\nRelated: [[bbbbbbbb]] (a neighbour).', 'Rule.')).toEqual([]);
    expect(notices('Rule.\n\nPart of [[cccccccc]] (the hub).', 'Rule.')).toEqual([]);
  });
});

describe('assess', () => {
  it('passes a single-source doc harvest that never grew', () => {
    expect(assess(signalContext(['The X operator returns Y. From editions/tw5.com/tiddlers/x.tid, read 2026-08-17.'], 'research'))).toEqual({
      score: 0,
      hard: [],
      flagged: false,
    });
  });

  it('flags an entry grown over sessions with a story and a closing maxim', () => {
    const first = 'A cache keeps stale data after a reload. Found 2026-07-01 (HANDOFF_A_one_2026-07-01.md).';
    const grown = [
      first,
      'Found twice: on 2026-07-09 the maintainer reported it again (HANDOFF_B_two_2026-07-09.md), and on 2026-07-20 we saw it in CI.',
      'Always question every cache you did not build yourself.',
    ].join('\n\n');
    const a = assess(signalContext([first, grown], 'insight', []));
    // append, growth, handoffs, dates, story, owner, maxim and work-session fire; branch does not.
    expect(a).toEqual({ score: 8, hard: [], flagged: true });
  });

  it('flags a scratch path on its own, while a hedge adds one point', () => {
    expect(assess(signalContext(['Kept in E:/tmp/probe.js. From the docs.'], 'research'))).toEqual({ score: 0, hard: ['scratch'], flagged: true });
    expect(assess(signalContext(['It probably retries. From the docs.'], 'research'))).toEqual({ score: 1, hard: [], flagged: false });
  });

  it('counts a configured owner name like "the maintainer"', () => {
    const score = (text: string, names: string[]) => assess(signalContext([text], 'research', names)).score;
    expect(score('Rule. Ruled by Mario on 2026-09-01.', [])).toBe(0);
    expect(score('Rule. Ruled by Mario on 2026-09-01.', ['Mario'])).toBe(1);
    expect(score('Rule. The maintainer ruled it.', [])).toBe(1);
  });
});

describe('the plugin contract', () => {
  it('takes a signal list, so a new signal is tried without touching the callers', () => {
    const shouting: Signal = {
      id: 'shouting',
      kind: 'hard',
      fires: (ctx) => /\b[A-Z]{5,}\b/.test(ctx.text),
      notice: (ctx) => (/\b[A-Z]{5,}\b/.test(ctx.text) ? 'The text shouts.' : null),
    };
    const ctx = signalContext(['NEVER do this.'], 'research');
    expect(assess(ctx, [shouting])).toEqual({ score: 0, hard: ['shouting'], flagged: true });
    expect(writeNotices(ctx, [shouting])).toEqual(['The text shouts.']);
    expect(assess(ctx, [...SIGNALS])).toEqual(assess(ctx));
  });

  it('adds a score signal by its weight against the flag threshold', () => {
    const heavy: Signal = { id: 'heavy', kind: 'score', weight: FLAG_SCORE, fires: () => true };
    expect(assess(signalContext(['Any text.'], 'research'), [heavy])).toEqual({ score: FLAG_SCORE, hard: [], flagged: true });
  });

  it('registers each signal once, under a unique id', () => {
    const ids = SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIGNALS.every((s) => s.kind === 'hard' || s.kind === 'score')).toBe(true);
  });
});
