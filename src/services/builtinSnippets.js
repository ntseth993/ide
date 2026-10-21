/**
 * Built-in code snippet shortcuts.
 *
 * NovaCode ships a small, curated library of prefix-triggered snippets so that
 * typing e.g. `fn` + completion inserts a ready skeleton with tab stops — the
 * "code shortcuts" people expect from an IDE, with no extension required.
 * Marketplace/bundled extensions can add more; both feed the same Monaco
 * completion provider (see App.jsx).
 *
 * Bodies use Monaco's snippet syntax: $1, ${2:placeholder}, and
 * ${3|a,b,c|} choices, so Tab walks the placeholders after insertion.
 */

const lines = (...parts) => parts.join('\n');

/** Snippets every language gets, with the comment marker substituted. */
function commonSnippets(comment) {
  return [
    {
      prefix: 'todo',
      description: 'TODO note with owner and task',
      body: lines(`${comment} TODO: ${'$1what needs doing'}`, `${comment} Owner: ${'$2me'}`),
    },
    {
      prefix: 'fixme',
      description: 'FIXME marker with reason',
      body: lines(`${comment} FIXME: ${'$1broken thing'}`, `${comment} Reason: ${'$2why'}`),
    },
    {
      prefix: 'note',
      description: 'Section banner comment',
      body: lines(
        `${comment} ------------------------------------------------------------------`,
        `${comment} ${'$1Section name'}`,
        `${comment} ------------------------------------------------------------------`,
      ),
    },
    {
      prefix: 'lic',
      description: 'File header with name and purpose',
      body: lines(
        `${comment} ${'$1file.js'}`,
        `${comment} ${'$2One-line purpose'}`,
        `${comment} Author: ${'$3me'}`,
      ),
    },
  ];
}

