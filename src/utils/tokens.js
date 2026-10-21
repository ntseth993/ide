/** Compact + exact formatting for AI token budgets. */

export function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}

function trim(x) {
  return (Math.round(x * 100) / 100).toString();
}

export function formatExact(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

/** Mask a token like nova_abcd…wxyz, keeping head and tail readable. */
export function maskToken(token) {
  const s = String(token || '');
  if (s.length <= 12) return s;
  return `${s.slice(0, 9)}…${s.slice(-4)}`;
}
