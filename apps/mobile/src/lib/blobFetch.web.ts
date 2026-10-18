import type { FetchLike } from "@atlastodo/client-core";

/**
 * The browser's own fetch already streams a `Blob` request body and a response body, so blob
 * requests need nothing special here (see `blobFetch.ts` for the native build).
 */
export const blobFetch: FetchLike | undefined = undefined;
