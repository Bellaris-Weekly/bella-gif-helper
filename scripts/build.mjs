import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function readMetadata(header) {
  return Object.fromEntries(['version', 'updateURL', 'downloadURL'].map((key) => {
    const value = header.match(new RegExp(`^// @${key}\\s+(\\S+)`, 'm'))?.[1];
    if (!value) throw new Error(`Missing @${key}`);
    return [key, value];
  }));
}

// 与 bella-live-clip 共用同一个 Secret 与日志服务。
// 仓库里提交的产物是普通构建：不含日志地址，上报与反馈都关闭。
// 发布构建（--release，仅在 CI 的 upload job 里运行）从 LOG_SERVICE_CONFIG 注入地址并补 @connect。
export function resolveLogService({ release = false, env = process.env, header }) {
  if (!release) return { endpoint: '', header };
  let config;
  try {
    config = JSON.parse(env.LOG_SERVICE_CONFIG);
  } catch {
    throw new Error('发布构建需要有效的 LOG_SERVICE_CONFIG Secret。');
  }
  const domain = config?.worker?.domain;
  if (
    typeof domain !== 'string'
    || domain.length > 253
    || !domain.includes('.')
    || !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('LOG_SERVICE_CONFIG.worker.domain 必须是域名，不含协议、端口、路径或凭据。');
  }
  const connections = [...header.matchAll(/^\/\/ @connect\s+(\S+)\s*$/gm)].map((match) => match[1]);
  const nextHeader = connections.includes(domain)
    ? header
    : header.replace(/^(\/\/ @connect\s+.*\n)(?!\/\/ @connect)/m, `$1// @connect      ${domain}\n`);
  return { endpoint: `https://${domain}/v1/logs`, header: nextHeader };
}

export function userscriptBuildOptions({ release = false, env = process.env, write = true } = {}) {
  const sourceHeader = readFileSync(path.join(root, 'src/header.txt'), 'utf8');
  const { endpoint, header } = resolveLogService({ release, env, header: sourceHeader });
  return {
    absWorkingDir: root,
    entryPoints: ['src/main.js'],
    outfile: 'bella-gif-helper.user.js',
    write,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: false,          // 绝对不要开
    legalComments: 'inline',
    charset: 'utf8',
    banner: { js: header },
    define: {
      __SCRIPT_METADATA__: JSON.stringify(readMetadata(header)),
      __LOG_SERVICE_ENDPOINT__: JSON.stringify(endpoint),
    },
    loader: { '.css': 'text', '.html': 'text' },
    logLevel: 'warning',
  };
}

export function buildUserscript(options) {
  return build(userscriptBuildOptions(options));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUserscript({ release: process.argv.includes('--release') }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
