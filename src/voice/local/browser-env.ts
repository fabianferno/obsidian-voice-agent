// voice/local/browser-env.ts - make the voice worker a plain browser worker.
//
// Obsidian turns on Node integration in Web Workers, so `process` and `require`
// exist there. transformers.js, onnxruntime-web and the ONNX WASM loader all
// check for `process` and, finding it, take their Node code paths
// (onnxruntime-node, fs). Those are not in the browser bundle, so loading a
// model fails with "Cannot read properties of undefined (reading 'wasm')".

export const NODE_GLOBALS = ['process', 'require', 'module', 'global'] as const;

/**
 * Removes the Node globals from `scope` (delete, or set to undefined when the
 * property cannot be deleted). Returns the names that could not be hidden.
 */
export function hideNodeGlobals(scope: Record<string, unknown>): string[] {
  const left: string[] = [];
  for (const name of NODE_GLOBALS) {
    if (scope[name] === undefined) continue;
    try {
      delete scope[name];
    } catch {
      // Not configurable; try overwriting below.
    }
    if (scope[name] !== undefined) {
      try {
        scope[name] = undefined;
      } catch {
        // Read-only.
      }
    }
    if (scope[name] !== undefined) left.push(name);
  }
  return left;
}
