// The plugin calls window.setTimeout (Obsidian's popout-safe timers). Under
// node there is no window, so point it at the global object; fake timers
// installed on globalThis then apply to window.* calls too.
const g = globalThis as unknown as { window?: unknown };
g.window ??= globalThis;
