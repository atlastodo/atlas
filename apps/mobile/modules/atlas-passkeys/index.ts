import { requireOptionalNativeModule } from "expo";

interface AtlasPasskeys {
  /** Whether this Android release can use passkeys through Credential Manager (API 28+). */
  isSupported(): boolean;
  /** `PublicKeyCredentialCreationOptionsJSON` in, `RegistrationResponseJSON` out. */
  createAsync(requestJson: string): Promise<string>;
  /** `PublicKeyCredentialRequestOptionsJSON` in, `AuthenticationResponseJSON` out. */
  getAsync(requestJson: string): Promise<string>;
}

/** The Android module, or null where it is not built in (iOS, the web, tests). */
export const Passkeys = requireOptionalNativeModule<AtlasPasskeys>("AtlasPasskeys");
