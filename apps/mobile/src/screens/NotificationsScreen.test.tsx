import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  Keyring,
  LocalStore,
  encryptJson,
  generateDek,
  generatePek,
  generateUserKeypair,
  projectKeyId,
  sealKey,
  type ApiClient,
  type InviteView,
  type ProjectKeysResponse,
} from "@atlastodo/client-core";
import { fakeAuth, withApp } from "../testutil";
import { NotificationsProvider, useInviteToasts } from "../data/NotificationsProvider";
import { NotificationsScreen } from "./NotificationsScreen";

/**
 * Over the real `NotificationsProvider` with a fake `ApiClient` injected through the auth context --
 * invites are REST-driven, so the fake is the seam the real code already uses (no module mocks).
 * The keyring and store are real: a card decrypts exactly what an invitee's device would.
 */

const SESSION = {
  accessToken: "a",
  refreshToken: "r",
  deviceId: "d",
  user: { id: "me", email: "me@example.com", display_name: "Me" },
};

const me = generateUserKeypair();
function myKeyring(): Keyring {
  return new Keyring({
    dek: generateDek(),
    userPrivateKey: me.secretKey,
    userPublicKey: me.publicKey,
  });
}

function fakeApi(invites: InviteView[] | (() => InviteView[]), calls: string[] = []) {
  const api = {
    listInvites: jest.fn(async () => (typeof invites === "function" ? invites() : invites)),
    acceptInvite: jest.fn(async () => {
      calls.push("accept");
    }),
    declineInvite: jest.fn(async () => {}),
    listProjectKeys: jest.fn(async (): Promise<ProjectKeysResponse> => {
      calls.push("hydrate");
      return { keys: [], canonical: {} };
    }),
    putProjectKey: jest.fn(async () => {}),
  };
  return api as unknown as ApiClient & typeof api;
}

async function mount(
  invites: InviteView[],
  opts: { keyring?: Keyring | null; calls?: string[] } = {},
) {
  const api = fakeApi(invites, opts.calls);
  await render(
    <NotificationsProvider>
      <NotificationsScreen />
    </NotificationsProvider>,
    {
      wrapper: withApp(
        new LocalStore("test"),
        fakeAuth({ api, keyring: opts.keyring ?? null, session: SESSION }),
        null,
      ),
    },
  );
  return api;
}

const invite: InviteView = {
  project_id: "p1",
  role: "editor",
  invited_at: 0,
  inviter: { user_id: "u-boss", email: "boss@example.com", display_name: "Boss" },
  project: { name: "Home reno", icon: null, color: null, kind: null },
  sealed_key: null,
};

/** An invite whose project fields are encrypted under `pek`, delivered sealed to `recipient`. */
function encryptedInvite(pek: Uint8Array, recipient: string | null): InviteView {
  const env = (v: unknown) => ({ __enc: 1, ...encryptJson(pek, v) });
  return {
    ...invite,
    project: { name: env("Secret plans"), icon: env("rocket"), color: env("#ff0000"), kind: null },
    sealed_key: recipient
      ? { key_id: projectKeyId(pek), encrypted_pek: sealKey(pek, recipient) }
      : null,
  };
}

/** Every string the screen renders, so envelope data held in props does not count. */
function renderedText(): string {
  const walk = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(walk).join(" ");
    if (node && typeof node === "object" && "children" in node) {
      return walk((node as { children: unknown }).children ?? []);
    }
    return "";
  };
  return walk(screen.toJSON());
}