export const BUILTIN_SNIPPETS = {
  javascript: [
    ...commonSnippets('//'),
    { prefix: 'fn', description: 'Function declaration', body: lines('function ${1:name}(${2:params}) {', '\t$3', '}') },
    { prefix: 'afn', description: 'Arrow function', body: 'const ${1:name} = (${2:params}) => ${3:expr};' },
    { prefix: 'asyn', description: 'Async function with try/catch', body: lines(
      'async function ${1:name}(${2:params}) {',
      '\ttry {',
      '\t\t$3',
      '\t} catch (error) {',
      '\t\tconsole.error(${1:name} failed, error);',
      '\t}',
      '}',
    ) },
    { prefix: 'log', description: 'Logged value', body: 'console.log(\'${1:label}\', ${2:value});' },
    { prefix: 'imp', description: 'ESM import', body: 'import { ${1:name} } from \'${2:module}\';' },
    { prefix: 'forof', description: 'for…of loop', body: lines('for (const ${1:item} of ${2:items}) {', '\t$3', '}') },
    { prefix: 'fori', description: 'Indexed for loop', body: lines('for (let ${1:i} = 0; ${1:i} < ${2:items}.length; ${1:i}++) {', '\tconst ${3:item} = ${2:items}[${1:i}];', '\t$4', '}') },
    { prefix: 'mapf', description: 'Map and filter a list', body: 'const ${1:result} = ${2:items}.filter((${3:item}) => ${4:cond}).map((${3:item}) => ${5:value});' },
    { prefix: 'if', description: 'If block', body: lines('if (${1:condition}) {', '\t$2', '}') },
    { prefix: 'ife', description: 'If / else', body: lines('if (${1:condition}) {', '\t$2', '} else {', '\t$3', '}') },
    { prefix: 'sw', description: 'Switch statement', body: lines(
      'switch (${1:value}) {',
      '\tcase ${2:a}:',
      '\t\t$3',
      '\t\tbreak;',
      '\tdefault:',
      '\t\t$4',
      '}',
    ) },
    { prefix: 'cls', description: 'Class with constructor', body: lines(
      'class ${1:Name} {',
      '\tconstructor(${2:params}) {',
      '\t\t$3',
      '\t}',
      '',
      '\t${4:method}(${5:args}) {',
      '\t\t$6',
      '\t}',
      '}',
    ) },
    { prefix: 'fetchj', description: 'Fetch JSON with error handling', body: lines(
      'async function load${1:Data}() {',
      '\tconst response = await fetch(${2:\'/api/resource\'});',
      '\tif (!response.ok) throw new Error(`Request failed: ${response.status}`);',
      '\treturn response.json();',
      '}',
    ) },
    { prefix: 'test', description: 'Test block', body: lines('describe(\'${1:unit}\', () => {', '\tit(\'${2:should do something}\', () => {', '\t\t$3', '\t});', '});') },
  ],

  typescript: [
    ...commonSnippets('//'),
    { prefix: 'fn', description: 'Typed function', body: lines('function ${1:name}(${2:params}: ${3:string}): ${4:void} {', '\t$5', '}') },
    { prefix: 'asyn', description: 'Async function with try/catch', body: lines(
      'async function ${1:name}(${2:params}): Promise<${3:result}> {',
      '\ttry {',
      '\t\t$4',
      '\t} catch (error) {',
      '\t\tconsole.error(error);',
      '\t\tthrow error;',
      '\t}',
      '}',
    ) },
    { prefix: 'int', description: 'Interface', body: lines('interface ${1:Name} {', '\t${2:field}: ${3:string};', '}') },
    { prefix: 'typ', description: 'Type alias', body: 'type ${1:Name} = ${2:string};' },
    { prefix: 'enu', description: 'Enum', body: lines('enum ${1:Name} {', '\t${2:A} = \'${3:a}\',', '}') },
    { prefix: 'gen', description: 'Generic helper', body: lines('function ${1:identity}<T>(value: T): T {', '\treturn value;', '}') },
    { prefix: 'prop', description: 'React props component', body: lines(
      'type ${1:Card}Props = {',
      '\t${2:title}: ${3:string};',
      '};',
      '',
      'export function ${1:Card}({ ${2:title} }: ${1:Card}Props) {',
      '\treturn <div>$4</div>;',
      '}',
    ) },
    { prefix: 'hook', description: 'Custom hook', body: lines(
      'export function use${1:Value}(${2:initial}: ${3:number}) {',
      '\tconst [value, setValue] = useState(${2:initial});',
      '\treturn { value, setValue };',
      '}',
    ) },
    { prefix: 'log', description: 'Logged value', body: 'console.log(\'${1:label}\', ${2:value});' },
    { prefix: 'imp', description: 'ESM import', body: 'import { ${1:name} } from \'${2:module}\';' },
    { prefix: 'if', description: 'If block', body: lines('if (${1:condition}) {', '\t$2', '}') },
    { prefix: 'mapf', description: 'Map list', body: 'const ${1:result} = ${2:items}.map((${3:item}) => ${4:value});' },
  ],

  python: [
    ...commonSnippets('#'),
    { prefix: 'def', description: 'Function with docstring', body: lines(
      'def ${1:name}(${2:params}):',
      '\t"""${3:One-line summary.}"""',
      '\t$4',
    ) },
    { prefix: 'cl', description: 'Class with init', body: lines(
      'class ${1:Name}:',
      '\tdef __init__(self, ${2:params}):',
      '\t\tself.${3:attr} = ${2:params}',
      '',
      '\tdef ${4:method}(self):',
      '\t\t$5',
    ) },
    { prefix: 'main', description: 'Module entry point', body: lines(
      'def main() -> None:',
      '\t$1',
      '',
      '',
      'if __name__ == "__main__":',
      '\tmain()',
    ) },
    { prefix: 'prn', description: 'Print debug', body: 'print(${1:value}, file=sys.stderr)' },
    { prefix: 'imp', description: 'Import module', body: 'import ${1:module}' },
    { prefix: 'from', description: 'From import', body: 'from ${1:package} import ${2:name}' },
    { prefix: 'if', description: 'If block', body: lines('if ${1:condition}:', '\t$2') },
    { prefix: 'ife', description: 'If / else', body: lines('if ${1:condition}:', '\t$2', 'else:', '\t$3') },
    { prefix: 'for', description: 'For loop', body: lines('for ${1:item} in ${2:items}:', '\t$3') },
    { prefix: 'rng', description: 'Range loop', body: lines('for ${1:i} in range(${2:count}):', '\t$3') },
    { prefix: 'wh', description: 'While loop', body: lines('while ${1:condition}:', '\t$2') },
    { prefix: 'try', description: 'Try / except', body: lines(
      'try:',
      '\t$1',
      'except ${2:ValueError} as error:',
      '\tprint(f"failed: {error}")',
      '\t$3',
    ) },
    { prefix: 'wit', description: 'Context-managed file', body: lines('with open(${1:"path.txt"}, "${2:r}", encoding="utf-8") as ${3:f}:', '\t${4:content} = ${3:f}.read()') },
    { prefix: 'listc', description: 'List comprehension', body: '${1:result} = [${2:expr} for ${3:item} in ${4:items} if ${5:cond}]' },
    { prefix: 'datac', description: 'Dataclass', body: lines(
      '@dataclass',
      'class ${1:Point}:',
      '\t${2:x}: ${3:int}',
      '\t${4:y}: ${3:int}',
    ) },
    { prefix: 'test', description: 'pytest test', body: lines(
      'def test_${1:behaviour}():',
      '\t${2:result} = ${3:call()}',
      '\tassert ${2:result} == ${4:expected}',
    ) },
  ],

  html: [
    ...commonSnippets('<!-- ${1:note} -->'),
    { prefix: 'doc', description: 'HTML5 boilerplate', body: lines(
      '<!DOCTYPE html>',
      '<html lang="${1:en}">',
      '<head>',
      '\t<meta charset="utf-8" />',
      '\t<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '\t<title>${2:Page}</title>',
      '\t<link rel="stylesheet" href="${3:styles.css}" />',
      '</head>',
      '<body>',
      '\t$4',
      '</body>',
      '</html>',
    ) },
    { prefix: 'div', description: 'Div with class', body: '<div class="${1:name}">$2</div>' },
    { prefix: 'sec', description: 'Semantic section', body: lines('<section class="${1:name}">', '\t<h2>${2:Heading}</h2>', '\t$3', '</section>') },
    { prefix: 'a', description: 'Anchor', body: '<a href="${1:#}">${2:link text}</a>' },
    { prefix: 'img', description: 'Accessible image', body: '<img src="${1:source}" alt="${2:description}" width="${3:600}" />' },
    { prefix: 'btn', description: 'Button', body: '<button type="${1|button,submit,reset|}" class="${2:name}">$3</button>' },
    { prefix: 'form', description: 'Form with labels', body: lines(
      '<form action="${1:/submit}" method="${2:post}" class="${3:name}">',
      '\t<label for="${4:field}">${5:Label}</label>',
      '\t<input id="${4:field}" name="${4:field}" type="${6:text}" required />',
      '\t<button type="submit">${7:Send}</button>',
      '</form>',
    ) },
    { prefix: 'ul', description: 'Unordered list', body: lines('<ul>', '\t<li>${1:item}</li>', '\t<li>$2</li>', '</ul>') },
    { prefix: 'table', description: 'Table with header', body: lines(
      '<table class="${1:name}">',
      '\t<thead>',
      '\t\t<tr><th>${2:Column}</th></tr>',
      '\t</thead>',
      '\t<tbody>',
      '\t\t<tr><td>$3</td></tr>',
      '\t</tbody>',
      '</table>',
    ) },
    { prefix: 'meta', description: 'Meta viewport', body: '<meta name="viewport" content="width=device-width, initial-scale=1" />' },
  ],

  css: [
    ...commonSnippets('/* ${1:note} */'),
    { prefix: 'flexc', description: 'Flex center', body: lines('display: flex;', 'align-items: center;', 'justify-content: ${1:center};', 'gap: ${2:0.75rem};') },
    { prefix: 'gridc', description: 'Responsive grid', body: lines('display: grid;', 'grid-template-columns: repeat(auto-fit, minmax(${1:220px}, 1fr));', 'gap: ${2:1rem};') },
    { prefix: 'media', description: 'Media query', body: lines('@media (max-width: ${1:900px}) {', '\t$2', '}') },
    { prefix: 'vars', description: 'Custom properties block', body: lines(':root {', '\t--${1:name}: ${2:#7c5cff};', '\t--${3:spacing}: ${4:0.5rem};', '}') },
    { prefix: 'btn', description: 'Button style', body: lines('.${1:button} {', '\tdisplay: inline-flex;', '\talign-items: center;', '\tgap: 0.5rem;', '\tpadding: 0.5rem 1rem;', '\tborder: 1px solid var(--${2:border});', '\tborder-radius: ${3:10px};', '\tbackground: var(--${4:accent});', '\tcursor: pointer;', '\ttransition: transform 150ms ease, box-shadow 150ms ease;', '}', '', '.${1:button}:hover {', '\ttransform: translateY(-1px);', '}') },
    { prefix: 'keyf', description: 'Keyframes + usage', body: lines('@keyframes ${1:fade-in} {', '\tfrom { opacity: 0; }', '\tto { opacity: 1; }', '}', '', '.${2:target} {', '\tanimation: ${1:fade-in} ${3:240ms} ease-out both;', '}') },
    { prefix: 'reset', description: 'Modern reset', body: lines('*, *::before, *::after { box-sizing: border-box; }', 'body {', '\tmargin: 0;', '\tfont-family: ${1:system-ui}, sans-serif;', '\tline-height: 1.5;', '}') },
  ],

  json: [
    { prefix: 'obj', description: 'Object', body: lines('{', '\t"${1:key}": ${2:null}', '}') },
    { prefix: 'arr', description: 'Array', body: lines('[', '\t${1:value}', ']') },
    { prefix: 'pkg', description: 'package.json skeleton', body: lines(
      '{',
      '\t"name": "${1:my-package}",',
      '\t"version": "0.1.0",',
      '\t"type": "module",',
      '\t"main": "${2:index.js}",',
      '\t"scripts": {',
      '\t\t"dev": "${3:vite}",',
      '\t\t"test": "${4:vitest run}"',
      '\t}',
      '}',
    ) },
  ],

  markdown: [
    { prefix: 'h', description: 'Heading with rule', body: lines('# ${1:Title}', '', '${2:Intro sentence}', '') },
    { prefix: 'link', description: 'Link', body: '[${1:text}](${2:https://example.com})' },
    { prefix: 'code', description: 'Fenced code block', body: lines('```${1:js}', '${2:code}', '```') },
    { prefix: 'table', description: 'Table', body: lines('| ${1:Column} | ${2:Column} |', '| --- | --- |', '| ${3:value} | ${4:value} |') },
    { prefix: 'list', description: 'Bullet list', body: lines('- ${1:item}', '- ${2:item}', '- ${3:item}') },
    { prefix: 'task', description: 'Task list', body: lines('- [ ] ${1:task}', '- [ ] ${2:task}', '- [x] ${3:done}') },
    { prefix: 'note', description: 'Callout', body: lines('> [!NOTE]', '> ${1:Something worth knowing.}') },
  ],

  shell: [
    ...commonSnippets('#'),
    { prefix: 'sheb', description: 'Bash script header', body: lines('#!/usr/bin/env bash', 'set -euo pipefail', '', '$1') },
    { prefix: 'if', description: 'If block', body: lines('if [[ ${1:condition} ]]; then', '\t$2', 'fi') },
    { prefix: 'for', description: 'For loop', body: lines('for ${1:item} in ${2:items}; do', '\techo "$${1:item}"', '\t$3', 'done') },
    { prefix: 'fn', description: 'Shell function', body: lines('${1:name}() {', '\t$2', '}') },
    { prefix: 'chk', description: 'Require a command', body: lines('if ! command -v ${1:node} >/dev/null 2>&1; then', '\techo "${1:node} is required" >&2', '\texit 1', 'fi') },
  ],

  go: [
    ...commonSnippets('//'),
    { prefix: 'main', description: 'Main program', body: lines('package main', '', 'import "fmt"', '', 'func main() {', '\t${1:fmt.Println("hello")}', '}') },
    { prefix: 'fn', description: 'Function', body: lines('func ${1:name}(${2:params} ${3:int}) ${4:error} {', '\t$5', '}') },
    { prefix: 'err', description: 'Error check', body: lines('if err != nil {', '\treturn fmt.Errorf("${1:context}: %%w", err)', '}') },
    { prefix: 'for', description: 'Range loop', body: lines('for ${1:i}, ${2:v} := range ${3:items} {', '\t$4', '}') },
    { prefix: 'st', description: 'Struct', body: lines('type ${1:Name} struct {', '\t${2:Field} ${3:string}', '}') },
  ],

  sql: [
    { prefix: 'sel', description: 'Select with limit', body: 'select ${1:*} from ${2:table} where ${3:cond} limit ${4:50};' },
    { prefix: 'ins', description: 'Insert row', body: 'insert into ${1:table} (${2:columns}) values ($3);' },
    { prefix: 'upd', description: 'Update guarded', body: lines('update ${1:table}', 'set ${2:column} = ${3:value}', 'where ${4:id} = ${5:1};') },
    { prefix: 'cre', description: 'Create table', body: lines('create table ${1:name} (', '\tid integer primary key autoincrement,', '\t${2:title} text not null,', '\tcreated_at text not null default current_timestamp', ');') },
    { prefix: 'idx', description: 'Create index', body: 'create index if not exists ${1:idx_name} on ${2:table} (${3:column});' },
  ],
};

