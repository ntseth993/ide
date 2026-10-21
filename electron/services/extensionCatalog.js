/**
 * Bundled extension catalog.
 *
 * These are TRUSTED SAMPLE extensions that ship with NovaCode. They are
 * clearly labelled as examples: no publisher verification, no download
 * counts, no remote marketplace. Contributions are declarative data only
 * (theme colors, editor snippets, formatter flags) - extension code is
 * never executed, which is how untrusted extensions stay isolated in v0.2.
 *
 * A remote registry can be configured later; it must serve the same
 * manifest shape documented in docs/EXTENSIONS.md.
 */

const CATALOG = [
  {
    manifest: {
      id: 'novacode-samples.nova-nebula-theme',
      name: 'Nebula Theme (Example)',
      publisher: 'novacode-samples',
      version: '1.0.0',
      description: '[Example] A deep-space dark palette built on NovaCode CSS variables.',
      categories: ['themes'],
      engines: { nova: '>=0.2.0' },
      permissions: [],
      contributes: {
        themes: [
          {
            id: 'nebula-dark',
            label: 'Nebula Dark',
            base: 'dark',
            colors: {
              '--bg': '#05060f',
              '--panel': '#0b0e1f',
              '--surface': '#121631',
              '--text': '#e6e6f0',
              '--muted': '#8f93b8',
              '--border': 'rgba(150,150,220,0.18)',
            },
          },
        ],
      },
    },
    recommended: true,
    popular: false,
  },
  {
    manifest: {
      id: 'novacode-samples.js-snippets',
      name: 'JavaScript Snippets (Example)',
      publisher: 'novacode-samples',
      version: '1.1.0',
      description: '[Example] Tab-completable JavaScript snippets: nfn, ncls, nfor, tryc.',
      categories: ['snippets'],
      engines: { nova: '>=0.2.0' },
      permissions: [],
      contributes: {
        snippets: {
          javascript: [
            {
              prefix: 'nfn',
              description: 'function skeleton',
              body: 'function ${1:name}(${2:params}) {\n\t${0}\n}',
            },
            {
              prefix: 'ncls',
              description: 'class skeleton',
              body: 'class ${1:Name} {\n\tconstructor(${2:params}) {\n\t\t${0}\n\t}\n}',
            },
            {
              prefix: 'nfor',
              description: 'for-of loop',
              body: 'for (const ${1:item} of ${2:items}) {\n\t${0}\n}',
            },
            {
              prefix: 'tryc',
              description: 'try/catch block',
              body: 'try {\n\t${1}\n} catch (${2:error}) {\n\tconsole.error(${2:error});\n}',
            },
          ],
        },
      },
    },
    recommended: false,
    popular: true,
  },
  {
    manifest: {
      id: 'novacode-samples.trim-whitespace',
      name: 'Trim Whitespace on Save (Example)',
      publisher: 'novacode-samples',
      version: '1.0.0',
      description: '[Example] Built-in formatter that strips trailing whitespace whenever a file is saved.',
      categories: ['formatters'],
      engines: { nova: '>=0.2.0' },
      permissions: [],
      contributes: {
        formatters: [
          { id: 'trim-whitespace', label: 'Trim trailing whitespace', languages: ['*'], trimTrailingWhitespace: true },
        ],
      },
    },
    recommended: true,
    popular: true,
  },
];

module.exports = { CATALOG };
