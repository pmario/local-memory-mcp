/**
 * Tests for ACT-R base-level activation in Petrov's hybrid approximation (local-memory-mcp-y0l), d = 0.5:
 * B = ln(t1^-d + (n - 1)(tn^(1-d) - t1^(1-d)) / ((1 - d)(tn - t1))), times in days.
 * Replicate by hand: n = 3, t1 = 1, tn = 9 gives ln(1 + 2 * (3 - 1) / (0.5 * 8)) = ln 2.
 */
import { describe, it, expect } from 'vitest';
import { activation } from './activation.js';

describe('activation', () => {
  it('has no activation for a learning never read', () => {
    expect(activation({ reads: 0, ageDays: 10, lastReadDays: 10 })).toBeNull();
  });

  it('is ln(t1^-0.5) for one read', () => {
    expect(activation({ reads: 1, ageDays: 9, lastReadDays: 4 })).toBeCloseTo(Math.log(0.5), 10);
  });

  it('adds the earlier reads spread evenly between first and last read', () => {
    expect(activation({ reads: 3, ageDays: 9, lastReadDays: 1 })).toBeCloseTo(Math.log(2), 10);
  });

  it('counts every read at the last read time when the span is zero', () => {
    expect(activation({ reads: 4, ageDays: 4, lastReadDays: 4 })).toBeCloseTo(Math.log(4 * 0.5), 10);
  });

  it('ranks a recent last read and more reads higher', () => {
    const base = activation({ reads: 10, ageDays: 40, lastReadDays: 20 })!;
    expect(activation({ reads: 10, ageDays: 40, lastReadDays: 1 })!).toBeGreaterThan(base);
    expect(activation({ reads: 30, ageDays: 40, lastReadDays: 20 })!).toBeGreaterThan(base);
    expect(activation({ reads: 10, ageDays: 400, lastReadDays: 20 })!).toBeLessThan(base);
  });

  it('stays finite for a read this instant and a last read later than the age allows', () => {
    expect(Number.isFinite(activation({ reads: 2, ageDays: 0, lastReadDays: 0 }))).toBe(true);
    expect(activation({ reads: 1, ageDays: 4, lastReadDays: 9 })).toBeCloseTo(Math.log(0.5), 10);
  });
});
