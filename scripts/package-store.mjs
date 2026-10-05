import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, realpath, copyFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

run(process.execPath, [resolve(root, 'scripts/build.mjs')]);
const dist = resolve(root, 'dist');
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('Invalid extension version');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const output = resolve(root, `release/store-upload-${manifest.version}-${stamp}`);
const unpacked = resolve(output, 'unpacked');
const archive = resolve(output, `gemini-projects-${manifest.version}-webstore-${stamp}.zip`);

// 仅打包清单实际引用的资源，排除 source map、历史脚本和开发文档。
const files = new Set(['manifest.json']);
if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
for (const script of manifest.content_scripts ?? []) {
  for (const file of [...(script.js ?? []), ...(script.css ?? [])]) files.add(file);
}
for (const icons of [manifest.icons, manifest.action?.default_icon]) {
  for (const file of typeof icons === 'string' ? [icons] : Object.values(icons ?? {})) files.add(file);
}
for (const file of files) {
  const source = resolve(dist, file);
  const path = relative(dist, source);
  const stat = await lstat(source);
  const resolvedPath = relative(dist, await realpath(source));
  if (!path || path.startsWith('..') || isAbsolute(path) || !stat.isFile()
      || stat.isSymbolicLink() || resolvedPath.startsWith('..') || isAbsolute(resolvedPath)) {
    throw new Error(`Invalid package resource: ${file}`);
  }
  const target = resolve(unpacked, path);
  await mkdir(dirname(target), { recursive: true });
  if (file.endsWith('.js')) {
    const text = await readFile(source, 'utf8');
    await writeFile(target, text.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ''));
  } else {
    await copyFile(source, target);
  }
}

if (process.platform === 'win32') {
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  run('powershell', ['-NoProfile', '-Command',
    `$ErrorActionPreference = 'Stop'; Compress-Archive -Path ${quote(resolve(unpacked, '*'))} -DestinationPath ${quote(archive)}`]);
} else {
  run('zip', ['-q', '-r', archive, '.'], unpacked);
}
console.log(`Package: ${archive}`);
console.log(`Runtime resources (${files.size}): ${[...files].join(', ')}`);
