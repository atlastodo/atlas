import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  ApiError,
  Keyring,
  LocalStore,
  randomBytes,
  type ApiClient,
  type PasskeyAuthenticator,
  type PasskeyView,
  type Session,
} from "@atlas/client-core";
import { fakeAuth, withApp } from "../../testutil";
import { PasskeysSection } from "./PasskeysSection";

const USER_ID = "01920000-0000-7000-8000-000000000001";

function setup(opts: { hasPassword?: boolean; offered?: boolean; count?: number } = {}) {
  const passkeys: PasskeyView[] = Array.from({ length: opts.count ?? 1 }, (_, i) => ({
    id: `p${i}`,
    credential_id: `c${i}`,
    name: i === 0 ? "Laptop" : `Key ${i}`,
    transports: [],
    backup_eligible: true,
    backed_up: true,
    created_at: Date.now() - 86_400_000,
  }));
  const api = {
    getDiscovery: jest.fn(async () => ({
      capabilities: opts.offered === false ? [] : ["passkeys"],
    })),
    listPasskeys: jest.fn(async () => [...passkeys]),
    renamePasskey: jest.fn(async () => {}),
  };
  const addPasskey = jest.fn(async () => {});
  const removePasskey = jest.fn(async () => {});
  const removePassword = jest.fn(async () => {});
  const confirmWithPasskey = jest.fn(async () => ({ reauthToken: "proof", rootKey: null }));
  const auth = fakeAuth({
    api: api as unknown as ApiClient,
    keyring: new Keyring({ dek: randomBytes(32), privateKey: randomBytes(32) }),
    session: {
      user: { id: USER_ID, has_password: opts.hasPassword ?? true },
    } as Session,
    passkeyAuthenticator: {} as PasskeyAuthenticator,
    addPasskey,
    removePasskey,
    removePassword,
    confirmWithPasskey,
  });
  const store = new LocalStore("device", { newId: () => crypto.randomUUID() });
  return {
    api,
    addPasskey,
    removePasskey,
    removePassword,
    confirmWithPasskey,
    wrapper: withApp(store, auth),
  };
}

describe("PasskeysSection", () => {
  it("is hidden when the server offers no passkeys", async () => {
    const { wrapper, api } = setup({ offered: false });
    await render(<PasskeysSection />, { wrapper });
    await waitFor(() => expect(api.getDiscovery).toHaveBeenCalled());
    expect(screen.queryByText("Passkeys")).toBeNull();
    expect(api.listPasskeys).not.toHaveBeenCalled();
  });

  it("adds a passkey confirmed with the password", async () => {
    const { wrapper, addPasskey } = setup();
    await render(<PasskeysSection />, { wrapper });
    expect(await screen.findByText("Laptop")).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText("Add a passkey")[0]!);
    await fireEvent.changeText(screen.getByLabelText("e.g. Phone"), "Phone");
    await fireEvent.changeText(screen.getByLabelText("Your password"), "hunter2hunter");
    await fireEvent.press(screen.getAllByText("Add a passkey").at(-1)!);
    await waitFor(() => expect(addPasskey).toHaveBeenCalledWith("Phone", "hunter2hunter"));
  });

  it("confirms with a passkey on an account without a password, and urges a second way in", async () => {
    const { wrapper, removePasskey, confirmWithPasskey } = setup({ hasPassword: false, count: 2 });
    await render(<PasskeysSection />, { wrapper });
    expect(await screen.findByText("Key 1")).toBeTruthy();
    expect(screen.queryByText("Remove password")).toBeNull();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Remove Key 1"));
    await fireEvent.press(screen.getByText("Confirm with a passkey"));
    await waitFor(() =>
      expect(removePasskey).toHaveBeenCalledWith("p1", { reauthToken: "proof", rootKey: null }),
    );
    expect(confirmWithPasskey).toHaveBeenCalled();
  });

  it("warns about a single passkey and explains a refused last removal", async () => {
    const { wrapper, removePasskey } = setup({ hasPassword: false });
    removePasskey.mockRejectedValueOnce(new ApiError(409, "last", { code: "last_unlock_method" }));
    await render(<PasskeysSection />, { wrapper });
    expect(await screen.findByText(/Your account has one passkey and no password/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Remove Laptop"));
    await fireEvent.press(screen.getByText("Confirm with a passkey"));
    expect(await screen.findByText(/This is your last way to sign in/)).toBeTruthy();
  });

  it("removes the password once a passkey exists", async () => {
    const { wrapper, removePassword } = setup();
    await render(<PasskeysSection />, { wrapper });
    await fireEvent.press(await screen.findByLabelText("Remove password"));
    await fireEvent.changeText(screen.getByLabelText("Your password"), "hunter2hunter");
    await fireEvent.press(screen.getAllByText("Remove password").at(-1)!);
    await waitFor(() => expect(removePassword).toHaveBeenCalledWith("hunter2hunter"));
  });
});
