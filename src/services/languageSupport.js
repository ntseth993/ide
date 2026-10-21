/**
 * Language support catalog.
 *
 * Monaco ships built-in tokenizers for all of these languages, so syntax
 * highlighting works out of the box. Diagnostics, intelligent autocomplete,
 * formatting, and debugging beyond Monaco's built-in analysis require
 * external language servers or compilers - that tier is declared here so
 * the UI can be honest about what a language supports today.
 *
 * `runCommand` maps to the integrated terminal for the Run > Run File
 * command; `runtime` names the external tool that tier requires.
 */

export const LANGUAGES = [
  { id: 'plaintext', label: 'Plain Text', highlighting: 'built-in', diagnostics: null, runtime: null },
  {
    id: 'javascript', label: 'JavaScript', highlighting: 'built-in', diagnostics: 'built-in',
    runtime: { id: 'node', label: 'Node.js' }, runCommand: (file) => `node "${file}"`,
  },
  {
    id: 'typescript', label: 'TypeScript', highlighting: 'built-in', diagnostics: 'built-in',
    runtime: { id: 'node', label: 'Node.js + tsc' }, runCommand: null,
  },
  { id: 'json', label: 'JSON', highlighting: 'built-in', diagnostics: 'built-in', runtime: null },
  { id: 'html', label: 'HTML', highlighting: 'built-in', diagnostics: 'built-in', runtime: null },
  { id: 'css', label: 'CSS', highlighting: 'built-in', diagnostics: 'built-in', runtime: null },
  { id: 'scss', label: 'SCSS', highlighting: 'built-in', diagnostics: 'built-in', runtime: null },
  { id: 'less', label: 'Less', highlighting: 'built-in', diagnostics: 'built-in', runtime: null },
  {
    id: 'python', label: 'Python', highlighting: 'built-in', diagnostics: 'language-server',
    runtime: { id: 'python', label: 'Python 3' }, runCommand: (file) => `python "${file}"`,
  },
  {
    id: 'java', label: 'Java', highlighting: 'built-in', diagnostics: 'language-server',
    runtime: { id: 'java', label: 'JDK 11+' }, runCommand: (file) => `java "${file}"`,
  },
  { id: 'c', label: 'C', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'gcc', label: 'gcc' }, runCommand: null },
  { id: 'cpp', label: 'C++', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'gpp', label: 'g++' }, runCommand: null },
  { id: 'csharp', label: 'C#', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'dotnet', label: '.NET SDK' }, runCommand: null },
  {
    id: 'php', label: 'PHP', highlighting: 'built-in', diagnostics: 'language-server',
    runtime: { id: 'php', label: 'PHP 8' }, runCommand: (file) => `php "${file}"`,
  },
  { id: 'dart', label: 'Dart', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'dart', label: 'Dart SDK' }, runCommand: null },
  { id: 'go', label: 'Go', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'go', label: 'Go toolchain' }, runCommand: null },
  { id: 'rust', label: 'Rust', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'rustc', label: 'rustc / cargo' }, runCommand: null },
  { id: 'ruby', label: 'Ruby', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'ruby', label: 'Ruby' }, runCommand: (file) => `ruby "${file}"` },
  { id: 'sql', label: 'SQL', highlighting: 'built-in', diagnostics: null, runtime: { id: 'sqlite', label: 'sqlite3 (CLI)' }, runCommand: null },
  { id: 'kotlin', label: 'Kotlin', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'kotlinc', label: 'Kotlin compiler' }, runCommand: null },
  { id: 'swift', label: 'Swift', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'swift', label: 'Swift toolchain' }, runCommand: null },
  {
    id: 'shell', label: 'Shell Script', highlighting: 'built-in', diagnostics: null,
    runtime: { id: 'bash', label: 'bash' }, runCommand: (file) => `bash "${file}"`,
  },
  {
    id: 'powershell', label: 'PowerShell', highlighting: 'built-in', diagnostics: null,
    runtime: { id: 'powershell', label: 'PowerShell' }, runCommand: (file) => `powershell -NoProfile -File "${file}"`,
  },
  { id: 'markdown', label: 'Markdown', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'yaml', label: 'YAML', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'xml', label: 'XML', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'ini', label: 'INI / TOML', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'lua', label: 'Lua', highlighting: 'built-in', diagnostics: 'language-server', runtime: { id: 'lua', label: 'Lua' }, runCommand: null },
  { id: 'bat', label: 'Batch', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'dockerfile', label: 'Dockerfile', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'groovy', label: 'Groovy', highlighting: 'built-in', diagnostics: null, runtime: null },
  { id: 'r', label: 'R', highlighting: 'built-in', diagnostics: null, runtime: { id: 'rscript', label: 'R' }, runCommand: null },
];

const byId = new Map(LANGUAGES.map((language) => [language.id, language]));

/** Language ids offered by the editor language selector, sorted by label. */
export function listLanguageOptions() {
  return [...LANGUAGES]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ id, label }) => ({ id, label }));
}

/** Terminal command for Run > Run File, or null when unsupported. */
export function languageRunCommand(languageId, filePath) {
  const language = byId.get(languageId);
  if (!language || typeof language.runCommand !== 'function') return null;
  return language.runCommand(filePath);
}

/** Human-readable capability summary used in tooltips and settings. */
export function languageCapability(languageId) {
  const language = byId.get(languageId);
  if (!language) return 'Syntax highlighting via built-in tokenizer.';
  const parts = ['Syntax highlighting: built-in'];
  if (language.diagnostics === 'built-in') parts.push('diagnostics: built-in');
  if (language.diagnostics === 'language-server') parts.push('full tooling: requires an installed language server');
  if (language.runtime) parts.push(`run/debug tier: ${language.runtime.label}`);
  return parts.join(' · ');
}
