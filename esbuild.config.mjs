// Builds main.js for Obsidian.
//
//   node esbuild.config.mjs              watch mode (development)
//   node esbuild.config.mjs production   one minified build
//
// Set OBSIDIAN_PLUGIN_DIR to a vault's .obsidian/plugins/<id> folder to copy
// main.js, manifest.json and styles.css there after each build.

import esbuild from 'esbuild';
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import path from 'path';

const prod = process.argv[2] === 'production';
const TRANSFORMERS = 'node_modules/@huggingface/transformers';
const DIST = `${TRANSFORMERS}/dist`;

const transformersVersion = JSON.parse(readFileSync(`${TRANSFORMERS}/package.json`, 'utf8')).version;
const wasmSha256 = createHash('sha256').update(readFileSync(`${DIST}/ort-wasm-simd-threaded.jsep.wasm`)).digest('hex');

async function buildWorker() {
  const out = await esbuild.build({
    entryPoints: ['src/voice/local/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  return out.outputFiles[0].text;
}

const virtual = {
  name: 'virtual',
  setup(build) {
    build.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: 'virtual' }));
    build.onLoad({ filter: /.*/, namespace: 'virtual' }, async (args) => {
      if (args.path === 'virtual:voice-worker') return { contents: await buildWorker(), loader: 'text', watchDirs: ['src/voice/local'] };
      if (args.path === 'virtual:ort-glue') return { contents: readFileSync(`${DIST}/ort-wasm-simd-threaded.jsep.mjs`, 'utf8'), loader: 'text' };
      return null;
    });
  },
};

const copyToVault = {
  name: 'copy-to-vault',
  setup(build) {
    build.onEnd((result) => {
      const dir = process.env.OBSIDIAN_PLUGIN_DIR;
      if (!dir || result.errors.length) return;
      mkdirSync(dir, { recursive: true });
      for (const f of ['main.js', 'manifest.json', 'styles.css']) {
        if (existsSync(f)) copyFileSync(f, path.join(dir, f));
      }
      console.log(`Copied to ${dir}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/plugin/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  define: {
    ORT_WASM_SHA256: JSON.stringify(wasmSha256),
    TRANSFORMERS_VERSION: JSON.stringify(transformersVersion),
  },
  plugins: [virtual, copyToVault],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  treeShaking: true,
  logLevel: 'info',
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
