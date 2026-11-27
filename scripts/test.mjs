import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const testsDir = resolve(rootDir, 'tests');

const entries = (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

if (!entries.length) {
  throw new Error('No *.test.ts files found in tests/');
}

const tempOutDir = await mkdtemp(join(tmpdir(), 'gemini-projects-tests-'));

try {
  const input = Object.fromEntries(
    entries.map((name) => [basename(name, '.ts'), resolve(testsDir, name)])
  );

  await build({
    configFile: false,
    root: rootDir,
    logLevel: 'silent',
    publicDir: false,
    build: {
      target: 'node20',
      outDir: tempOutDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input,
        external: [/^node:/],
        output: {
          entryFileNames: '[name].mjs',
          format: 'es'
        }
      }
    }
  });

  const testFiles = entries.map((name) => resolve(tempOutDir, `${basename(name, '.ts')}.mjs`));
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(tempOutDir, { recursive: true, force: true });
}
