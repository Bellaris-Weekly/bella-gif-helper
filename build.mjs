import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

await build({
  entryPoints: ['src/main.js'],
  outfile: 'bella-gif-helper.user.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: false,          // 绝对不要开
  legalComments: 'inline',
  charset: 'utf8',
  banner: { js: readFileSync('src/header.txt', 'utf8') },
  loader: { '.css': 'text', '.html': 'text' },  // 供 T7 使用
});
