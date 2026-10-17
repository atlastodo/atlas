import type { ReactNode } from "react";
import type { Keyring, Session } from "@atlastodo/client-core";
import { useAuth } from "./AuthContext";
import { LoginScreen } from "./LoginScreen";
import { LocalUpgradeGate } from "./LocalUpgradeGate";
import { RecoveryKeyPrompt } from "./RecoveryKeyPrompt";
import { RecoveryPhraseModal } from "./RecoveryPhraseModal";
import { UnlockScreen } from "./UnlockScreen";
import { UpdateRequiredScreen } from "./UpdateRequiredScreen";
import { useLocalMode } from "./localMode";

/** What the app mounts for: a signed-in, unlocked account, or local-only mode on this device. */
export type GateState =
  { mode: "account"; session: Session; keyring: Keyring } | { mode: "local"; deviceId: string };

/**
 * Everything that must be settled before the app (and its store and sync) may mount: a server that
 * refuses this build's sync protocol shows the update screen, and a locked session (signed in, no
 * unwrapped keys) the unlock screen. The account app renders only with both a session and a
 * keyring, so sync never starts without keys, and only after any local-only data has been moved
 * into the account (`LocalUpgradeGate`). An account without a registered recovery key is also
 * asked, without blocking the app, to confirm its phrase.
 *
 * With no session the app runs in local-only mode (see `localMode.tsx`), unless the sign-in screen
 * was asked for. Without a `LocalModeProvider` (tests) there is no local mode: the sign-in screen.
 *
 * Lives under `src/` so it is testable without the router.
 */
export function AuthGate({ children }: { children: (state: GateState) => ReactNode }) {
  const { session, keyring, recoveryPhrase, dismissRecoveryPhrase, upgradeRequired } = useAuth();
  const local = useLocalMode();

  if (upgradeRequired) return <UpdateRequiredScreen />;
  if (!session) {
    if (local && !local.authScreen) {
      return <>{children({ mode: "local", deviceId: local.deviceId })}</>;
    }
    return (
      <>
        <LoginScreen
          // Keyed so a request for the other form opens it fresh.
          key={local?.authScreen ?? "login"}
          initialMode={local?.authScreen ?? undefined}
          onContinueLocal={local?.closeAuth}
        />
        <RecoveryPhraseModal phrase={recoveryPhrase} onClose={dismissRecoveryPhrase} />
      </>
    );
  }
  if (!keyring) return <UnlockScreen />;
  return (
    <LocalUpgradeGate
      key={session.user.id}
      userId={session.user.id}
      accountLabel={session.user.email}
    >
      {children({ mode: "account", session, keyring })}
      <RecoveryKeyPrompt />
    </LocalUpgradeGate>
  );
}
