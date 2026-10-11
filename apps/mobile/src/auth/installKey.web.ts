/**
 * The web and desktop builds have no identifier that outlives clearing the site's data, so they
 * send no install key: each sign-in there is its own device, as before. See `installKey.ts`.
 */
export async function getInstallKey(): Promise<string | undefined> {
  return undefined;
}