describe("NotificationsScreen", () => {
  it("shows a loading skeleton until the invites arrive", async () => {
    // A deferred listInvites keeps `loading` true, so the first paint is the skeleton, not the
    // empty state. The "Loading" label is the skeleton's accessibility contract (not a class name).
    let resolve!: (v: InviteView[]) => void;
    const pending = new Promise<InviteView[]>((r) => {
      resolve = r;
    });
    const api = {
      listInvites: jest.fn(() => pending),
      acceptInvite: jest.fn(async () => {}),
      declineInvite: jest.fn(async () => {}),
    } as unknown as ApiClient;
    await render(
      <NotificationsProvider>
        <NotificationsScreen />
      </NotificationsProvider>,
      { wrapper: withApp(new LocalStore("test"), fakeAuth({ api })) },
    );
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    resolve([invite]);
    await waitFor(() => expect(screen.getByText(/Home reno/)).toBeTruthy());
    expect(screen.queryByLabelText("Loading")).toBeNull();
  });

  it("decrypts the project name with the key sealed to this user", async () => {
    const pek = generatePek();
    await mount([encryptedInvite(pek, me.publicKey)], { keyring: myKeyring() });
    await waitFor(() => expect(screen.getByText("Secret plans")).toBeTruthy());
    expect(screen.queryByLabelText("Encrypted project name")).toBeNull();
    expect(renderedText()).not.toMatch(/__enc|\[object Object\]/);
  });

  it("shows a locked, generic name when the key cannot be opened", async () => {
    const pek = generatePek();
    const someoneElse = generateUserKeypair();
    await mount(
      [
        { ...encryptedInvite(pek, someoneElse.publicKey), project_id: "p1" },
        { ...encryptedInvite(pek, null), project_id: "p2" },
      ],
      { keyring: myKeyring() },
    );
    await waitFor(() => expect(screen.getAllByText("A shared project")).toHaveLength(2));
    expect(screen.getAllByLabelText("Encrypted project name")).toHaveLength(2);
    expect(screen.queryByText("Secret plans")).toBeNull();
    expect(renderedText()).not.toMatch(/__enc|\[object Object\]/);
  });

  it("accepts an invite: loads keys, accepts, loads keys again, then confirms", async () => {
    const calls: string[] = [];
    const api = await mount([invite], { keyring: myKeyring(), calls });
    await waitFor(() => expect(screen.getByText(/Home reno/)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Accept"));
    await waitFor(() => expect(screen.getByText("Joined Home reno")).toBeTruthy());
    expect(api.acceptInvite).toHaveBeenCalledWith("p1");
    expect(calls).toEqual(["hydrate", "accept", "hydrate"]);
  });

  it("shows an error toast when accepting fails", async () => {
    const api = await mount([invite]);
    api.acceptInvite.mockRejectedValueOnce(new Error("offline"));
    await waitFor(() => expect(screen.getByText(/Home reno/)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Accept"));
    await waitFor(() => expect(screen.getByText("Couldn't accept the invitation")).toBeTruthy());
  });

  it("declines an invite", async () => {
    const api = await mount([invite]);
    await waitFor(() => expect(screen.getByText(/Home reno/)).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Decline"));
    await waitFor(() => expect(api.declineInvite).toHaveBeenCalledWith("p1"));
  });
});

describe("invite toasts", () => {
  function Toasts({ onView }: { onView: () => void }) {
    useInviteToasts(onView);
    return null;
  }

  function addPendingRow(store: LocalStore, id: string, projectId: string) {
    store.set("project_member", id, "project_id", projectId);
    store.set("project_member", id, "role", "editor");
    store.set("project_member", id, "user_id", "me");
    store.set("project_member", id, "state", "pending");
  }

  const pendingInvites = (store: LocalStore): InviteView[] =>
    store
      .list("project_member")
      .filter((e) => e.fields.user_id === "me" && e.fields.state === "pending")
      .map((e) =>
        e.fields.project_id === "p1"
          ? invite
          : { ...invite, project_id: "p2", project: { ...invite.project, name: "Garden" } },
      );

  async function mountToasts(store: LocalStore) {
    const onView = jest.fn();
    const api = fakeApi(() => pendingInvites(store));
    await render(
      <NotificationsProvider>
        <Toasts onView={onView} />
      </NotificationsProvider>,
      { wrapper: withApp(store, fakeAuth({ api, session: SESSION }), null) },
    );
    return { api, onView };
  }

  it("toasts once when the user's own pending row appears", async () => {
    const store = new LocalStore("test");
    const { api, onView } = await mountToasts(store);
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledTimes(1));

    await act(() => addPendingRow(store, "m1", "p1"));
    await waitFor(() =>
      expect(screen.getByText("Boss invited you to Home reno as Editor")).toBeTruthy(),
    );

    // A later invite toasts for itself only.
    await act(() => addPendingRow(store, "m2", "p2"));
    await waitFor(() =>
      expect(screen.getByText("Boss invited you to Garden as Editor")).toBeTruthy(),
    );
    expect(screen.getAllByText("Boss invited you to Home reno as Editor")).toHaveLength(1);

    await fireEvent.press(screen.getAllByLabelText("View")[0]!);
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it("does not toast invites that were already pending when the app started", async () => {
    const store = new LocalStore("test");
    addPendingRow(store, "m1", "p1");
    const { api } = await mountToasts(store);
    await waitFor(() => expect(api.listInvites).toHaveBeenCalled());
    await act(() => store.set("project_member", "m1", "role", "commenter"));
    expect(screen.queryByText(/invited you/)).toBeNull();
    expect(api.listInvites).toHaveBeenCalledTimes(1);
  });
});
