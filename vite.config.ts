import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export default defineConfig(({ command }) => {
  const build = command === 'build' ? new Date().toISOString().replace(/[:.]/g, '-') : 'development';
  return {
    define: { 'import.meta.env.VITE_APP_BUILD': JSON.stringify(build) },
    plugins: [react(), {
      name: 'private-diagnostic-source-maps',
      generateBundle: { order: 'post', async handler(_options, bundle) {
        // Maps only need to outlive the 14-day client diagnostic logs they decode.
        const root = resolve('.runtime/client-sourcemaps'), cutoff = new Date(Date.now() - 14 * 86400_000).toISOString().replace(/[:.]/g, '-');
        for (const old of await readdir(root).catch(() => [] as string[])) if (/^\d{4}-\d{2}-\d{2}T/.test(old) && old < cutoff) await rm(resolve(root, old), { recursive: true, force: true });
        for (const [name, item] of Object.entries(bundle)) if (item.type === 'asset' && name.endsWith('.map')) {
          const file = resolve('.runtime/client-sourcemaps', build, name);
          await mkdir(dirname(file), { recursive: true }); await writeFile(file, item.source);
          delete bundle[name];
        }
      } },
    }],
    build: { target: 'es2022', sourcemap: 'hidden' },
  };
});
