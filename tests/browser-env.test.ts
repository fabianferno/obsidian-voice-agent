import { describe, it, expect } from 'vitest';
import { hideNodeGlobals } from '../src/voice/local/browser-env.js';

describe('hideNodeGlobals', () => {
  it('removes process, require, module and global the way Node defines them', () => {
    const scope: Record<string, unknown> = { self: 1 };
    for (const name of ['process', 'require', 'module', 'global']) {
      Object.defineProperty(scope, name, { value: {}, enumerable: false, writable: true, configurable: true });
    }
    expect(hideNodeGlobals(scope)).toEqual([]);
    expect(typeof scope.process).toBe('undefined');
    expect('require' in scope).toBe(false);
    expect(scope.self).toBe(1);
  });

  it('overwrites a global that cannot be deleted', () => {
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, 'process', { value: {}, writable: true, configurable: false });
    expect(hideNodeGlobals(scope)).toEqual([]);
    expect(typeof scope.process).toBe('undefined');
  });

  it('reports a global it cannot hide', () => {
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, 'process', { value: {}, writable: false, configurable: false });
    expect(hideNodeGlobals(scope)).toEqual(['process']);
  });

  it('does nothing in a plain browser scope', () => {
    expect(hideNodeGlobals({})).toEqual([]);
  });
});
