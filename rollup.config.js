const typescript = require('rollup-plugin-typescript2');
const clear = require('rollup-plugin-clear');
const terser = require('@rollup/plugin-terser');
const pkg = require('./package.json');

/**
 * @type {import('rollup').RollupOptions[]}
 */
const config = [
  {
    input: 'src/index.ts',
    output: [
      {
        file: pkg.main,
        format: 'cjs',
        sourcemap: true, // 方便debug
      },
      {
        file: pkg.module,
        format: 'es',
      },
      {
        file: 'dist/index.umd.js',
        name: 'Mobxact',
        format: 'umd',
        globals: {
          mobx: 'mobx',
        },
      },
    ],
    external: [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ],
    plugins: [
      typescript(),
      clear({
        targets: ['dist'],
      }),
      // terser(),
    ],
  },
];

module.exports = config;
