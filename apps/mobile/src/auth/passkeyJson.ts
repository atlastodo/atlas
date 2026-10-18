import {
  decodeBase64Url,
  type PasskeyAssertionResponse,
  type PasskeyRegistrationResponse,
} from "@atlastodo/client-core";

/** The device holds no passkey for this site (or account). */
export class NoPasskeyError extends Error {
  constructor() {
    super("no passkey for this account on this device");
    this.name = "NoPasskeyError";
  }
}

/**
 * The PRF output a WebAuthn JSON response carries in `clientExtensionResults.prf.results.first`
 * (base64url), as Android's Credential Manager returns it; null when there is none.
 */
export function prfOutputOf(
  credential: Pick<
    PasskeyRegistrationResponse | PasskeyAssertionResponse,
    "clientExtensionResults"
  >,
): Uint8Array | null {
  const prf = credential.clientExtensionResults?.prf as
    { results?: { first?: unknown } } | undefined;
  const first = prf?.results?.first;
  if (typeof first !== "string" || first === "") return null;
  try {
    const bytes = decodeBase64Url(first);
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}
