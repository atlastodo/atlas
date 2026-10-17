import type { TFunction } from "i18next";
import {
  PasskeyCancelledError,
  PasskeyPrfUnsupportedError,
  apiErrorCode,
} from "@atlastodo/client-core";
import { NoPasskeyError } from "./passkeyJson";
import { PasskeysUnavailableError } from "./serverCompat";

/** The user-facing text for a passkey failure, or null when `err` is not one. */
export function describePasskeyError(err: unknown, t: TFunction): string | null {
  if (err instanceof PasskeyCancelledError) return t("auth.passkeyCancelled");
  if (err instanceof NoPasskeyError) return t("auth.passkeyNotFound");
  if (err instanceof PasskeysUnavailableError) return t("auth.passkeyServerUnavailable");
  if (err instanceof PasskeyPrfUnsupportedError) return t("auth.passkeyNoPrf");
  switch (apiErrorCode(err)) {
    case "passkey_prf_unsupported":
      return t("auth.passkeyNoPrf");
    case "passkeys_disabled":
      return t("auth.passkeyServerUnavailable");
    case "passkey_invalid":
      return t("auth.passkeyFailed");
    case "last_unlock_method":
      return t("settings.passkeysLastWay");
  }
  return null;
}
