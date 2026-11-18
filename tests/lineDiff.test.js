import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  changesBetween,
  applyChange,
  applyChanges,
  fromLines,
} from '../src/utils/lineDiff';

const A = ['line1', 'line2', 'line3', 'line4'].join('\n');

describe('lineDiff.computeDiff', () => {
  it('reports zero counts for identical text', () => {
    expect(computeDiff(A, A)).toMatchObject({ added: 0, removed: 0, changes: 0 });
  });

  it('counts a pure addition', () => {
    const addedText = ['line1', 'line2', 'bonus', 'line3', 'line4'].join('\n');
    expect(computeDiff(A, addedText)).toMatchObject({ added: 1, removed: 0, changes: 1 });
  });

  it('counts a pure deletion', () => {
    const removedText = ['line1', 'line3', 'line4'].join('\n');
    expect(computeDiff(A, removedText)).toMatchObject({ added: 0, removed: 1, changes: 1 });
  });

  it('counts a modification as one remove + one add', () => {
    const changed = ['line1', 'CHANGED', 'line3', 'line4'].join('\n');
    expect(computeDiff(A, changed)).toMatchObject({ added: 1, removed: 1, changes: 1 });
  });

  it('counts independent change runs separately', () => {
    const twoSpots = ['X', 'line2', 'line3', 'Y'].join('\n');
    expect(computeDiff(A, twoSpots).changes).toBe(2);
  });
});

describe('lineDiff application', () => {
  it('applying every change reconstructs the proposed text exactly', () => {
    const proposed = ['line1', 'CHANGED', 'bonus', 'line4'].join('\n');
    const changes = changesBetween(A, proposed);
    expect(applyChanges(A, changes)).toBe(proposed);
  });

  it('applying no change preserves the original verbatim', () => {
    const proposed = ['X', 'line2', 'line3'].join('\n');
    const changes = changesBetween(A, proposed);
    const merged = applyChanges(A, changes, () => false);
    expect(merged).toBe(A);
  });

  it('accepting one change while rejecting others is independent', () => {
    const proposed = ['AAA', 'line2', 'line3', 'line4', 'BBB'].join('\n');
    const changes = changesBetween(A, proposed);
    expect(changes).toHaveLength(2);
    const onlyFirst = applyChanges(A, changes, (c) => c === changes[0]);
    expect(onlyFirst.split('\n')).toEqual(['AAA', 'line2', 'line3', 'line4']);
    const onlyLast = applyChanges(A, changes, (c) => c === changes[1]);
    expect(onlyLast.split('\n')).toEqual(['line1', 'line2', 'line3', 'line4', 'BBB']);
  });

  it('applyChange splices a single run onto the base', () => {
    const proposed = ['line1', 'CHANGED', 'line3', 'line4'].join('\n');
    const [change] = changesBetween(A, proposed);
    expect(applyChange(A, change)).toBe(proposed);
  });

  it('recomputing after one accept shrinks the remaining changes', () => {
    const proposed = ['AAA', 'line2', 'line3', 'BBB'].join('\n');
    const changes = changesBetween(A, proposed);
    const step1 = applyChange(A, changes[0]);
    // Base advanced: only the second region still differs.
    expect(changesBetween(step1, proposed)).toHaveLength(1);
    expect(fromLines(changesBetween(step1, proposed)[0].nLines)).toBe('BBB');
  });

  it('change signatures are stable so a rejection survives a recompute', () => {
    const proposed = ['line1', 'line2', 'line3', 'ZZZ'].join('\n');
    const before = changesBetween(A, proposed)[0].signature;
    const after = changesBetween(A, proposed)[0].signature;
    expect(before).toBe(after);
  });
});
