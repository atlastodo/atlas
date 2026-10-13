import { useEffect } from "react";
import { Text } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  CURRENT_KDF,
  LEGACY_KDF,
  bytesToHex,
  deriveAuthAndMekAsync,
  deriveRecoveryAuthKeypair,
  deriveRecoveryKey,
  generateDek,
  generateRecoveryPhrase,
  generateSalt,
  generateUserKeypair,
  kdfToWire,
  generateRootKey,
  openTodoAppKey,
  todoAppKeyRow,
  unwrapRootKey,
  wrapRootKey,
  randomBytes,
  sealKey,
  unwrapKey,
  wrapKey,
  type AuthResponse,
  type AuthUser,
  type Session,
} from "@atlas/client-core";
import { AuthProvider, useAuth, type AuthContextValue } from "./AuthContext";
import { AuthGate } from "./AuthGate";
// The web build's Argon2id (WebAssembly), as the app registers it: client-core's pure-JS fallback
// takes over ten seconds per derivation under jest's transform.
import "../lib/argon2id.web";

/**
 * The real `AuthProvider`, driven over an in-memory keychain and a scripted server. The keychain
 * double stands in for expo-secure-store's native module (absent off-device) -- a third-party
 * module, like the doubles in `jest-setup`; nothing of ours is mocked.
 */
const mockKeychain = new Map<string, string>();
/** Makes every keychain write fail, as a full or locked keychain does. */
let mockFailKeychainWrites = false;
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  getItemAsync: async (key: string) => mockKeychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (mockFailKeychainWrites) throw new Error("keychain unavailable");
    mockKeychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockKeychain.delete(key);
  },
}));

// The OS notification store, so a sign-out's cancel is observable (native module absent off-device).
jest.mock("expo-notifications/build/cancelAllScheduledNotificationsAsync", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(async () => {}),
}));
const cancelAllScheduled = () =>
  jest.requireMock("expo-notifications/build/cancelAllScheduledNotificationsAsync")
    .cancelAllScheduledNotificationsAsync as jest.Mock;

const USER: AuthUser = { id: "u-1", email: "ada@example.com", display_name: "Ada" };
const PASSWORD = "correct horse battery";

