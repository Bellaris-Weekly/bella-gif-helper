import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const header = readFileSync('src/header.txt', 'utf8');
const metadata = Object.fromEntries(['version', 'updateURL', 'downloadURL'].map((key) => {
  const value = header.match(new RegExp(`^// @${key}\\s+(\\S+)`, 'm'))?.[1];
  if (!value) throw new Error(`Missing @${key}`);
  return [key, value];
}));

await build({
  entryPoints: ['src/main.js'],
  outfile: 'bella-gif-helper.user.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: false,          // 绝对不要开
  legalComments: 'inline',
  charset: 'utf8',
  banner: { js: header },
  define: { __SCRIPT_METADATA__: JSON.stringify(metadata) },
  loader: { '.css': 'text', '.html': 'text' },  // 供 T7 使用
});
