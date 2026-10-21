/** Language detection from file extensions (drives Monaco syntax modes). */

const extensionLanguageMap = {
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  dart: 'dart',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  gradle: 'groovy',
  lua: 'lua',
  r: 'r',
  ini: 'ini',
  toml: 'ini',
  dockerfile: 'dockerfile',
};

export function getFileExtension(fileName) {
  if (!fileName) return '';
  const base = String(fileName).split(/[\\/]/).pop() || '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const parts = base.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

export function getLanguage(fileName) {
  return extensionLanguageMap[getFileExtension(fileName)] || 'plaintext';
}

/** Single-letter badge shown next to files in the explorer and tabs. */
const typeBadges = {
  javascript: { label: 'JS', tone: 'js' },
  typescript: { label: 'TS', tone: 'ts' },
  json: { label: '{}', tone: 'json' },
  html: { label: '<>', tone: 'html' },
  css: { label: '#', tone: 'css' },
  scss: { label: '#', tone: 'css' },
  less: { label: '#', tone: 'css' },
  python: { label: 'PY', tone: 'py' },
  markdown: { label: 'M', tone: 'md' },
  shell: { label: '$', tone: 'sh' },
  yaml: { label: 'Y', tone: 'md' },
  sql: { label: 'Q', tone: 'json' },
};

export function getTypeBadge(fileName) {
  const language = getLanguage(fileName);
  return typeBadges[language] || { label: '•', tone: 'default' };
}
