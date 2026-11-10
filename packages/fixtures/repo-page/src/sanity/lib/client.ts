/**
 * The client file `sanity init` writes for a Next.js project (src/sanity/lib/client.ts), reduced to
 * the one call the generated page makes: `client.fetch<Result>(query, params)`, as declared by
 * @sanity/client. Nothing here connects to anything.
 */
export const client = {
  fetch<R = unknown>(_query: string, _params?: Record<string, unknown>): Promise<R> {
    return Promise.reject(new Error("The fixture client does not fetch."));
  },
};
