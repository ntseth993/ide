/** Path helpers that work with Windows and POSIX separators. */

export function normalizePath(value) {
  return value ? String(value).replace(/\\/g, '/') : '';
}

export function joinPath(base, segment) {
  if (!base) return segment;
  const normalizedBase = normalizePath(base).replace(/\/+$/, '');
  const normalizedSegment = normalizePath(segment).replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedSegment}`;
}

export function baseName(value) {
  const normalized = normalizePath(value);
  return normalized.split('/').pop() || '';
}

export function parentPath(value) {
  const normalized = normalizePath(value);
  const segments = normalized.split('/');
  segments.pop();
  return segments.join('/');
}

export function projectName(value) {
  if (!value) return 'No project';
  const name = baseName(value);
  return name || 'Project';
}

/** Fuzzy score for command palette / quick open. Higher is better. */
export function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1;
      score += 2;
    }
  }
  return qi === q.length ? score : -1;
}
