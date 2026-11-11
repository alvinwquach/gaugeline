import type { AdapterFactory } from "./entry.js";

type LoadListener = (id: string) => void;
const loadListeners = new Set<LoadListener>();

/**
 * Calls `listener` with the id of each adapter the first time its code is loaded. The CLI wires it to
 * stderr when GAUGELINE_TRACE_ADAPTER_LOADS=1, which is how the start-up test proves that `--version`,
 * `--help` and a run that names one adapter load no other. Returns a function that removes it.
 */
export function onAdapterLoad(listener: LoadListener): () => void {
  loadListeners.add(listener);
  return () => void loadListeners.delete(listener);
}

/**
 * A loader that imports once, tells the listeners, and tries again if the import failed. Every adapter's
 * `load` is one of these, wrapped around a dynamic `import()` of its own module.
 */
export function lazy(
  id: string,
  importFactory: () => Promise<AdapterFactory>,
): () => Promise<AdapterFactory> {
  let loading: Promise<AdapterFactory> | undefined;
  return () => {
    loading ??= importFactory().then(
      (factory) => {
        for (const listener of loadListeners) listener(id);
        return factory;
      },
      (err: unknown) => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  };
}
