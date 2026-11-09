// All engines share one in-flight Wasm initialization per package URL. A
// rejected initialization must not poison later attempts or evict a newer one.
export function loadSilentWebModule(pkgUrl) {
  const host = (typeof window !== 'undefined') ? window : globalThis;
  const cache = (host.__silentWebModulePromises ||= new Map());
  let promise = cache.get(pkgUrl);
  if (!promise) {
    promise = (async () => {
      const module = await import(pkgUrl);
      await module.default();
      return module;
    })();
    cache.set(pkgUrl, promise);
  }
  return promise.catch(error => {
    if (cache.get(pkgUrl) === promise) cache.delete(pkgUrl);
    throw error;
  });
}
