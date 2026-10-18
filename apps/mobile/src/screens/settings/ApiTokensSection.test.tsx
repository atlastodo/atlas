import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  Keyring,
  LocalStore,
  parseApiToken,
  randomBytes,
  unwrapApiTokenKeys,
  type ApiClient,
  type ApiTokenView,
  type CreateApiTokenPayload,
} from "@atlastodo/client-core";
import type { Session } from "@atlastodo/client-core";
import { fakeAuth, lastCopiedText, withApp } from "../../testutil";
import { ApiTokensSection } from "./ApiTokensSection";

const USER_ID = "01920000-0000-7000-8000-000000000001";

function setup(opts: { locked?: boolean } = {}) {
  const tokens: ApiTokenView[] = [
    { id: "t-old", name: "Old script", created_at: Date.now() - 86_400_000 },
  ];
  const created: CreateApiTokenPayload[] = [];
  const api = {
    listApiTokens: jest.fn(async () => [...tokens]),
    createApiToken: jest.fn(async (payload: CreateApiTokenPayload) => {
      created.push(payload);
      const view = { id: payload.id, name: payload.name, created_at: Date.now() };
      tokens.unshift(view);
      return view;
    }),
    revokeApiToken: jest.fn(async (id: string) => {
      tokens.splice(
        tokens.findIndex((t) => t.id === id),
        1,
      );
    }),
  };
  const keys = { dek: randomBytes(32), privateKey: randomBytes(32) };
  const auth = fakeAuth({
    api: api as unknown as ApiClient,
    keyring: opts.locked ? null : new Keyring(keys),
    session: { user: { id: USER_ID } } as Session,
  });
  const store = new LocalStore("device", { newId: () => crypto.randomUUID() });
  return { api, keys, created, wrapper: withApp(store, auth) };
}

describe("ApiTokensSection", () => {
  it("creates a token, shows it once, and wraps the keys for it alone", async () => {
    const { api, keys, created, wrapper } = setup();
    await render(<ApiTokensSection />, { wrapper });
    expect(await screen.findByText("Old script")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Create token"));
    await fireEvent.changeText(screen.getByLabelText("e.g. n8n at home"), "n8n");
    await fireEvent.press(screen.getByText("Create"));

    const shown = await screen.findByTestId("api-token-value");
    const token = String(shown.props.children);
    expect(token).toMatch(/^atlas_pat_/);
    expect(api.createApiToken).toHaveBeenCalledTimes(1);
    const payload = created[0]!;
    expect(payload.name).toBe("n8n");
    expect(JSON.stringify(payload)).not.toContain(token.slice("atlas_pat_".length));
    // The wraps open with the token shown, and give back this account's keys.
    const opened = unwrapApiTokenKeys(parseApiToken(token), USER_ID, payload);
    expect(opened.dek).toEqual(keys.dek);
    expect(opened.privateKey).toEqual(keys.privateKey);

    // Copying a secret arms a one-minute clipboard clear; fake timers keep it from outliving the test.
    jest.useFakeTimers();
    try {
      await fireEvent.press(screen.getByLabelText("Copy token"));
      await waitFor(() => expect(lastCopiedText()).toBe(token));
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }

    await fireEvent.press(screen.getByText("Done"));
    await waitFor(() => expect(screen.queryByTestId("api-token-value")).toBeNull());
    expect(screen.getByText("n8n")).toBeTruthy();
  });

  it("revokes a token after confirming", async () => {
    const { api, wrapper } = setup();
    await render(<ApiTokensSection />, { wrapper });
    await fireEvent.press(await screen.findByLabelText("Revoke Old script"));
    await fireEvent.press(screen.getAllByText("Revoke").at(-1)!);
    await waitFor(() => expect(api.revokeApiToken).toHaveBeenCalledWith("t-old"));
    await waitFor(() => expect(screen.queryByText("Old script")).toBeNull());
  });

  it("cannot create a token without the unlocked keys", async () => {
    const { wrapper } = setup({ locked: true });
    await render(<ApiTokensSection />, { wrapper });
    expect(
      await screen.findByText("Unlock your account on this device to create a token."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Create token").props.accessibilityState?.disabled).toBe(true);
  });
});