/** Monaco ids that reuse another language's snippets. */
const SNIPPET_ALIASES = {
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  scss: 'css',
  less: 'css',
  py: 'python',
};

/** Snippets for a language id (following aliases), or an empty list. */
export function getBuiltinSnippets(languageId) {
  const direct = BUILTIN_SNIPPETS[languageId];
  if (direct) return direct;
  const alias = SNIPPET_ALIASES[languageId];
  return (alias && BUILTIN_SNIPPETS[alias]) || [];
}

export function isCustomSnippet(snippet) {
  return Boolean(snippet && snippet.prefix && snippet.body);
}

/** Flat list for documentation UI: [{ language, prefix, description }]. */
export function listSnippetShortcutEntries() {
  return Object.entries(BUILTIN_SNIPPETS).flatMap(([language, snippets]) => (
    snippets.map((snippet) => ({ language, prefix: snippet.prefix, description: snippet.description }))
  ));
}

/**
 * Merge the built-in shortcuts with snippets contributed by enabled
 * extensions, grouped by Monaco language id. Both sources stay available when
 * they share a prefix (Monaco lists them side by side, and the detail line
 * shows where each came from); only exact repeats are collapsed.
 * @param {Array<Record<string, Array>>} extensionSnippets list of contribution maps
 * @returns {Map<string, Array<{prefix, body, description, source}>>}
 */
