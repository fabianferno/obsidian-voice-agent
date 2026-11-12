// voice/local/hide-node.ts - imported first by the worker, so the Node globals
// are gone before transformers.js and the ONNX runtime look for them.
// See browser-env.ts.

import { hideNodeGlobals } from './browser-env.js';

export const nodeGlobalsLeft = hideNodeGlobals(self as unknown as Record<string, unknown>);
