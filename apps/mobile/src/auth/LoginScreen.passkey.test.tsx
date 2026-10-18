import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  PasskeyCancelledError,
  PasskeyPrfUnsupportedError,
  type PasskeyAuthenticator,
} from "@atlastodo/client-core";
import { fakeAuth } from "../testutil";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { LoginScreen } from "./LoginScreen";

const authenticator = {} as PasskeyAuthenticator;

function withAuth(value: Partial<AuthContextValue>) {
  const full = fakeAuth(value);
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthContext.Provider value={full}>{children}</AuthContext.Provider>;
  };
}

describe("LoginScreen passkeys", () => {
  it("offers no passkey where the device cannot use one", async () => {
    await render(<LoginScreen />, { wrapper: withAuth({}) });
    expect(screen.queryByText("Sign in with a passkey")).toBeNull();
  });

  it("signs in with a passkey, email-first when one is typed", async () => {
    const loginWithPasskey = jest.fn(async () => {});
    await render(<LoginScreen />, {
      wrapper: withAuth({ passkeyAuthenticator: authenticator, loginWithPasskey }),
    });
    await fireEvent.press(screen.getByText("Sign in with a passkey"));
    await waitFor(() => expect(loginWithPasskey).toHaveBeenCalledWith(undefined));

    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.press(screen.getByText("Sign in with a passkey"));
    await waitFor(() => expect(loginWithPasskey).toHaveBeenLastCalledWith("ada@example.com"));
  });

  it("signs up with a passkey instead of a password", async () => {
    const signupWithPasskey = jest.fn(async () => {});
    await render(<LoginScreen initialMode="signup" />, {
      wrapper: withAuth({ passkeyAuthenticator: authenticator, signupWithPasskey }),
    });
    expect(screen.getByText(/Passkey-only accounts cannot sign in on iOS/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Name"), "Ada");
    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.press(screen.getByText("Create account with a passkey"));
    await waitFor(() =>
      expect(signupWithPasskey).toHaveBeenCalledWith("ada@example.com", "Ada", undefined),
    );
  });

  it("says why a passkey did not work", async () => {
    const loginWithPasskey = jest
      .fn<Promise<void>, [string?]>()
      .mockRejectedValueOnce(new PasskeyPrfUnsupportedError())
      .mockRejectedValueOnce(new PasskeyCancelledError());
    await render(<LoginScreen />, {
      wrapper: withAuth({ passkeyAuthenticator: authenticator, loginWithPasskey }),
    });
    await fireEvent.press(screen.getByText("Sign in with a passkey"));
    expect(await screen.findByText(/does not support the PRF extension/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Sign in with a passkey"));
    expect(await screen.findByText("The passkey prompt was dismissed.")).toBeTruthy();
  });
});
