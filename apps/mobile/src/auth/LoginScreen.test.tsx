import type { ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";
import { fireEvent, render as render, screen, waitFor } from "@testing-library/react-native";
import {
  ApiError,
  LEGACY_DISCOVERY,
  RecoveryPhraseError,
  ServerIncompatibleError,
} from "@atlastodo/client-core";
import { fakeAuth } from "../testutil";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { LoginScreen } from "./LoginScreen";

/**
 * The screen is driven through a fake context rather than the real `AuthProvider`, so these tests
 * exercise the screen's own behaviour without a keychain, a network or a server. (The web's twin
 * mocks `fetch` and reads localStorage; neither exists here, and mocking expo-secure-store would
 * fight jest-expo's resolver -- prefer DI over module mocks.)
 */
function withAuth(value: Partial<AuthContextValue>) {
  const full = fakeAuth(value);
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthContext.Provider value={full}>{children}</AuthContext.Provider>;
  };
}

describe("LoginScreen", () => {
  it("toggles between sign in and sign up", async () => {
    await render(<LoginScreen />, { wrapper: withAuth({}) });

    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();

    await fireEvent.press(screen.getByText("Need an account? Sign up"));

    expect(screen.getByText("Create account")).toBeTruthy();
    // Sign-up asks for a display name; sign-in does not.
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("signs in with the typed credentials", async () => {
    const login = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Sign in"));

    await waitFor(() => expect(login).toHaveBeenCalledWith("ada@example.com", "hunter2hunter"));
  });

  it("creates an account with the display name in sign-up mode", async () => {
    const signup = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ signup }) });

    await fireEvent.press(screen.getByText("Need an account? Sign up"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "Ada");
    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Create account"));

    await waitFor(() =>
      expect(signup).toHaveBeenCalledWith("ada@example.com", "hunter2hunter", "Ada", undefined),
    );
  });

  it("shows friendly invalid credentials message when sign-in is rejected with 401", async () => {
    const login = jest.fn(async () => {
      throw new ApiError(401, "unauthorized");
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(await screen.findByText("Invalid email or password")).toBeTruthy();
  });

  it("shows scheduled deletion notice with cancel and restore option", async () => {
    const login = jest.fn(async () => {
      throw new ApiError(403, "account_scheduled_deletion", { days_remaining: 15 });
    });
    const cancelAccountDeletion = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ login, cancelAccountDeletion }) });

    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Sign in"));

    expect(
      await screen.findByText(
        "This account is scheduled to be permanently deleted in 15 days. You can cancel the deletion now to fully restore your account and all your data.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Cancel deletion & restore account")).toBeTruthy();

    await fireEvent.press(screen.getByText("Cancel deletion & restore account"));
    await waitFor(() => {
      expect(cancelAccountDeletion).toHaveBeenCalledWith("ada@example.com", "hunter2hunter");
    });
  });

  it("explains a pre-encryption account instead of a bare 403", async () => {
    // The server refuses to sign in an account that never got keys; there is no client-side
    // upgrade any more, so the only way forward is for the admin to recreate it.
    const login = jest.fn(async () => {
      throw new ApiError(403, "forbidden", { code: "legacy_account" });
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(
      await screen.findByText(
        "This account was created before encryption was introduced; ask your server admin to recreate it.",
      ),
    ).toBeTruthy();
  });

  it("says the server is too old when discovery rules it out", async () => {
    const login = jest.fn(async () => {
      throw new ServerIncompatibleError(
        { reason: "protocol", required: 9, actual: 1 },
        LEGACY_DISCOVERY,
      );
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(
      await screen.findByText(
        "This server runs an older Atlas than this app needs. Ask its operator to update it.",
      ),
    ).toBeTruthy();
  });

  it("says the server does not offer the app", async () => {
    const login = jest.fn(async () => {
      throw new ServerIncompatibleError({ reason: "apps", missing: ["todo"] }, LEGACY_DISCOVERY);
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(
      await screen.findByText(
        "This server does not offer Atlas Todo. Ask its operator to enable it.",
      ),
    ).toBeTruthy();
  });

  it("falls back to a generic message when the failure is not from the server", async () => {
    // What an unreachable self-hosted server actually looks like: fetch rejects, no ApiError.
    const login = jest.fn(async () => {
      throw new TypeError("Network request failed");
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
    // The raw network error is never shown -- it would mean nothing to a user.
    expect(screen.queryByText("Network request failed")).toBeNull();
  });

  it("recovers account using the recovery phrase", async () => {
    const recoverAccount = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ recoverAccount }) });

    await fireEvent.press(screen.getByText("Forgot your password? Recover with your phrase"));

    expect(screen.getByText("Reset password and recover")).toBeTruthy();
    expect(screen.getByLabelText("24-word recovery phrase")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(
      screen.getByLabelText("24-word recovery phrase"),
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    );
    await fireEvent.changeText(screen.getByLabelText("New password"), "newstrongpassword");
    await fireEvent.press(screen.getByText("Reset password and recover"));

    await waitFor(() =>
      expect(recoverAccount).toHaveBeenCalledWith(
        "ada@example.com",
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
        "newstrongpassword",
      ),
    );
  });

  it("says the recovery phrase is wrong rather than showing a raw crypto error", async () => {
    // A wrong phrase fails client-side (AES-GCM refuses to unwrap) before anything is posted; the
    // server's 401 for a failed challenge means the same thing to the user.
    for (const failure of [new RecoveryPhraseError(), new ApiError(401, "unauthorized")]) {
      const recoverAccount = jest.fn(async () => {
        throw failure;
      });
      const view = await render(<LoginScreen />, { wrapper: withAuth({ recoverAccount }) });

      await fireEvent.press(screen.getByText("Forgot your password? Recover with your phrase"));
      await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
      await fireEvent.changeText(screen.getByLabelText("24-word recovery phrase"), "wrong words");
      await fireEvent.changeText(screen.getByLabelText("New password"), "newstrongpassword");
      await fireEvent.press(screen.getByText("Reset password and recover"));

      expect(
        await screen.findByText(
          "That recovery phrase doesn't match this account. Check the words and try again.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("Invalid email or password")).toBeNull();
      await view.unmount();
    }
  });

  it("refuses to submit without a server URL", async () => {
    // A production build has no built-in default, so the field must hold a real URL before any
    // auth call is made -- the client cannot talk to an empty base URL.
    const login = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.changeText(screen.getByLabelText("Server URL"), "");
    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Sign in"));

    expect(await screen.findByText(/Enter your server URL/)).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
  });

  it("rebinds the client through changeServerUrl before logging in when the URL was edited", async () => {
    // The point of the always-visible field: the user aims the app at a server where they do not
    // have an account yet, so the override must be persisted and the client rebuilt *before* auth.
    const login = jest.fn(async () => {});
    const changeServerUrl = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ login, changeServerUrl }) });

    await fireEvent.changeText(screen.getByLabelText("Server URL"), "https://other.example.net/");
    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Sign in"));

    await waitFor(() => expect(changeServerUrl).toHaveBeenCalledWith("https://other.example.net"));
    expect(login).toHaveBeenCalled();
  });

  it("keeps the default server URL when the field is untouched", async () => {
    const login = jest.fn(async () => {});
    const changeServerUrl = jest.fn(async () => {});
    await render(<LoginScreen />, { wrapper: withAuth({ login, changeServerUrl }) });

    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Sign in"));

    await waitFor(() => expect(login).toHaveBeenCalledWith("ada@example.com", "hunter2hunter"));
    expect(changeServerUrl).not.toHaveBeenCalled();
  });

  it("displays emergency recovery phrase modal when recoveryPhrase is present", async () => {
    const dismissRecoveryPhrase = jest.fn();
    await render(<LoginScreen />, {
      wrapper: withAuth({
        recoveryPhrase: "word1 word2 word3 word4",
        dismissRecoveryPhrase,
      }),
    });

    expect(screen.getByText("Emergency recovery phrase")).toBeTruthy();
    expect(screen.getByText("word1")).toBeTruthy();
    expect(screen.getByText("word4")).toBeTruthy();

    await fireEvent.press(screen.getByText("I have saved my recovery phrase"));
    expect(dismissRecoveryPhrase).toHaveBeenCalled();
  });

  it("says so when the account is gone for good", async () => {
    const login = jest.fn(async () => {
      throw new ApiError(403, "account_deleted", {
        error: "account_deleted",
        code: "account_deleted",
      });
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(await screen.findByText("This account has been deleted.")).toBeTruthy();
    expect(screen.queryByText("account_deleted")).toBeNull();
  });

  it("asks to wait after too many attempts", async () => {
    const login = jest.fn(async () => {
      throw new ApiError(429, "too many requests");
    });
    await render(<LoginScreen />, { wrapper: withAuth({ login }) });

    await fireEvent.press(screen.getByText("Sign in"));

    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
  });

  it("explains why the server ended the last session", async () => {
    await render(<LoginScreen />, {
      wrapper: withAuth({
        signOutNotice: { code: "account_scheduled_deletion", daysRemaining: 3 },
      }),
    });
    expect(screen.getByText(/scheduled for deletion in 3 days/)).toBeTruthy();
  });

  it("goes back from recovery to sign-in", async () => {
    await render(<LoginScreen />, { wrapper: withAuth({}) });

    await fireEvent.press(screen.getByText("Forgot your password? Recover with your phrase"));
    expect(screen.getByLabelText("24-word recovery phrase")).toBeTruthy();
    await fireEvent.press(screen.getByText("Back to sign in"));

    expect(screen.queryByLabelText("24-word recovery phrase")).toBeNull();
    expect(screen.getByText("Sign in")).toBeTruthy();
  });

  it("marks the email as the account name and moves on from it with Next", async () => {
    await render(<LoginScreen />, { wrapper: withAuth({}) });

    const email = screen.getByLabelText("Email");
    expect(email.props.returnKeyType).toBe("next");
    expect(email.props.autoComplete).toBe("username");
    expect(email.props.textContentType).toBe("username");
    expect(screen.getByLabelText("Password").props.autoComplete).toBe("current-password");
  });

  it("paints the web page from the dark: classes, not the JS scheme, so it matches the card", async () => {
    // Before sign-in NativeWind's JS scheme can still say "light" while <html> has `.dark`; the
    // card follows the class, so the page behind it must too.
    const origPlatform = Platform.OS;
    Platform.OS = "web";
    try {
      await render(<LoginScreen />, { wrapper: withAuth({}) });
      const page = screen.getByTestId("login-page");
      expect(page.props.className).toBe("bg-neutral-50 dark:bg-neutral-950");
      expect(StyleSheet.flatten(page.props.style)).not.toHaveProperty("backgroundColor");
    } finally {
      Platform.OS = origPlatform;
    }
  });

  it("paints the native page from the applied scheme", async () => {
    await render(<LoginScreen />, { wrapper: withAuth({}) });
    const style = StyleSheet.flatten(screen.getByTestId("login-page").props.style);
    expect(style).toMatchObject({ backgroundColor: "#fafafa" });
  });

  it("hides the server URL field on online web", async () => {
    const origPlatform = Platform.OS;
    Platform.OS = "web";
    try {
      await render(<LoginScreen />, { wrapper: withAuth({}) });
      expect(screen.queryByLabelText("Server URL")).toBeNull();
    } finally {
      Platform.OS = origPlatform;
    }
  });
});
