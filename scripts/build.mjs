import { build } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const contentEntry = resolve(rootDir, 'src/content/index.ts');
const backgroundEntry = resolve(rootDir, 'src/background.ts');

await build({
  configFile: false,
  root: rootDir,
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        content: contentEntry
      },
      output: {
        entryFileNames: 'content.js',
        format: 'iife',
        inlineDynamicImports: true
      }
    }
  }
});

await build({
  configFile: false,
  root: rootDir,
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: backgroundEntry
      },
      output: {
        entryFileNames: 'background.js',
        format: 'es',
        inlineDynamicImports: true
      }
    }
  }
});