// 校验 @version 在 src/header.txt、构建产物和 README 之间保持一致。
// 版本号漂移在本项目发生过两次，这里用一条断言把它钉死。
import { readFileSync } from 'node:fs';

const HEADER = 'src/header.txt';
const ARTIFACT = 'bella-gif-helper.user.js';
const README = 'README.md';

function readMetaVersion(path) {
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^\/\/ @version\s+(\S+)\s*$/m);
  if (!match) throw new Error(`${path}: 找不到 @version 元数据行。`);
  return match[1];
}

function readReadmeVersion(path) {
  const text = readFileSync(path, 'utf8');
  const match = text.match(/当前版本为\s*`([^`]+)`/);
  if (!match) throw new Error(`${path}: 找不到「当前版本为 \`x.y.z\`」。`);
  return match[1];
}

const versions = {
  [HEADER]: readMetaVersion(HEADER),
  [ARTIFACT]: readMetaVersion(ARTIFACT),
  [README]: readReadmeVersion(README),
};

const unique = [...new Set(Object.values(versions))];
if (unique.length !== 1) {
  console.error('版本号不一致：');
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${file.padEnd(28)} ${version}`);
  }
  console.error('\n请让三处保持同一个版本号后重试。');
  process.exit(1);
}

console.log(`版本号一致：${unique[0]}`);
