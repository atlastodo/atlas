import {
  PasskeyCancelledError,
  bytesToBase64Url,
  decodeBase64Url,
  type PasskeyAssertionResponse,
  type PasskeyAuthenticator,
  type PasskeyCreationOptions,
  type PasskeyDescriptor,
  type PasskeyPrfInputs,
  type PasskeyRegistrationResponse,
  type PasskeyRequestOptions,
} from "@atlastodo/client-core";

import { NoPasskeyError } from "./passkeyJson";

export { NoPasskeyError };

const buf = (b64url: string): ArrayBuffer => {
  const bytes = decodeBase64Url(b64url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const b64 = (data: ArrayBuffer | ArrayBufferView): string =>
  bytesToBase64Url(
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );

const descriptors = (list: PasskeyDescriptor[] | undefined) =>
  list?.map((d) => ({
    type: d.type,
    id: buf(d.id),
    ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  }));

function prfInputs(prf: PasskeyPrfInputs | undefined) {
  if (!prf) return undefined;
  const values = (v: { first: string; second?: string }) => ({
    first: buf(v.first),
    ...(v.second ? { second: buf(v.second) } : {}),
  });
  return {
    ...(prf.eval ? { eval: values(prf.eval) } : {}),
    ...(prf.evalByCredential
      ? {
          evalByCredential: Object.fromEntries(
            Object.entries(prf.evalByCredential).map(([id, v]) => [id, values(v)]),
          ),
        }
      : {}),
  };
}

type PrfClientOutputs = { enabled?: boolean; results?: { first?: ArrayBuffer } };

function extensionResults(credential: PublicKeyCredential) {
  const ext = credential.getClientExtensionResults() as {
    prf?: PrfClientOutputs;
    credProps?: { rk?: boolean };
  };
  const first = ext.prf?.results?.first;
  return {
    // JSON-safe outputs only; the PRF output is returned apart and never serialized.
    json: {
      ...(ext.credProps ? { credProps: ext.credProps } : {}),
      ...(ext.prf
        ? { prf: ext.prf.enabled !== undefined ? { enabled: ext.prf.enabled } : {} }
        : {}),
    } as Record<string, unknown>,
    prfOutput: first ? new Uint8Array(first) : null,
  };
}

/** NotAllowedError is how a browser reports a dismissed, timed-out or unanswerable prompt. */
function mapError(err: unknown): never {
  if (
    err instanceof DOMException &&
    (err.name === "NotAllowedError" || err.name === "AbortError")
  ) {
    throw new PasskeyCancelledError(err);
  }
  throw err;
}

const web: PasskeyAuthenticator = {
  async create(options: PasskeyCreationOptions) {
    let credential: PublicKeyCredential;
    try {
      credential = (await navigator.credentials.create({
        publicKey: {
          challenge: buf(options.challenge),
          rp: options.rp,
          user: { ...options.user, id: buf(options.user.id) },
          pubKeyCredParams: options.pubKeyCredParams,
          timeout: options.timeout,
          excludeCredentials: descriptors(options.excludeCredentials),
          authenticatorSelection: options.authenticatorSelection as
            AuthenticatorSelectionCriteria | undefined,
          attestation: (options.attestation ?? "none") as AttestationConveyancePreference,
          extensions: {
            ...(options.extensions?.credProps ? { credProps: true } : {}),
            ...(options.extensions?.prf ? { prf: prfInputs(options.extensions.prf) } : {}),
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;
    } catch (err) {
      mapError(err);
    }
    const response = credential.response as AuthenticatorAttestationResponse;
    const { json, prfOutput } = extensionResults(credential);
    const result: PasskeyRegistrationResponse = {
      id: credential.id,
      rawId: b64(credential.rawId),
      type: "public-key",
      response: {
        clientDataJSON: b64(response.clientDataJSON),
        attestationObject: b64(response.attestationObject),
        transports:
          typeof response.getTransports === "function" ? response.getTransports() : undefined,
      },
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: json,
    };
    return { credential: result, prfOutput };
  },

  async get(options: PasskeyRequestOptions) {
    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.get({
        publicKey: {
          challenge: buf(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: (options.userVerification ?? "required") as UserVerificationRequirement,
          allowCredentials: descriptors(options.allowCredentials),
          extensions: (options.extensions?.prf
            ? { prf: prfInputs(options.extensions.prf) }
            : {}) as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
    } catch (err) {
      mapError(err);
    }
    if (!credential) throw new NoPasskeyError();
    const response = credential.response as AuthenticatorAssertionResponse;
    const { json, prfOutput } = extensionResults(credential);
    const result: PasskeyAssertionResponse = {
      id: credential.id,
      rawId: b64(credential.rawId),
      type: "public-key",
      response: {
        clientDataJSON: b64(response.clientDataJSON),
        authenticatorData: b64(response.authenticatorData),
        signature: b64(response.signature),
        userHandle: response.userHandle ? b64(response.userHandle) : null,
      },
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: json,
    };
    return { credential: result, prfOutput };
  },
};

/** Inside the Electron desktop app, whose preload exposes `window.atlasDesktop`. */
function isDesktopApp(): boolean {
  return (window as unknown as { atlasDesktop?: unknown }).atlasDesktop != null;
}

/**
 * The browser's WebAuthn, or null where passkeys cannot work: no WebAuthn, or the desktop app,
 * whose `app://atlas-todo` origin no relying party (the server's domain) can match.
 */
export function getPasskeyAuthenticator(): PasskeyAuthenticator | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  if (isDesktopApp()) return null;
  if (typeof window.PublicKeyCredential === "undefined" || !navigator.credentials) return null;
  if (!window.isSecureContext) return null;
  return web;
}
