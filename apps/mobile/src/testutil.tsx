import { useEffect, useState, type ReactNode } from "react";
import { setStringAsync } from "expo-clipboard";
import {
  ApiError,
  AttachmentQueue,
  LocalStore,
  MemoryPersistence,
  type ApiClient,
  type BlobTransport,
  type Keyring,
} from "@atlas/client-core";
import { AuthContext, type AuthContextValue } from "./auth/AuthContext";
import type { LocalModeValue } from "./auth/localMode";
import {
  StoreContext,
  type AttachmentServerConfig,
  type AttachmentsContextValue,
} from "./data/StoreProvider";
import { SelectionProvider } from "./data/SelectionProvider";
import { SelectionActionsProvider } from "./data/SelectionActionsProvider";
import { CursorProvider } from "./data/CursorProvider";
import { ToastProvider } from "./data/ToastProvider";

/**
 * Test scaffolding for screens that read the store or the session: a real in-memory `LocalStore`
 * and a plain session object, injected through the contexts the app exports for this. No mocks,
 * SQLite or network. `withApp` also wires the `version` bump `StoreProvider` does in production,
 * without which a write would not re-render.
 */

/** The text most recently handed to the `expo-clipboard` double in `jest-setup`, or `null`. */
export function lastCopiedText(): string | null {
  const calls = (setStringAsync as jest.Mock).mock.calls;
  return calls.length === 0 ? null : (calls[calls.length - 1][0] as string);
}

/**
 * An instant later today, for a task that must count as due today. `Date.now() + 1h` is tomorrow
 * after 23:00, so this stays within half of what is left of the local day.
 */
export function laterToday(): number {
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return now + Math.min(3_600_000, Math.floor((midnight.getTime() - now) / 2));
}

/** A session-shaped auth context. Pass `userId` when the screen reads `session.user.id`. */
export function fakeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    session: null,
    sessionRestored: true,
    api: {} as ApiClient,
    keyring: null,
    recoveryPhrase: null,
    dismissRecoveryPhrase: () => {},
    changeServerUrl: async () => {},
    login: async () => {},
    signup: async () => {},
    recoverAccount: async () => {},
    registerRecoveryKey: async () => {},
    replaceRecoveryPhrase: async () => "",
    changePassword: async () => {},
    deleteAccount: async () => {},
    cancelAccountDeletion: async () => {},
    logout: async () => {},
    unlock: async () => true,
    verifyPassword: async () => true,
    upgradeRequired: false,
    retryAfterUpgrade: () => {},
    signOutNotice: null,
    passkeyAuthenticator: null,
    loginWithPasskey: async () => {},
    signupWithPasskey: async () => {},
    confirmWithPasskey: async () => ({ reauthToken: "proof", rootKey: null }),
    unlockWithPasskey: async () => true,
    addPasskey: async () => {},
    removePasskey: async () => {},
    removePassword: async () => {},
    ...overrides,
  };
}

/** A local-only mode state for tests, with spies for its actions. */
export function fakeLocalMode(overrides: Partial<LocalModeValue> = {}): LocalModeValue {
  return {
    deviceId: "00000000-0000-0000-0000-0000000010ca",
    authScreen: null,
    openAuth: jest.fn(),
    closeAuth: jest.fn(),
    upgradeIntent: null,
    setUpgradeIntent: jest.fn(),
    clearUpgradeIntent: jest.fn(),
    resumeOnboarding: false,
    clearResumeOnboarding: jest.fn(),
    ...overrides,
  };
}

/**
 * Wrap a screen in the store + auth + selection contexts, over a real store (the real
 * `SelectionProvider`, which is plain state).
 *
 * `attachments`: pass an object (optionally with a `BlobTransport` double and/or the
 * `MemoryPersistence` to inspect) to build a real `AttachmentQueue` over in-memory durables, or
 * `null` for no queue. Absent means a queue whenever the auth value's keyring allows one.
 */
export interface AttachmentsTestWiring {
  transport?: BlobTransport;
  persistence?: MemoryPersistence;
  /** What the server said about attachments (`GET /attachments/config`); absent = not asked. */
  server?: AttachmentServerConfig | null;
}

export function withApp(
  store: LocalStore,
  auth: AuthContextValue = fakeAuth(),
  attachments?: AttachmentsTestWiring | null,
  opts: { localOnly?: boolean } = {},
) {
  // Built eagerly; the queue holds only durable ciphertext, so a plain object per test is safe.
  let attachmentsCtx: AttachmentsContextValue | null = null;
  const queueAllowed = auth.keyring?.hasKeys() ?? false;
  if (attachments !== null && queueAllowed) {
    const persistence = attachments?.persistence ?? new MemoryPersistence();
    const transport: BlobTransport = attachments?.transport ?? {
      put: async () => "stored" as const,
      // The stock transport answers 404, like a blob not uploaded yet.
      get: async () => {
        throw new ApiError(404, "not found");
      },
    };
    const queue = new AttachmentQueue({
      transport,
      persistence,
      keyring: auth.keyring as Keyring,
      store,
      newId: () => store.newEntityId(),
    });
    attachmentsCtx = {
      queue,
      removeUpload: (id) => queue.remove(id),
      server: attachments?.server ?? null,
    };
  }

  return function Wrapper({ children }: { children: ReactNode }) {
    const [version, bump] = useState(0);
    useEffect(() => store.onChange(() => bump((v) => v + 1)), []);
    return (
      <AuthContext.Provider value={auth}>
        <StoreContext.Provider
          value={{
            store,
            status: "idle",
            version,
            kick: () => {},
            resync: async () => {},
            // As if a sync already succeeded: screens see the settled state, not first-launch gates.
            diagnostics: { lastError: null, lastSyncAt: 0, quarantined: [], pending: 0 },
            initialSyncDone: true,
            attachments: attachmentsCtx,
            localOnly: opts.localOnly,
          }}
        >
          {/* Real ToastProvider: list actions raise undo toasts, so screens that toggle/delete/
              reschedule need it mounted, exactly as production does. */}
          <ToastProvider>
            <SelectionProvider>
              <SelectionActionsProvider>
                <CursorProvider>{children}</CursorProvider>
              </SelectionActionsProvider>
            </SelectionProvider>
          </ToastProvider>
        </StoreContext.Provider>
      </AuthContext.Provider>
    );
  };
}
