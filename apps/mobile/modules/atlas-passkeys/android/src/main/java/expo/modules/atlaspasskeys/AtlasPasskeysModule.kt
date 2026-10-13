package expo.modules.atlaspasskeys

import android.os.Build
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Passkeys through Android's Credential Manager. It takes and returns WebAuthn JSON as is
 * (`PublicKeyCredentialCreationOptionsJSON` in, `RegistrationResponseJSON` out, and the same for
 * assertions), so the PRF extension the server's options request reaches the passkey provider
 * unchanged, and its output comes back in `clientExtensionResults.prf.results`. The JS side
 * (`src/auth/passkeyAuthenticator.ts`) reads the output from there and strips it before anything is
 * sent.
 *
 * Credential Manager only lets the app use a domain's passkeys when that domain's
 * `/.well-known/assetlinks.json` names this package and signing certificate (the server's
 * `ANDROID_APP_PACKAGE` / `ANDROID_APP_CERT_SHA256`).
 */
class AtlasPasskeysModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AtlasPasskeys")

    // Passkeys in Credential Manager need Android 9 (API 28).
    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.P }

    AsyncFunction("createAsync") Coroutine { requestJson: String ->
      val activity = appContext.currentActivity ?: throw NoActivityException()
      try {
        val response = CredentialManager.create(activity)
          .createCredential(activity, CreatePublicKeyCredentialRequest(requestJson))
        (response as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
          ?: throw PasskeyException("unexpected credential type", null)
      } catch (e: CreateCredentialCancellationException) {
        throw PasskeyCancelledException(e)
      } catch (e: CreateCredentialException) {
        throw PasskeyException("${e.type}: ${e.errorMessage ?: ""}", e)
      }
    }

    AsyncFunction("getAsync") Coroutine { requestJson: String ->
      val activity = appContext.currentActivity ?: throw NoActivityException()
      try {
        val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
        val credential = CredentialManager.create(activity).getCredential(activity, request).credential
        (credential as? PublicKeyCredential)?.authenticationResponseJson
          ?: throw PasskeyException("unexpected credential type", null)
      } catch (e: GetCredentialCancellationException) {
        throw PasskeyCancelledException(e)
      } catch (e: NoCredentialException) {
        throw NoPasskeyException(e)
      } catch (e: GetCredentialException) {
        throw PasskeyException("${e.type}: ${e.errorMessage ?: ""}", e)
      }
    }
  }
}

private class NoActivityException : CodedException("ERR_NO_ACTIVITY", "no current activity", null)

private class PasskeyCancelledException(cause: Throwable) :
  CodedException("ERR_PASSKEY_CANCELLED", "the passkey prompt was dismissed", cause)

private class NoPasskeyException(cause: Throwable) :
  CodedException("ERR_NO_PASSKEY", "no passkey for this account on this device", cause)

private class PasskeyException(message: String, cause: Throwable?) :
  CodedException("ERR_PASSKEY", message, cause)
