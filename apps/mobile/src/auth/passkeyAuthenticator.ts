import { Platform } from "react-native";
import {
  PasskeyCancelledError,
  type PasskeyAssertionResponse,
  type PasskeyAuthenticator,
  type PasskeyRegistrationResponse,
} from "@atlastodo/client-core";
import { Passkeys } from "../../modules/atlas-passkeys";
import { NoPasskeyError, prfOutputOf } from "./passkeyJson";

export { NoPasskeyError };

function mapError(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ERR_PASSKEY_CANCELLED") throw new PasskeyCancelledError(err);
  if (code === "ERR_NO_PASSKEY") throw new NoPasskeyError();
  throw err;
}

/**
 * Android's Credential Manager (the app's `modules/atlas-passkeys`), which speaks WebAuthn JSON
 * natively. iOS is not supported yet: null there, and wherever the module is missing.
 */
const android: PasskeyAuthenticator = {
  async create(options) {
    let json: string;
    try {
      json = await Passkeys!.createAsync(JSON.stringify(options));
    } catch (err) {
      mapError(err);
    }
    const credential = JSON.parse(json) as PasskeyRegistrationResponse;
    credential.clientExtensionResults ??= {};
    return { credential, prfOutput: prfOutputOf(credential) };
  },
  async get(options) {
    let json: string;
    try {
      json = await Passkeys!.getAsync(JSON.stringify(options));
    } catch (err) {
      mapError(err);
    }
    const credential = JSON.parse(json) as PasskeyAssertionResponse;
    credential.clientExtensionResults ??= {};
    return { credential, prfOutput: prfOutputOf(credential) };
  },
};

/** This device's passkey support, or null when it has none the app can use. */
export function getPasskeyAuthenticator(): PasskeyAuthenticator | null {
  if (Platform.OS !== "android" || !Passkeys) return null;
  try {
    return Passkeys.isSupported() ? android : null;
  } catch {
    return null;
  }
}
