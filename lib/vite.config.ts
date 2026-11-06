// Builds lib/embed.ts against upstream's source. build-lib.sh copies this directory into the upstream checkout first.
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { ftlBare } from '../scripts/ftl-plugin.ts';
import { fileOf } from '../vite.config.ts';

export default defineConfig({
  base: './',
  // Holds only the fonts: build-lib.sh copies them here so the stylesheet's /fonts/ URLs become relative.
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [ftlBare()],
  build: {
    target: 'es2022',
    outDir: 'dist-embed',
    assetsDir: '',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4096,
    license: { fileName: 'THIRD-PARTY-LICENSES.txt' },
    rollupOptions: {
      input: { 'tlo-embed': resolve(import.meta.dirname, 'embed.ts') },
      preserveEntrySignatures: 'strict',
      checks: { ineffectiveDynamicImport: false },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: (asset) => (asset.names.some((n) => n.endsWith('.css')) ? 'tlo-embed.css' : '[name]-[hash][extname]'),
        // As upstream: one file, with only the languages, the templates and the map fetched when asked for.
        codeSplitting: { groups: [{ name: 'app', test: (id: string) => fileOf(id) === 'app' }] },
      },
    },
  },
});
