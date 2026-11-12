// voice/local/cleanup.ts - removes model files earlier versions downloaded.
//
// 0.1.x spoke with Kokoro, whose model and voices (about 100 MB) sit in the
// same browser cache as the Whisper model. Updating the plugin does not touch
// that cache, so delete Kokoro's entries and leave Whisper's alone.

const CACHE = 'transformers-cache';

/** Returns how many cached files were removed. */
export async function removeOldKokoroModels(storage: CacheStorage | undefined = window.caches): Promise<number> {
  if (!storage || !(await storage.has(CACHE))) return 0;
  const cache = await storage.open(CACHE);
  let removed = 0;
  for (const req of await cache.keys()) {
    if (/kokoro/i.test(req.url) && (await cache.delete(req))) removed++;
  }
  return removed;
}
