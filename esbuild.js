const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    loader: {
      '.wasm': 'file',  // Ensure WASM files are treated as assets
    },
    assetNames: '[name]', // Keep the original name of WASM files
    plugins: [
      esbuildProblemMatcherPlugin
    ],
  });

  // Copy mappings.wasm after build
  if (!watch) {
    await ctx.rebuild();
    copyMappingsWasm();
    await ctx.dispose();
  } else {
    await ctx.watch();
  }
}

function copyMappingsWasm() {
  const wasmSourcePath = path.resolve(__dirname, 'node_modules/source-map/lib/mappings.wasm');
  const wasmDestPath = path.resolve(__dirname, 'dist/mappings.wasm');

  fs.copyFileSync(wasmSourcePath, wasmDestPath);
  console.log('Copied mappings.wasm to dist folder');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  }
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
