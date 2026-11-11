// Modules the bundler generates at build time (see esbuild.config.mjs).

declare module 'virtual:voice-worker' {
  /** The local voice worker, bundled for the browser, as source text. */
  const source: string;
  export default source;
}

declare module 'virtual:ort-glue' {
  /** The ONNX runtime's WASM loader (ESM), as source text. */
  const source: string;
  export default source;
}