type Route = (init: RequestInit & { headers: Record<string, string> }) => [number, unknown];
let routes: Record<string, Route> = {};
const calls: { path: string; init: RequestInit & { headers: Record<string, string> } }[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  // The real password KDF settles between RNTL's act scopes, so its state updates land outside
  // any act; the tests wait for their effects with findBy/waitFor instead.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  mockKeychain.clear();
  mockFailKeychainWrites = false;
  calls.length = 0;
  // An unlocked session fetches (and, when absent, uploads) its identity signing key; answer as a
  // server that accepts it rather than 404ing into the "could not load" warning.
  routes = {
    "/auth/signing-key": () => [200, { signing_public_key: null, encrypted_signing_key: null }],
  };
  globalThis.fetch = (async (
    url: string,
    init: RequestInit & { headers: Record<string, string> },
  ) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const route = routes[path];
    const [status, body] = route ? route(init) : [404, { error: "not found" }];
    return jsonResponse(status, body);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * The salt lookup of an account on `kdf`, or, without one, as a server from before per-account
 * KDFs answers it.
 */
function saltAnswer(salt: string, kdf?: typeof LEGACY_KDF | typeof CURRENT_KDF): Route {
  return () => [200, { salt, is_e2ee: true, ...(kdf ? kdfToWire(kdf) : {}) }];
}

/**
 * An unlocked E2EE session exactly as login persisted it before per-account KDFs (so, version 1),
 * plus the secrets behind it.
 */
async function unlockedAccount() {
  const salt = generateSalt();
  const { mek } = await deriveAuthAndMekAsync(PASSWORD, salt, LEGACY_KDF);
  const dek = generateDek();
  const keypair = generateUserKeypair();
  const session: Session = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    deviceId: "device-1",
    user: USER,
    salt,
    publicKey: keypair.publicKey,
    encryptedDek: wrapKey(dek, mek),
    encryptedPrivateKey: wrapKey(keypair.secretKey, mek),
    isE2ee: true,
    dek: bytesToHex(dek),
    privateKey: bytesToHex(keypair.secretKey),
  };
  return { salt, dek, keypair, session };
}

function persisted(): Session {
  const raw = mockKeychain.get("atlas.session");
  if (!raw) throw new Error("no session persisted");
  return JSON.parse(raw) as Session;
}

/** Renders the provider and hands back its live context value. */
async function renderProvider(
  props: { wipeLocalData?: (userId: string) => Promise<void> } = {},
): Promise<{ current: () => AuthContextValue }> {
  let latest: AuthContextValue | null = null;
  function Probe() {
    const auth = useAuth();
    useEffect(() => {
      latest = auth;
    });
    return <Text>ready</Text>;
  }
  await render(
    <AuthProvider wipeLocalData={props.wipeLocalData ?? (async () => {})}>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(latest?.sessionRestored).toBe(true));
  return { current: () => latest! };
}

describe("AuthProvider", () => {
  it("keeps the unwrapped keys in the persisted session across a token rotation", async () => {
    // A refresh response carries tokens and wrapped blobs, never the unwrapped keys. Persisting it
    // as-is locked every session after its first refresh -- and a locked client pushed plaintext.
    const { session } = await unlockedAccount();
    mockKeychain.set("atlas.session", JSON.stringify({ ...session, accessToken: "expired" }));
    routes["/auth/me"] = (init) =>
      init.headers.authorization === "Bearer expired"
        ? [401, { error: "unauthorized" }]
        : [200, USER];
    routes["/auth/refresh"] = () => [
      200,
      {
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 900,
        device_id: "device-1",
        user: USER,
        salt: session.salt,
        public_key: session.publicKey,
        encrypted_dek: session.encryptedDek,
        encrypted_private_key: session.encryptedPrivateKey,
        is_e2ee: true,
      },
    ];

    const auth = await renderProvider();

    await waitFor(() => expect(persisted().refreshToken).toBe("refresh-2"));
    expect(persisted().accessToken).toBe("access-2");
    expect(persisted().dek).toBe(session.dek);
    expect(persisted().privateKey).toBe(session.privateKey);
    expect(auth.current().session?.dek).toBe(session.dek);
    expect(auth.current().keyring?.hasKeys()).toBe(true);
  });

  it("unlocks a locked session with the password and persists the keys", async () => {
    const { session } = await unlockedAccount();
    const { dek: _dek, privateKey: _priv, ...locked } = session;
    mockKeychain.set("atlas.session", JSON.stringify(locked));
    routes["/auth/me"] = () => [200, USER];

    await render(
      <AuthProvider>
        <AuthGate>{() => <Text>APP CONTENT</Text>}</AuthGate>
      </AuthProvider>,
    );
    expect(await screen.findByText("Unlock your data")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Password"), "not the password");
    await fireEvent.press(screen.getByText("Unlock"));
    expect(await screen.findByText("Wrong password. Try again.")).toBeTruthy();
    expect(persisted().dek).toBeUndefined();

    await fireEvent.changeText(screen.getByLabelText("Password"), PASSWORD);
    await fireEvent.press(screen.getByText("Unlock"));
    expect(await screen.findByText("APP CONTENT")).toBeTruthy();
    // Persisted, so the next cold start is unlocked without asking again.
    expect(persisted().dek).toBe(session.dek);
    expect(persisted().privateKey).toBe(session.privateKey);
    expect(persisted().refreshToken).toBe("refresh-1");
  });

  it("checks the account password on this device, without asking the server", async () => {
    const { session } = await unlockedAccount();
    mockKeychain.set("atlas.session", JSON.stringify(session));
    routes["/auth/me"] = () => [200, USER];

    const auth = await renderProvider();
    calls.length = 0;
    expect(await auth.current().verifyPassword("not the password")).toBe(false);
    expect(await auth.current().verifyPassword(PASSWORD)).toBe(true);
    // Neither the salt lookup nor any credential check: the session holds what the check needs.
    const paths = calls.map((c) => c.path);
    expect(paths).not.toContain("/auth/salt");
    expect(paths).not.toContain("/auth/login");
  });

  it("changes the password with the derived hash, never the plaintext", async () => {
    const { salt, session } = await unlockedAccount();
    mockKeychain.set("atlas.session", JSON.stringify(session));
    routes["/auth/me"] = () => [200, USER];
    routes["/auth/salt"] = saltAnswer(salt, LEGACY_KDF);
    routes["/auth/change-password"] = () => [204, undefined];

    const auth = await renderProvider();
    await act(() => auth.current().changePassword(PASSWORD, "a brand new password"));

    const call = calls.find((c) => c.path === "/auth/change-password");
    const body = JSON.parse(call!.init.body as string);
    // The server stores Argon2(new_password) and login sends the derived hash: the plaintext here
    // would make the account unloggable (and hand the password to the server). The current
    // credential derives with the account's KDF, the new one with the current KDF.
    const next = await deriveAuthAndMekAsync("a brand new password", salt, CURRENT_KDF);
    expect(body.new_password).toBe(next.authHash);
    expect(body.current_password).toBe(
      (await deriveAuthAndMekAsync(PASSWORD, salt, LEGACY_KDF)).authHash,
    );
    expect(body).toMatchObject(kdfToWire(CURRENT_KDF));
    expect(body).not.toHaveProperty("kdf_upgrade");
    // The server names the device from the access token; a body device id is ignored.
    expect(body).not.toHaveProperty("device_id");
    expect(JSON.stringify(body)).not.toContain("a brand new password");
    // The session keeps the new blobs with the KDF that opens them, for the next unlock.
    expect(persisted().kdf).toEqual(CURRENT_KDF);
    expect(unwrapKey(persisted().encryptedDek!, next.mek)).toEqual(
      unwrapKey(body.encrypted_dek, next.mek),
    );
  });

  it("on sign-out cancels scheduled notifications and deletes the user's local database", async () => {
    const { session } = await unlockedAccount();
    mockKeychain.set("atlas.session", JSON.stringify(session));
    routes["/auth/me"] = () => [200, USER];
    routes["/auth/logout"] = () => [204, undefined];
    const wipe = jest.fn(async (_userId: string) => {});

    const auth = await renderProvider({ wipeLocalData: wipe });
    cancelAllScheduled().mockClear();
    await act(() => auth.current().logout());

    // Booked reminders carry the signed-out user's plaintext titles.
    expect(cancelAllScheduled()).toHaveBeenCalled();
    expect(wipe).toHaveBeenCalledWith(USER.id);
    expect(auth.current().session).toBeNull();
  });

  it("deletes the local database once the server accepts the account deletion", async () => {
    const { session, salt } = await unlockedAccount();
    mockKeychain.set("atlas.session", JSON.stringify(session));
    routes["/auth/me"] = () => [200, USER];
    routes["/auth/salt"] = () => [200, { salt, is_e2ee: true }];
    routes["/auth/account"] = () => [204, undefined];
    const wipe = jest.fn(async (_userId: string) => {});

    const auth = await renderProvider({ wipeLocalData: wipe });
    await act(() => auth.current().deleteAccount(PASSWORD));

    expect(wipe).toHaveBeenCalledWith(USER.id);
    expect(auth.current().session).toBeNull();
  });

  describe("a refused refresh ends the session and says why", () => {
    const cases: [string, unknown, RegExp][] = [
      ["account_disabled", { error: "account_disabled" }, /has been disabled/],
      [
        "account_scheduled_deletion",
        { error: "account_scheduled_deletion", days_remaining: 12 },
        /scheduled for deletion in 12 days/,
      ],
      [
        "account_deleted",
        { error: "account_deleted", code: "account_deleted" },
        /has been deleted/,
      ],
    ];
    it.each(cases)("%s", async (_code, body, message) => {
      const { session } = await unlockedAccount();
      mockKeychain.set("atlas.session", JSON.stringify({ ...session, accessToken: "expired" }));
      routes["/auth/me"] = () => [401, { error: "unauthorized" }];
      routes["/auth/refresh"] = () => [403, body];

      await render(
        <AuthProvider>
          <AuthGate>{() => <Text>APP CONTENT</Text>}</AuthGate>
        </AuthProvider>,
      );

      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.getByText("Sign in")).toBeTruthy();
      expect(mockKeychain.has("atlas.session")).toBe(false);
    });
  });

  it("never re-adopts a stored refresh token it already presented", async () => {
    // The rotated pair could not be persisted, so storage still holds the spent token when the
    // rotated one dies: presenting the spent one again would read as theft.
    const { session } = await unlockedAccount();
    mockKeychain.set("atlas.session", JSON.stringify({ ...session, accessToken: "expired" }));
    let refreshes = 0;
    routes["/auth/me"] = () => [401, { error: "unauthorized" }];
    routes["/auth/refresh"] = () =>
      ++refreshes === 1
        ? [
            200,
            authResponse(USER, {
              salt: session.salt,
              encrypted_dek: session.encryptedDek,
              encrypted_private_key: session.encryptedPrivateKey,
            }),
          ]
        : [401, { error: "unauthorized" }];
    mockFailKeychainWrites = true;
    // Failing keychain writes are the point; the provider reports each one as a warning.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const auth = await renderProvider();
    await waitFor(() => expect(auth.current().session?.refreshToken).toBe("refresh-new"));
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[atlas] could not persist rotated tokens:",
        expect.any(Error),
      ),
    );
    warn.mockRestore();
    // The next request finds the rotated token dead as well.
    await act(() =>
      auth
        .current()
        .api.me()
        .then(
          () => {},
          () => {},
        ),
    );
    await waitFor(() => expect(auth.current().session).toBeNull());

    const presented = calls
      .filter((c) => c.path === "/auth/refresh")
      .map((c) => JSON.parse(c.init.body as string).refresh_token);
    expect(presented).toEqual(["refresh-1", "refresh-new"]);
    expect(mockKeychain.has("atlas.session")).toBe(false);
  });

  it("signs the abandoned session out before signing in again", async () => {
    // A locked session that cannot unlock falls back to a full sign-in; its device family must not
    // stay live next to the new one.
    const { salt, session } = await unlockedAccount();
    const {
      dek: _d,
      privateKey: _p,
      salt: _s,
      encryptedDek,
      encryptedPrivateKey,
      ...stale
    } = session;
    mockKeychain.set("atlas.session", JSON.stringify(stale));
    routes["/auth/me"] = () => [200, USER];
    routes["/auth/logout"] = () => [204, undefined];
    routes["/auth/salt"] = () => [200, { salt, is_e2ee: true }];
    routes["/auth/login"] = () => [
      200,
      authResponse(USER, {
        salt,
        public_key: session.publicKey,
        encrypted_dek: encryptedDek,
        encrypted_private_key: encryptedPrivateKey,
      }),
    ];

    const auth = await renderProvider();
    await act(() => auth.current().login(USER.email, PASSWORD));

    const paths = calls.map((c) => c.path).filter((p) => p !== "/auth/me");
    expect(paths.indexOf("/auth/logout")).toBeLessThan(paths.indexOf("/auth/login"));
    const logout = calls.find((c) => c.path === "/auth/logout")!;
    expect(JSON.parse(logout.init.body as string)).toEqual({ refresh_token: "refresh-1" });
    expect(auth.current().session?.refreshToken).toBe("refresh-new");
    expect(auth.current().keyring?.hasKeys()).toBe(true);
  });

  it("signs up with the recovery public key derived from the phrase it shows", async () => {
    let signupBody: Record<string, unknown> = {};
    // An unknown address answers with the KDF a new account gets.
    routes["/auth/salt"] = saltAnswer("00112233445566778899aabbccddeeff", CURRENT_KDF);
    routes["/auth/signup"] = (init) => {
      signupBody = JSON.parse(init.body as string);
      return [201, authResponse({ ...USER, has_recovery_key: true })];
    };
    routes["/auth/me"] = () => [200, USER];

    const auth = await renderProvider();
    await act(() => auth.current().signup(USER.email, PASSWORD));

    const phrase = auth.current().recoveryPhrase!;
    const expected = deriveRecoveryAuthKeypair(phrase, signupBody.salt as string).publicKey;
    expect(signupBody.recovery_public_key).toBe(expected);
    expect(signupBody.recovery_public_key).not.toBe(signupBody.public_key);
    expect(signupBody).not.toHaveProperty("device_id");
    expect(signupBody).toMatchObject(kdfToWire(CURRENT_KDF));
    expect(signupBody.password).toBe(
      (await deriveAuthAndMekAsync(PASSWORD, signupBody.salt as string, CURRENT_KDF)).authHash,
    );
    expect(persisted().kdf).toEqual(CURRENT_KDF);
  });

  it("signs up with version 1 on a server that names no KDF", async () => {
    // Such a server stores no version, so the next sign-in would derive with version 1.
    let signupBody: Record<string, unknown> = {};
    routes["/auth/salt"] = saltAnswer("00112233445566778899aabbccddeeff");
    routes["/auth/signup"] = (init) => {
      signupBody = JSON.parse(init.body as string);
      return [201, authResponse({ ...USER, has_recovery_key: true })];
    };
    routes["/auth/me"] = () => [200, USER];

    const auth = await renderProvider();
    await act(() => auth.current().signup(USER.email, PASSWORD));

    expect(signupBody).toMatchObject(kdfToWire(LEGACY_KDF));
    expect(signupBody.password).toBe(
      (await deriveAuthAndMekAsync(PASSWORD, signupBody.salt as string, LEGACY_KDF)).authHash,
    );
  });

  describe("signing in to an account on an older KDF", () => {
    /** A version-1 account's login routes; the blobs open with its version-1 key. */
    async function legacyAccount(kdfOnWire: boolean) {
      const acct = await unlockedAccount();
      routes["/auth/me"] = () => [200, USER];
      routes["/auth/salt"] = saltAnswer(acct.salt, kdfOnWire ? LEGACY_KDF : undefined);
      routes["/auth/login"] = () => [
        200,
        {
          ...authResponse(USER, {
            salt: acct.salt,
            public_key: acct.session.publicKey,
            encrypted_dek: acct.session.encryptedDek,
            encrypted_private_key: acct.session.encryptedPrivateKey,
          }),
          ...(kdfOnWire ? kdfToWire(LEGACY_KDF) : {}),
        },
      ];
      return acct;
    }

    it("moves the account to the current KDF, re-wrapping only the password layer", async () => {
      const acct = await legacyAccount(true);
      let upgrade: Record<string, unknown> = {};
      routes["/auth/change-password"] = (init) => {
        upgrade = JSON.parse(init.body as string);
        expect(init.headers.authorization).toBe("Bearer access-new");
        return [204, undefined];
      };

      const auth = await renderProvider();
      await act(() => auth.current().login(USER.email, PASSWORD));

      const old = await deriveAuthAndMekAsync(PASSWORD, acct.salt, LEGACY_KDF);
      const next = await deriveAuthAndMekAsync(PASSWORD, acct.salt, CURRENT_KDF);
      // Authenticated by the credential the sign-in proved; the server swaps it atomically.
      expect(upgrade).toMatchObject({
        current_password: old.authHash,
        new_password: next.authHash,
        kdf_upgrade: true,
        ...kdfToWire(CURRENT_KDF),
      });
      expect(upgrade).not.toHaveProperty("recovery_encrypted_dek");
      const blob = upgrade.encrypted_dek as { iv: string; ct: string };
      expect(bytesToHex(unwrapKey(blob, next.mek))).toBe(acct.session.dek);
      const privateBlob = upgrade.encrypted_private_key as { iv: string; ct: string };
      expect(bytesToHex(unwrapKey(privateBlob, next.mek))).toBe(acct.session.privateKey);

      // The next unlock derives with the KDF the new blobs need.
      expect(persisted().kdf).toEqual(CURRENT_KDF);
      expect(persisted().encryptedDek).toEqual(blob);
      expect(auth.current().keyring?.hasKeys()).toBe(true);
    });

    it("keeps the old KDF working when the upgrade fails", async () => {
      const acct = await legacyAccount(true);
      routes["/auth/change-password"] = () => [500, { error: "boom" }];
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      const auth = await renderProvider();
      await act(() => auth.current().login(USER.email, PASSWORD));
      warn.mockRestore();

      expect(calls.filter((c) => c.path === "/auth/change-password")).toHaveLength(1);
      expect(auth.current().keyring?.hasKeys()).toBe(true);
      // The session still names the KDF its blobs open with.
      expect(persisted().kdf).toEqual(LEGACY_KDF);
      expect(persisted().encryptedDek).toEqual(acct.session.encryptedDek);
    });

    it("never asks a server that names no KDF to move the account", async () => {
      await legacyAccount(false);
      routes["/auth/change-password"] = () => [204, undefined];

      const auth = await renderProvider();
      await act(() => auth.current().login(USER.email, PASSWORD));

      expect(auth.current().keyring?.hasKeys()).toBe(true);
      expect(calls.find((c) => c.path === "/auth/change-password")).toBeUndefined();
    });
  });

  describe("replacing the recovery phrase", () => {
    async function signedIn() {
      const acct = await unlockedAccount();
      mockKeychain.set("atlas.session", JSON.stringify(acct.session));
      routes["/auth/me"] = () => [200, USER];
      routes["/auth/salt"] = saltAnswer(acct.salt, LEGACY_KDF);
      return acct;
    }

    it("registers a new phrase derived like signup's and hands it back", async () => {
      const acct = await signedIn();
      let body: Record<string, unknown> = {};
      routes["/auth/recovery-key/replace"] = (init) => {
        body = JSON.parse(init.body as string);
        return [204, undefined];
      };

      const auth = await renderProvider();
      let phrase = "";
      await act(async () => {
        phrase = await auth.current().replaceRecoveryPhrase(PASSWORD);
      });

      expect(phrase.split(" ")).toHaveLength(24);
      expect(body.current_password).toBe(
        (await deriveAuthAndMekAsync(PASSWORD, acct.salt, LEGACY_KDF)).authHash,
      );
      expect(body.recovery_public_key).toBe(deriveRecoveryAuthKeypair(phrase, acct.salt).publicKey);
      const recoveryKey = deriveRecoveryKey(phrase, acct.salt);
      const dekBlob = body.recovery_encrypted_dek as { iv: string; ct: string };
      expect(bytesToHex(unwrapKey(dekBlob, recoveryKey))).toBe(acct.session.dek);
      const privateBlob = body.recovery_encrypted_private_key as { iv: string; ct: string };
      expect(bytesToHex(unwrapKey(privateBlob, recoveryKey))).toBe(acct.session.privateKey);
      await waitFor(() => expect(persisted().user.has_recovery_key).toBe(true));
    });

    it("rejects a wrong password with the server's code", async () => {
      await signedIn();
      routes["/auth/recovery-key/replace"] = () => [
        403,
        { error: "invalid credentials", code: "invalid_credentials" },
      ];

      const auth = await renderProvider();
      await expect(auth.current().replaceRecoveryPhrase("not the password")).rejects.toMatchObject({
        status: 403,
      });
      expect(calls.find((c) => c.path === "/auth/refresh")).toBeUndefined();
    });
  });

  it("registers the phrase-derived key after a version-1 recovery", async () => {
    const acct = await recoverableAccount(1);
    const auth = await renderProvider();

    await act(() => auth.current().recoverAccount(USER.email, acct.phrase, "a new password"));

    const put = calls.find((c) => c.path === "/auth/recovery-key");
    expect(put?.init.method).toBe("PUT");
    const body = JSON.parse(put!.init.body as string);
    expect(body).toEqual({
      current_password: (await deriveAuthAndMekAsync("a new password", acct.salt, CURRENT_KDF))
        .authHash,
      recovery_public_key: deriveRecoveryAuthKeypair(acct.phrase, acct.salt).publicKey,
    });
    expect(put!.init.headers.authorization).toBe("Bearer access-new");
    await waitFor(() => expect(persisted().user.has_recovery_key).toBe(true));
  });

  it("does not register anything after a version-2 recovery", async () => {
    const acct = await recoverableAccount(2);
    const auth = await renderProvider();

    await act(() => auth.current().recoverAccount(USER.email, acct.phrase, "a new password"));

    expect(calls.find((c) => c.path === "/auth/recover")).toBeTruthy();
    expect(calls.find((c) => c.path === "/auth/recovery-key")).toBeUndefined();
    expect(auth.current().keyring?.hasKeys()).toBe(true);
    // Recovery wrote the current KDF, so the sign-in after it has nothing to move.
    expect(
      JSON.parse(calls.find((c) => c.path === "/auth/recover")!.init.body as string),
    ).toMatchObject(kdfToWire(CURRENT_KDF));
    expect(calls.find((c) => c.path === "/auth/change-password")).toBeUndefined();
  });

  describe("recovery phrase confirmation for an account without a recovery key", () => {
    const KDF_WAIT_MS = 10_000;

    async function accountWithoutRecoveryKey() {
      const acct = await unlockedAccount();
      const phrase = generateRecoveryPhrase();
      const user = { ...USER, has_recovery_key: false };
      mockKeychain.set("atlas.session", JSON.stringify({ ...acct.session, user }));
      routes["/auth/me"] = () => [200, user];
      routes["/auth/salt"] = saltAnswer(acct.salt, LEGACY_KDF);
      routes["/auth/recovery-keys"] = () => [
        200,
        {
          salt: acct.salt,
          recovery_encrypted_dek: wrapKey(acct.dek, deriveRecoveryKey(phrase, acct.salt)),
          recovery_encrypted_private_key: wrapKey(
            acct.keypair.secretKey,
            deriveRecoveryKey(phrase, acct.salt),
          ),
          recovery_key_version: 1,
          challenge: { token: "t", sealed: sealKey(randomBytes(32), acct.keypair.publicKey) },
        },
      ];
      await render(
        <AuthProvider>
          <AuthGate>{() => <Text>APP CONTENT</Text>}</AuthGate>
        </AuthProvider>,
      );
      expect(await screen.findByText("APP CONTENT")).toBeTruthy();
      expect(await screen.findByText("Confirm your recovery phrase")).toBeTruthy();
      return { ...acct, phrase };
    }

    async function confirm(phrase: string, password: string) {
      await fireEvent.changeText(screen.getByLabelText("24-word recovery phrase"), phrase);
      await fireEvent.changeText(screen.getByLabelText("Current password"), password);
      await fireEvent.press(screen.getByText("Confirm phrase"));
    }

    it(
      "verifies the phrase, registers the key, and stops asking",
      async () => {
        const acct = await accountWithoutRecoveryKey();
        let attempts = 0;
        routes["/auth/recovery-key"] = () =>
          ++attempts === 1
            ? [403, { error: "invalid credentials", code: "invalid_credentials" }]
            : [204, undefined];

        // Each confirm runs the password KDF, which outlasts the default 1 s wait when the whole
        // suite runs in parallel.
        await confirm(acct.phrase, "not the password");
        expect(
          await screen.findByText("Wrong password. Try again.", undefined, {
            timeout: KDF_WAIT_MS,
          }),
        ).toBeTruthy();
        // A wrong password is not an expired token: nothing may be rotated over it.
        expect(calls.find((c) => c.path === "/auth/refresh")).toBeUndefined();

        await confirm(acct.phrase, PASSWORD);
        await waitFor(() => expect(screen.queryByText("Confirm your recovery phrase")).toBeNull(), {
          timeout: KDF_WAIT_MS,
        });
        const body = JSON.parse(
          calls.filter((c) => c.path === "/auth/recovery-key")[1]!.init.body as string,
        );
        expect(body.current_password).toBe(
          (await deriveAuthAndMekAsync(PASSWORD, acct.salt, LEGACY_KDF)).authHash,
        );
        expect(body.recovery_public_key).toBe(
          deriveRecoveryAuthKeypair(acct.phrase, acct.salt).publicKey,
        );
        expect(persisted().user.has_recovery_key).toBe(true);
      },
      4 * KDF_WAIT_MS,
    );

    it("refuses a phrase that is not this account's without calling the server", async () => {
      await accountWithoutRecoveryKey();
      routes["/auth/recovery-key"] = () => [204, undefined];

      await confirm(generateRecoveryPhrase(), PASSWORD);

      expect(await screen.findByText(/recovery phrase doesn't match/)).toBeTruthy();
      expect(calls.find((c) => c.path === "/auth/recovery-key")).toBeUndefined();
    });

    it("stops asking once the server says a key is already set", async () => {
      const acct = await accountWithoutRecoveryKey();
      routes["/auth/recovery-key"] = () => [
        409,
        {
          error: "a different recovery key is already registered",
          code: "recovery_key_already_set",
        },
      ];

      await confirm(acct.phrase, PASSWORD);

      expect(await screen.findByText(/already registered/)).toBeTruthy();
      await waitFor(() => expect(persisted().user.has_recovery_key).toBe(true));
    });
  });
});

/** A login/signup answer for `user`, with the given wrapped blobs. */
function authResponse(
  user: AuthUser,
  blobs: Partial<
    Pick<AuthResponse, "salt" | "public_key" | "encrypted_dek" | "encrypted_private_key">
  > = {},
): AuthResponse {
  return {
    access_token: "access-new",
    refresh_token: "refresh-new",
    expires_in: 900,
    device_id: "device-new",
    user,
    is_e2ee: true,
    ...blobs,
  };
}

/**
 * Routes for a phrase recovery end to end: the recovery-keys answer (its challenge sealed per
 * `version`), the reset, and the login that follows it with the keys the reset stored.
 */
async function recoverableAccount(version: 1 | 2) {
  const salt = generateSalt();
  const phrase = generateRecoveryPhrase();
  const dek = generateDek();
  const keypair = generateUserKeypair();
  const recoveryKey = deriveRecoveryKey(phrase, salt);
  const recipient =
    version === 2 ? deriveRecoveryAuthKeypair(phrase, salt).publicKey : keypair.publicKey;
  const nonce = randomBytes(32);
  let stored: Record<string, unknown> = {};
  routes["/auth/recovery-keys"] = () => [
    200,
    {
      salt,
      recovery_encrypted_dek: wrapKey(dek, recoveryKey),
      recovery_encrypted_private_key: wrapKey(keypair.secretKey, recoveryKey),
      recovery_key_version: version,
      challenge: { token: "t", sealed: sealKey(nonce, recipient) },
    },
  ];
  routes["/auth/recover"] = (init) => {
    stored = JSON.parse(init.body as string);
    return stored.challenge_response === bytesToHex(nonce)
      ? [204, undefined]
      : [401, { error: "unauthorized" }];
  };
  routes["/auth/salt"] = saltAnswer(salt, CURRENT_KDF);
  routes["/auth/login"] = () => [
    200,
    authResponse(
      { ...USER, has_recovery_key: version === 2 },
      {
        salt,
        public_key: keypair.publicKey,
        encrypted_dek: stored.encrypted_dek as AuthResponse["encrypted_dek"],
        encrypted_private_key:
          stored.encrypted_private_key as AuthResponse["encrypted_private_key"],
      },
    ),
  ];
  routes["/auth/recovery-key"] = () => [204, undefined];
  routes["/auth/me"] = () => [200, USER];
  return { salt, phrase, dek, keypair };
}

describe("the account root key", () => {
  /** An account on the current KDF; `root` migrates it (legacy wraps stay, as the server keeps them). */
  async function account(root: boolean) {
    const salt = generateSalt();
    const { mek } = await deriveAuthAndMekAsync(PASSWORD, salt, CURRENT_KDF);
    const dek = generateDek();
    const keypair = generateUserKeypair();
    const rootKey = generateRootKey();
    const recovery = generateUserKeypair();
    const rootFields = root
      ? {
          has_root_key: true,
          encrypted_root_key: wrapRootKey(rootKey, mek, USER.id, "password"),
          app_keys: [todoAppKeyRow(rootKey, USER.id, { dek, privateKey: keypair.secretKey })],
          has_recovery_root_key: true,
          recovery_public_key: recovery.publicKey,
        }
      : {
          has_root_key: false,
          has_recovery_root_key: false,
          recovery_public_key: recovery.publicKey,
        };
    const auth: AuthResponse = {
      ...authResponse(USER, {
        salt,
        public_key: keypair.publicKey,
        encrypted_dek: wrapKey(dek, mek),
        encrypted_private_key: wrapKey(keypair.secretKey, mek),
      }),
      ...kdfToWire(CURRENT_KDF),
      ...rootFields,
    };
    routes["/auth/me"] = () => [200, USER];
    routes["/auth/salt"] = saltAnswer(salt, CURRENT_KDF);
    routes["/auth/login"] = () => [200, auth];
    return { salt, mek, dek, keypair, rootKey, recovery, auth };
  }

  const body = (path: string, method = "POST") =>
    JSON.parse(calls.find((c) => c.path === path && c.init.method === method)!.init.body as string);

  it("signs up with a root key over the DEK, under the password and the phrase", async () => {
    let signupBody: Record<string, unknown> = {};
    routes["/auth/salt"] = saltAnswer("00112233445566778899aabbccddeeff", CURRENT_KDF);
    routes["/auth/signup"] = (init) => {
      signupBody = JSON.parse(init.body as string);
      return [201, authResponse({ ...USER, id: signupBody.user_id as string })];
    };
    routes["/auth/me"] = () => [200, USER];

    const auth = await renderProvider();
    await act(() => auth.current().signup(USER.email, PASSWORD));

    const userId = signupBody.user_id as string;
    const salt = signupBody.salt as string;
    const { mek } = await deriveAuthAndMekAsync(PASSWORD, salt, CURRENT_KDF);
    const root = unwrapRootKey(
      signupBody.encrypted_root_key as Parameters<typeof unwrapRootKey>[0],
      mek,
      userId,
      "password",
    );
    const phraseRoot = unwrapRootKey(
      signupBody.recovery_encrypted_root_key as Parameters<typeof unwrapRootKey>[0],
      deriveRecoveryKey(auth.current().recoveryPhrase!, salt),
      userId,
      "recovery",
    );
    expect(phraseRoot).toEqual(root);
    const todo = openTodoAppKey(
      root,
      userId,
      signupBody.app_keys as Parameters<typeof openTodoAppKey>[2],
    );
    // The todo key is the very DEK the legacy wrap holds.
    expect(bytesToHex(todo.dek)).toBe(persisted().dek);
    expect(bytesToHex(unwrapKey(signupBody.encrypted_dek as { iv: string; ct: string }, mek))).toBe(
      persisted().dek,
    );
  });

  it("migrates an account without a root at sign-in", async () => {
    const acct = await account(false);
    routes["/auth/root-key"] = () => [204, undefined];

    const auth = await renderProvider();
    await act(() => auth.current().login(USER.email, PASSWORD));

    const sent = body("/auth/root-key");
    expect(sent.current_password).toBe(
      (await deriveAuthAndMekAsync(PASSWORD, acct.salt, CURRENT_KDF)).authHash,
    );
    expect(sent.recovery_public_key).toBe(acct.recovery.publicKey);
    const root = unwrapRootKey(sent.encrypted_root_key, acct.mek, USER.id, "password");
    expect(openTodoAppKey(root, USER.id, sent.app_keys).dek).toEqual(acct.dek);
    await waitFor(() => expect(persisted().hasRootKey).toBe(true));
    expect(persisted().encryptedRootKey).toEqual(sent.encrypted_root_key);
    expect(persisted().hasRecoveryRootKey).toBe(true);
    expect(auth.current().keyring?.hasKeys()).toBe(true);
  });

  it("loads the stored root when another device migrated first", async () => {
    const acct = await account(false);
    const stored = generateRootKey();
    const storedSlot = wrapRootKey(stored, acct.mek, USER.id, "password");
    const appKeys = [
      todoAppKeyRow(stored, USER.id, { dek: acct.dek, privateKey: acct.keypair.secretKey }),
    ];
    routes["/auth/root-key"] = (init) =>
      init.method === "POST"
        ? [409, { error: "exists", code: "root_key_exists" }]
        : [
            200,
            {
              has_root_key: true,
              encrypted_root_key: storedSlot,
              has_recovery_root_key: true,
              recovery_public_key: acct.recovery.publicKey,
              app_keys: appKeys,
            },
          ];

    const auth = await renderProvider();
    await act(() => auth.current().login(USER.email, PASSWORD));

    await waitFor(() => expect(persisted().encryptedRootKey).toEqual(storedSlot));
    expect(persisted().appKeys).toEqual(appKeys);
  });

  it("keeps working on the legacy wraps when the migration fails", async () => {
    await account(false);
    routes["/auth/root-key"] = () => [500, { error: "boom" }];
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const auth = await renderProvider();
    await act(() => auth.current().login(USER.email, PASSWORD));
    warn.mockRestore();

    expect(auth.current().keyring?.hasKeys()).toBe(true);
    expect(persisted().hasRootKey).toBe(false);
  });

  it("opens the keys through the root, before the legacy wraps", async () => {
    const acct = await account(true);
    // Legacy wraps that no longer open: only the root path can produce the DEK.
    routes["/auth/login"] = () => [
      200,
      {
        ...acct.auth,
        encrypted_dek: wrapKey(generateDek(), randomBytes(32)),
        encrypted_private_key: wrapKey(generateDek(), randomBytes(32)),
      },
    ];

    const auth = await renderProvider();
    await act(() => auth.current().login(USER.email, PASSWORD));

    expect(persisted().dek).toBe(bytesToHex(acct.dek));
    expect(persisted().privateKey).toBe(bytesToHex(acct.keypair.secretKey));
    expect(calls.find((c) => c.path === "/auth/root-key")).toBeUndefined();
  });

  it("unlocks a locked session through the root", async () => {
    const acct = await account(true);
    const { mek } = acct;
    const session: Session = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      deviceId: "device-1",
      user: USER,
      salt: acct.salt,
      kdf: CURRENT_KDF,
      publicKey: acct.keypair.publicKey,
      encryptedDek: wrapKey(generateDek(), randomBytes(32)),
      encryptedPrivateKey: wrapKey(acct.keypair.secretKey, mek),
      hasRootKey: true,
      encryptedRootKey: acct.auth.encrypted_root_key,
      appKeys: acct.auth.app_keys,
      hasRecoveryRootKey: true,
      isE2ee: true,
    };
    mockKeychain.set("atlas.session", JSON.stringify(session));

    const auth = await renderProvider();
    expect(await auth.current().unlock("not the password")).toBe(false);
    expect(await auth.current().unlock(PASSWORD)).toBe(true);
    expect(persisted().dek).toBe(bytesToHex(acct.dek));
  });

  it("moves the root slot to the new password", async () => {
    const acct = await account(true);
    routes["/auth/root-key"] = () => [
      200,
      {
        has_root_key: true,
        encrypted_root_key: acct.auth.encrypted_root_key,
        has_recovery_root_key: true,
        recovery_public_key: acct.recovery.publicKey,
        app_keys: acct.auth.app_keys,
      },
    ];
    routes["/auth/change-password"] = () => [204, undefined];

    const auth = await renderProvider();
    await act(() => auth.current().login(USER.email, PASSWORD));
    await act(() => auth.current().changePassword(PASSWORD, "a new password"));

    const sent = body("/auth/change-password");
    const { mek } = await deriveAuthAndMekAsync("a new password", acct.salt, CURRENT_KDF);
    expect(unwrapRootKey(sent.encrypted_root_key, mek, USER.id, "password")).toEqual(acct.rootKey);
    expect(persisted().encryptedRootKey).toEqual(sent.encrypted_root_key);
  });
});