export function mergeSnippetsByLanguage(extensionSnippets = []) {
  const merged = new Map();
  const add = (languageId, snippets, source) => {
    if (!languageId || !Array.isArray(snippets)) return;
    const list = merged.get(languageId) || [];
    for (const snippet of snippets) {
      if (!snippet || !snippet.prefix || !snippet.body) continue;
      list.push({
        prefix: String(snippet.prefix),
        body: String(snippet.body),
        description: snippet.description || '',
        source,
      });
    }
    merged.set(languageId, list);
  };

  for (const [languageId, snippets] of Object.entries(BUILTIN_SNIPPETS)) add(languageId, snippets, 'NovaCode');
  for (const byLanguage of extensionSnippets) {
    if (!byLanguage || typeof byLanguage !== 'object') continue;
    for (const [languageId, snippets] of Object.entries(byLanguage)) add(languageId, snippets, 'extension');
  }

  // De-duplicate exact prefix+source repeats (extensions can be re-enabled).
  for (const [languageId, list] of merged) {
    const seen = new Set();
    const unique = list.filter((snippet) => {
      const key = `${snippet.source}:${snippet.prefix}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    merged.set(languageId, unique);
  }

  // Dialect ids (tsx, scss, …) reuse the same shortcut set as their base.
  for (const [alias, target] of Object.entries(SNIPPET_ALIASES)) {
    if (merged.has(alias) || !merged.has(target)) continue;
    merged.set(alias, merged.get(target));
  }
  return merged;
}
