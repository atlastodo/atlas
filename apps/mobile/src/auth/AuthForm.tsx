import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ApiError,
  RecoveryPhraseError,
  ServerIncompatibleError,
  apiErrorCode,
} from "@atlas/client-core";
import { CircleAlert } from "../ui/icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useAuth, type SignOutNotice } from "./AuthContext";
import { defaultServerUrl, isOnlineWeb, loadServerUrl } from "./serverUrl";
import { readInviteFromLink } from "./inviteLink";
import { useLocalMode } from "./localMode";

/**
 * The sign-in / sign-up / recover form, shared by the standalone `LoginScreen` and the welcome
 * wizard's account form step, so the two cannot drift apart. {@link useAuthForm} holds the state
 * (the wizard keeps it while you step Back and forth); {@link AuthForm} renders the fields, the
 * submit button and the links that switch between the three modes in place.
 *
 * The server URL field is always visible (login, signup, recover) because the choice must precede
 * authentication: production builds ship no built-in default, and the account may not exist yet on
 * the instance being targeted. Submitting persists the override through `changeServerUrl`, which
 * rebuilds the API client before the auth calls run.
 *
 * Submitting from local-only mode records which way the user left it (`setUpgradeIntent`), which
 * decides how the local data moves into the account (`LocalUpgradeGate`).
 */

export type AuthMode = "login" | "signup" | "recover";

export interface AuthFormOptions {
  initialMode?: "login" | "signup";
  initialEmail?: string;
  /** A new account carries on in the welcome wizard once its app mounts (the wizard's form). */
  resumeOnboardingOnSignup?: boolean;
}

