import { ApiClient, type ApiClientOptions } from "@atlastodo/client-core";
import { loadServerUrl } from "../auth/serverUrl";
import { blobFetch } from "../lib/blobFetch";

/**
 * Build the app's `ApiClient` from `@atlastodo/client-core`. This adds resolving the user's server URL
 * first (the client binds its base URL at construction) and the platform's fetch for attachment
 * blobs (`blobFetch`: Expo's native fetch on Android and iOS, the default in a browser).
 *
 * Token options are passed at construction because the `tokenStore` is read-only on the client: a
 * 401 rotates the refresh token through it, and the app must persist the new pair or the next cold
 * start signs the user out. `AuthProvider` is the caller.
 */
export async function createApiClient(
  opts: Omit<ApiClientOptions, "baseUrl"> = {},
): Promise<ApiClient> {
  return new ApiClient({ baseUrl: await loadServerUrl(), blobFetch, ...opts });
}
