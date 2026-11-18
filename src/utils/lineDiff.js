/**
 * Line-level diff used by the AI diff-review panel.
 *
 * Pure, dependency-free and framework-agnostic so it stays unit-testable. The
 * review needs three things from a diff: an ordered list of rows for a unified
 * view, independent "changes" (contiguous runs of added/removed lines) that a
 * user can accept or reject one at a time, and honest line counts for the
 * summary. We compute an LCS-aligned diff over lines, which is more than enough
 * for whole-file AI proposals and keeps unrelated lines byte-for-byte intact.
 */

const NL = String.fromCharCode(10);
const SEP = String.fromCharCode(1);

/** Split text into display lines without dropping meaningful trailing blanks. */
export function toLines(text) {
  return String(text == null ? '' : text).split(NL);
}

/** Join line arrays back into text. */
export function fromLines(lines) {
  return lines.join(NL);
}

/**
 * Classic LCS diff over two line arrays.
 * Returns an array of { type: 'equal' | 'add' | 'del', line, oldNo, newNo }
 * rows in order, where oldNo/newNo are 1-based positions (0 when absent).
 */
export function diffRows(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  // Guard against pathological sizes; fall back to a whole-file replace so the
  // review never hangs on a multi-thousand-line file.
  if (n * m > 4000000) {
    const rows = oldLines.map((line, i) => ({ type: 'del', line, oldNo: i + 1, newNo: 0 }));
    newLines.forEach((line, j) => rows.push({ type: 'add', line, oldNo: 0, newNo: j + 1 }));
    return rows;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: 'equal', line: oldLines[i], oldNo: i + 1, newNo: j + 1 });
      i += 1; j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', line: oldLines[i], oldNo: i + 1, newNo: 0 });
      i += 1;
    } else {
      rows.push({ type: 'add', line: newLines[j], oldNo: 0, newNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) { rows.push({ type: 'del', line: oldLines[i], oldNo: i + 1, newNo: 0 }); i += 1; }
  while (j < m) { rows.push({ type: 'add', line: newLines[j], oldNo: 0, newNo: j + 1 }); j += 1; }
  return rows;
}

/** Count real additions/removals and independent change runs from a row list. */
export function summarize(rows) {
  let added = 0;
  let removed = 0;
  let changes = 0;
  let inChange = false;
  for (const row of rows) {
    if (row.type === 'add') added += 1;
    else if (row.type === 'del') removed += 1;
    else { inChange = false; continue; }
    if (!inChange) { changes += 1; inChange = true; }
  }
  return { rows, added, removed, changes };
}

/** Convenience wrapper taking raw texts; returns { rows, added, removed, changes }. */
export function computeDiff(oldText, newText) {
  return summarize(diffRows(toLines(oldText), toLines(newText)));
}

/**
 * Group the row list into independent changes so each can be applied on its
 * own. oStart/oCount locate the run within the ORIGINAL text lines; the run is
 * replaced by nLines. Because runs are disjoint and ordered, splicing any subset
 * back into the original is always safe. signature is content-based, so a
 * rejected change stays rejected as the base advances.
 */
export function extractChanges(rows) {
  const changes = [];
  let oldIndex = 0; // 0-based cursor into the original lines
  let newIndex = 0; // 0-based cursor into the proposed lines
  let k = 0;
  while (k < rows.length) {
    if (rows[k].type === 'equal') { oldIndex += 1; newIndex += 1; k += 1; continue; }
    const oStart = oldIndex;
    const nStart = newIndex;
    const oLines = [];
    const nLines = [];
    while (k < rows.length && rows[k].type !== 'equal') {
      if (rows[k].type === 'del') { oLines.push(rows[k].line); oldIndex += 1; }
      else { nLines.push(rows[k].line); newIndex += 1; }
      k += 1;
    }
    changes.push({
      id: `change-${oStart}-${changes.length}`,
      signature: oLines.join(SEP) + SEP + '>' + SEP + nLines.join(SEP),
      oStart,
      nStart,
      oCount: oLines.length,
      nCount: nLines.length,
      oLines,
      nLines,
    });
  }
  return changes;
}

/** Changes for a whole-file (original text -> proposed text) pair. */
export function changesBetween(oldText, newText) {
  return extractChanges(diffRows(toLines(oldText), toLines(newText)));
}

/**
 * Apply a single change (identified against the current base lines) and return
 * the new text. Used for accepting one change at a time.
 */
export function applyChange(baseText, change) {
  const lines = toLines(baseText);
  lines.splice(change.oStart, change.oCount, ...change.nLines);
  return fromLines(lines);
}

/**
 * Merge a set of accepted changes onto the base in one pass. Changes are
 * applied from the bottom up so earlier splice offsets stay valid. `isAccepted`
 * decides, per change, whether it is included; rejected changes leave the
 * original lines untouched, preserving unrelated code exactly.
 */
export function applyChanges(baseText, changes, isAccepted = () => true) {
  const lines = toLines(baseText);
  const ordered = [...changes].sort((a, b) => b.oStart - a.oStart);
  for (const change of ordered) {
    if (!isAccepted(change)) continue;
    lines.splice(change.oStart, change.oCount, ...change.nLines);
  }
  return fromLines(lines);
}