export function useAuthForm({
  initialMode,
  initialEmail,
  resumeOnboardingOnSignup = false,
}: AuthFormOptions = {}) {
  const { t } = useTranslation();
  const local = useLocalMode();
  const { login, signup, recoverAccount, cancelAccountDeletion, changeServerUrl } = useAuth();
  // An admin's invite link (web) opens straight into signup with its code filled in.
  const [inviteFromLink] = useState(readInviteFromLink);
  const [invite, setInvite] = useState(inviteFromLink);
  const [mode, setModeState] = useState<AuthMode>(
    inviteFromLink ? "signup" : (initialMode ?? "login"),
  );
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Starts at the build-time default (dev: localhost; empty if none was baked in), then is
  // reconciled with any stored override once AsyncStorage resolves.
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  // What the client is currently bound to; submit rebinds only on a difference.
  const [effectiveUrl, setEffectiveUrl] = useState(defaultServerUrl);
  const [error, setError] = useState<string | null>(null);
  const [isScheduledDeletion, setIsScheduledDeletion] = useState(false);
  const [deletionDaysRemaining, setDeletionDaysRemaining] = useState(30);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadServerUrl().then((url) => {
      if (live) {
        setServerUrl(url);
        setEffectiveUrl(url);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  /** Switch between sign-in, signup and recover, keeping what was typed. */
  const setMode = (next: AuthMode) => {
    setModeState(next);
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    setIsScheduledDeletion(false);

    // The server URL must be resolved before any auth call (see the module docs).
    const isOnline = isOnlineWeb();
    const url = (isOnline ? defaultServerUrl : serverUrl).trim().replace(/\/$/, "");
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setError(t("auth.serverUrlRequired"));
      return;
    }

    setBusy(true);
    local?.setUpgradeIntent(mode === "signup" ? "signup" : "login", {
      resumeOnboarding: resumeOnboardingOnSignup && mode === "signup",
    });
    try {
      if (url !== effectiveUrl) await changeServerUrl(url);
      if (mode === "login") {
        await login(email, password);
      } else if (mode === "signup") {
        // A closed instance still admits a single signup through an invite code.
        await signup(email, password, displayName, invite.trim() || undefined);
      } else {
        await recoverAccount(email, recoveryInput.trim(), password);
      }
    } catch (err) {
      if (
        mode === "recover" &&
        (err instanceof RecoveryPhraseError || (err instanceof ApiError && err.status === 401))
      ) {
        // A wrong phrase fails before anything is posted; a 401 from /auth/recover means the same.
        setError(t("unlock.recoveryPhraseInvalid"));
      } else if (err instanceof ServerIncompatibleError) {
        setError(
          err.incompatibility.reason === "apps"
            ? t("auth.serverMissingApp")
            : t("auth.serverTooOld"),
        );
      } else if (err instanceof ApiError) {
        if (err.message === "account_scheduled_deletion") {
          const remaining = (err.data as { days_remaining?: unknown } | undefined)?.days_remaining;
          const days = typeof remaining === "number" ? remaining : 30;
          setDeletionDaysRemaining(days);
          setIsScheduledDeletion(true);
          setShowRestoreModal(true);
          setError(t("auth.scheduledForDeletion"));
        } else {
          setError(describeAuthError(err, t));
        }
      } else {
        setError(t("auth.genericError"));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await cancelAccountDeletion(email, password);
      setShowRestoreModal(false);
    } catch (err) {
      setError(err instanceof ApiError ? describeAuthError(err, t) : t("auth.genericError"));
    } finally {
      setBusy(false);
    }
  };

  return {
    mode,
    setMode,
    email,
    setEmail,
    password,
    setPassword,
    recoveryInput,
    setRecoveryInput,
    displayName,
    setDisplayName,
    invite,
    setInvite,
    serverUrl,
    setServerUrl,
    error,
    isScheduledDeletion,
    deletionDaysRemaining,
    showRestoreModal,
    setShowRestoreModal,
    busy,
    submit,
    handleRestore,
  };
}

export type AuthFormState = ReturnType<typeof useAuthForm>;

/**
 * The form's fields, error, submit button and mode links. `banner` renders above the fields (a
 * notice, a sign-out reason); `footer` below the links (the standalone screen's way back to the
 * local app).
 */
export function AuthForm({
  form,
  banner,
  footer,
}: {
  form: AuthFormState;
  banner?: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    mode,
    setMode,
    email,
    setEmail,
    password,
    setPassword,
    recoveryInput,
    setRecoveryInput,
    displayName,
    setDisplayName,
    invite,
    setInvite,
    serverUrl,
    setServerUrl,
    error,
    isScheduledDeletion,
    deletionDaysRemaining,
    showRestoreModal,
    setShowRestoreModal,
    busy,
    submit,
    handleRestore,
  } = form;
  // Return on one field moves to the next, as a credential form should.
  const emailRef = useRef<TextInput>(null);
  const phraseRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  return (
    <>
      {banner}
      <View className="gap-3">
        {mode === "signup" && (
          <Field
            label={t("auth.name")}
            value={displayName}
            onChange={setDisplayName}
            textContentType="name"
            autoComplete="name"
            returnKeyType="next"
            onSubmitEditing={() => emailRef.current?.focus()}
          />
        )}
        <Field
          label={t("auth.email")}
          value={email}
          onChange={setEmail}
          inputRef={emailRef}
          keyboardType="email-address"
          // The account name for credential managers, which pair "username" with the password
          // field below to offer, and to save, a login.
          textContentType="username"
          autoComplete="username"
          returnKeyType="next"
          onSubmitEditing={() => (mode === "recover" ? phraseRef : passwordRef).current?.focus()}
        />
        {mode === "recover" && (
          <Field
            label={t("recovery.phraseLabel")}
            value={recoveryInput}
            onChange={setRecoveryInput}
            inputRef={phraseRef}
            autoComplete="off"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
        )}
        <Field
          label={mode === "recover" ? t("auth.newPassword") : t("auth.password")}
          value={password}
          onChange={setPassword}
          inputRef={passwordRef}
          secureTextEntry
          textContentType={mode === "login" ? "password" : "newPassword"}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          onSubmitEditing={submit}
        />
        {mode === "signup" && (
          <Field
            label={t("auth.inviteCode")}
            value={invite}
            onChange={setInvite}
            autoComplete="off"
            placeholder={t("auth.inviteCodePlaceholder")}
          />
        )}
        {!isOnlineWeb() && (
          <Field
            label={t("auth.serverUrl")}
            value={serverUrl}
            onChange={setServerUrl}
            keyboardType="url"
            textContentType="URL"
            placeholder={t("auth.serverUrlPlaceholder")}
          />
        )}

        {error !== null && (
          <Pressable
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            onPress={isScheduledDeletion ? () => setShowRestoreModal(true) : undefined}
            className="flex-row items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30"
          >
            <CircleAlert size={18} className="shrink-0 text-red-600 dark:text-red-400" />
            <Text className="flex-1 text-sm font-medium text-red-600 dark:text-red-400">
              {error}
            </Text>
          </Pressable>
        )}

        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={submit}
          className={
            "mt-1 flex-row items-center justify-center gap-2 rounded-md bg-accent-600 px-3 py-3 active:bg-accent-500 " +
            (busy ? "opacity-60" : "")
          }
        >
          {busy && <ActivityIndicator color="white" size="small" />}
          <Text className="text-sm font-medium text-white">
            {mode === "login"
              ? t("auth.signIn")
              : mode === "signup"
                ? t("auth.createAccount")
                : t("auth.resetAndRecover")}
          </Text>
        </Pressable>
      </View>

      <View className="mt-4 gap-1">
        {mode === "login" && (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode("signup")}
              className="py-1"
            >
              <Text className="text-center text-sm text-accent-600 dark:text-accent-400">
                {t("auth.needAccount")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setMode("recover")}
              className="py-1"
            >
              <Text className="text-center text-xs text-neutral-500 dark:text-neutral-400">
                {t("auth.forgotPassword")}
              </Text>
            </Pressable>
          </>
        )}

        {mode === "signup" && (
          <Pressable accessibilityRole="button" onPress={() => setMode("login")} className="py-1">
            <Text className="text-center text-sm text-accent-600 dark:text-accent-400">
              {t("auth.haveAccount")}
            </Text>
          </Pressable>
        )}

        {mode === "recover" && (
          <Pressable accessibilityRole="button" onPress={() => setMode("login")} className="py-1">
            <Text className="text-center text-sm text-accent-600 dark:text-accent-400">
              {t("auth.backToSignIn")}
            </Text>
          </Pressable>
        )}

        {footer}
      </View>

      <ConfirmDialog
        visible={showRestoreModal}
        title={t("auth.scheduledForDeletion")}
        message={t("auth.scheduledForDeletionDetail", { count: deletionDaysRemaining })}
        confirmLabel={t("auth.cancelDeletionAndRestore")}
        cancelLabel={t("common.close")}
        danger={false}
        onConfirm={handleRestore}
        onCancel={() => setShowRestoreModal(false)}
      />
    </>
  );
}

/** The user-facing text for an auth failure, by the server's code where it sends one. */
export function describeAuthError(err: ApiError, t: TFunction): string {
  const code = apiErrorCode(err) ?? err.message;
  switch (code) {
    case "legacy_account":
      return t("auth.legacyAccount");
    case "account_deleted":
      return t("auth.accountDeleted");
    case "account_disabled":
      return t("auth.accountDisabled");
    case "signup_disabled":
      return t("auth.signupDisabled");
    case "invite_invalid":
      return t("auth.inviteInvalid");
  }
  if (err.status === 429) return t("auth.tooManyAttempts");
  if (
    err.status === 401 &&
    (err.message === "unauthorized" || err.message === "invalid credentials")
  ) {
    return t("auth.invalidCredentials");
  }
  return err.message;
}

/** Why the server ended the last session (see `SignOutNotice`). */
export function describeSignOutNotice(notice: SignOutNotice, t: TFunction): string {
  switch (notice.code) {
    case "account_disabled":
      return t("auth.accountDisabled");
    case "account_deleted":
      return t("auth.accountDeleted");
    case "account_scheduled_deletion":
      return notice.daysRemaining === undefined
        ? t("auth.sessionEndedScheduledSoon")
        : t("auth.sessionEndedScheduled", { count: notice.daysRemaining });
  }
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboardType?: KeyboardTypeOptions;
  secureTextEntry?: boolean;
  placeholder?: string;
  textContentType?: TextInputProps["textContentType"];
  autoComplete?: TextInputProps["autoComplete"];
  returnKeyType?: TextInputProps["returnKeyType"];
  onSubmitEditing?: () => void;
  inputRef?: Ref<TextInput>;
}

function Field({ label, value, onChange, inputRef, ...input }: FieldProps) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-neutral-600 dark:text-neutral-400">{label}</Text>
      <TextInput
        // The label is the accessible name; an RN TextInput has no <label for>.
        accessibilityLabel={label}
        ref={inputRef}
        value={value}
        // A "next" field hands focus on without the keyboard closing in between.
        submitBehavior={input.returnKeyType === "next" ? "submit" : undefined}
        onChangeText={onChange}
        // iOS would otherwise capitalise an email ("Ada@...") and the sign-in would fail invisibly.
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        {...input}
      />
    </View>
  );
}
