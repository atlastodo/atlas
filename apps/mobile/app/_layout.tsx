import "../src/lib/polyfillCrypto";
// Registers the native PBKDF2 fast path for the login KDF (no-op without the native module). Kept
// out of `polyfillCrypto` so the jest setup, which imports that, does not pull in the crypto stack.
import "../src/lib/nativePbkdf2";
// Registers the platform's Argon2id: WebAssembly on web and desktop, the native module on Android.
import "../src/lib/argon2id";
// Web: Tab skips the scroll containers Firefox makes focusable. See `skipScrollerFocus.web`.
import "../src/lib/skipScrollerFocus";
import { configureReanimatedLogger, ReanimatedLogLevel } from "react-native-reanimated";

configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

import { useEffect, useState } from "react";
import { View } from "react-native";
// Must stay above any import that pulls in NativeWind's runtime (including `nativewind` below and
// `../global.css`): that runtime seeds its colour scheme from `.dark` on <html> at import time.
// See `src/theme/bootScheme.web`.
import "../src/theme/bootScheme";
import { useColorScheme } from "nativewind";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider as NavigationThemeProvider,
  router,
  usePathname,
  type ErrorBoundaryProps,
} from "expo-router";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { SyncedTheme } from "../src/theme/SyncedTheme";
import { SystemBars } from "../src/theme/SystemBars";
import { StoreProvider } from "../src/data/StoreProvider";
import { ToastProvider } from "../src/data/ToastProvider";
import { SelectionProvider, useSelection } from "../src/data/SelectionProvider";
import {
  SelectionActionsProvider,
  useSelectionActions,
} from "../src/data/SelectionActionsProvider";
import { CursorProvider, useCursor } from "../src/data/CursorProvider";
import { CommandPaletteProvider, useCommandPalette } from "../src/data/CommandPaletteContext";
import { BottomChromeProvider } from "../src/data/BottomChromeContext";
import { SidebarProvider } from "../src/data/SidebarContext";
import { FocusProvider } from "../src/data/FocusProvider";
import { FocusBar } from "../src/ui/FocusBar";
import { OnboardingProvider } from "../src/data/OnboardingContext";
import { OnboardingModal } from "../src/ui/OnboardingModal";
import { PermissionExplainerHost } from "../src/ui/PermissionExplainerHost";
import { PersistentStorageExplainer } from "../src/ui/PersistentStorageExplainer";
import { PermissionsSheetHost } from "../src/ui/PermissionsSheet";
import { UpdateBanner } from "../src/ui/UpdateBanner";
import { NotificationsProvider } from "../src/data/NotificationsProvider";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { AuthGate } from "../src/auth/AuthGate";
import { LOCAL_SCOPE, LocalModeProvider } from "../src/auth/localMode";
import { RecoveryPhraseModal } from "../src/auth/RecoveryPhraseModal";
import { withAccent, headerThemeOptions, isDark, sceneBackground } from "../src/theme/navTheme";
import { DEFAULT_ACCENT } from "@atlastodo/shared";
import { useI18nLanguage } from "../src/hooks/useI18nLanguage";
import { useHapticsPref } from "../src/hooks/useHapticsPref";
import { useTrashSweep } from "../src/hooks/useTrash";
import { ProjectKeyMaintenance } from "../src/hooks/useProjectKeyMaintenance";
import { useReminderScheduler } from "../src/hooks/useReminderScheduler";
import { useHabitReminderScheduler } from "../src/hooks/useHabitReminderScheduler";
import { useHotkeys } from "../src/hooks/useHotkeys";
import { useCommands } from "../src/hooks/useCommands";
import { useTaskSearch } from "../src/hooks/useTaskSearch";
import { CommandPalette } from "../src/ui/CommandPalette";
import { ShortcutsModal } from "../src/ui/ShortcutsHelp";
import { TimezoneChangePrompt } from "../src/ui/TimezoneChangePrompt";
import { CrashScreen } from "../src/ui/CrashScreen";
import { useAutoReport } from "../src/hooks/useAutoReport";
import { useCrashDiagnostics } from "../src/hooks/useCrashDiagnostics";
import { useCrashReporter } from "../src/hooks/useCrashReporter";
import { setRoute } from "../src/lib/crashReporter";
import { rememberRoute } from "../src/lib/devRoute";
import { installGlobalErrorHandler } from "../src/lib/globalErrorHandler";
import "../src/i18n";
import "../global.css";

// At module scope so an error thrown while the first component mounts is still captured.
installGlobalErrorHandler();

export const unstable_settings = {
  initialRouteName: "(drawer)",
};

// The root navigator is a Stack whose first screen is the drawer+tabs shell, so a detail screen
// pushes over the shell (tab bar included) and gets the back gesture and hardware back for free.
// The components below read the store, so they mount inside StoreProvider.

/** Applies the synced language preference. */
function SyncedLanguage() {
  useI18nLanguage();
  return null;
}

/** Tracks the synced `haptics_enabled` preference into the `lib/haptics` gate. */
function SyncedHaptics() {
  useHapticsPref();
  return null;
}

/** Runs the once-per-session sweep that permanently purges items soft-deleted over 30 days ago. */
function TrashSweep() {
  useTrashSweep();
  return null;
}

/**
 * Copies the live sync diagnostics into the crash-reporter module: the root ErrorBoundary renders
 * above StoreProvider, so at crash time only this snapshot survives.
 */
function CrashDiagnostics() {
  useCrashDiagnostics();
  return null;
}

/**
 * Binds the API client into the crash reporter and drains the offline report queue. Mounted outside
 * the session gate so a crash while signed out is still delivered (`POST /reports` accepts anonymous).
 */
function CrashReporterBinding() {
  useCrashReporter();
  return null;
}

/**
 * Feeds the current route into the crash reporter as a breadcrumb and records it for the
 * development-only restore (`lib/devRoute`). Lives in a route file because only route files may
 * import expo-router's hooks; a screen under `src/` would drag the router into every jest module graph.
 */
function RouteBreadcrumbs() {
  const path = usePathname();
  useEffect(() => {
    setRoute(path, Date.now());
    rememberRoute(path);
  }, [path]);
  return null;
}

/**
 * The last line of defence: an error thrown above the drawer lands here with no providers left.
 * `app/(drawer)/_layout.tsx` and `app/task/[id].tsx` export their own boundaries, which catch first
 * and keep the store and sync alive.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const report = useAutoReport(error);
  // A boundary swallows the error; in development the red box's component stack is more useful.
  if (__DEV__) console.error(error);
  return <CrashScreen error={error} report={report} onRetry={() => void retry()} />;
}

/**
 * Drives reminder delivery: schedules future reminders with the OS and handles the Complete /
 * Snooze presses on their banners. The user id attributes a Complete pressed from a notification.
 */
function ReminderScheduler() {
  const { session } = useAuth();
  useReminderScheduler(session?.user.id);
  return null;
}

/** Books the per-habit nudges with the OS (native only). */
function HabitReminderScheduler() {
  useHabitReminderScheduler();
  return null;
}

/**
 * The global command palette and keyboard-shortcut layer (a no-op on native, a `window` keydown
 * listener on web). Lives in this route file so it may import `router`.
 */
function GlobalCommandPalette() {
  const { open, openPalette, closePalette } = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);
  const commands = useCommands();
  const search = useTaskSearch();
  const selection = useSelection();
  const selectionActions = useSelectionActions();
  const cursor = useCursor();
  // Wired only with a selection, so otherwise Cmd/Ctrl-C/X/D fall through to the browser default.
  const hasSelection = selection.count > 0;
  useHotkeys({
    openPalette,
    focusSearch: openPalette,
    openHelp: () => setHelpOpen(true),
    clearSelection: () => selection.clear(),
    // Declines when no list is registered, leaving the browser's own select-all.
    selectAll: () => selection.selectAll(),
    focusQuickAdd: () => cursor.focusQuickAdd(),
    copySelection: hasSelection ? () => selectionActions.copySelection() : undefined,
    duplicateSelection: hasSelection ? () => selectionActions.duplicateSelection() : undefined,
    cutSelection: hasSelection ? () => selectionActions.cutSelection() : undefined,
    cursorNext: () => cursor.next(),
    cursorPrev: () => cursor.prev(),
    openCursor: () => cursor.openCursor(),
    completeCursor: () => cursor.completeCursor(),
    rescheduleCursor: () => cursor.rescheduleCursor(),
    deleteCursor: () => cursor.deleteCursor(),
  });
  return (
    <>
      <CommandPalette
        visible={open}
        onClose={closePalette}
        commands={commands}
        onSelect={(command) => router.push(command.href)}
        search={search}
        onSelectTask={(task) => router.push(`/task/${task.id}`)}
      />
      <ShortcutsModal visible={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

/**
 * The auth gate (`AuthGate`): the unlock screen for a locked session, otherwise the app with a store
 * bound to the session, or, with no session, to the local-only database (no server, no sync). The
 * store, and sync, only mounts unlocked. Keyed by the database, so moving from local-only mode into
 * an account remounts everything on the account's store.
 *
 * `deviceId` is the session's (or this device's local one), never a constant: it is the HLC's final
 * tiebreak, so two devices sharing one id could order concurrent edits differently and fail to
 * converge.
 */
function Gate() {
  const { api, recoveryPhrase, dismissRecoveryPhrase } = useAuth();
  // The applied scheme (set by SyncedTheme), not the device's, so headers match the content.
  const { colorScheme: scheme } = useColorScheme();

  return (
    <AuthGate>
      {(gate) => (
        <StoreProvider
          key={gate.mode === "account" ? gate.session.user.id : LOCAL_SCOPE}
          api={gate.mode === "account" ? api : null}
          deviceId={gate.mode === "account" ? gate.session.deviceId : gate.deviceId}
          userId={gate.mode === "account" ? gate.session.user.id : LOCAL_SCOPE}
          keyring={gate.mode === "account" ? gate.keyring : null}
        >
          <RecoveryPhraseModal phrase={recoveryPhrase} onClose={dismissRecoveryPhrase} />
          <SyncedLanguage />
          <SyncedHaptics />
          <CrashDiagnostics />
          <TrashSweep />
          <ProjectKeyMaintenance />
          <ReminderScheduler />
          <HabitReminderScheduler />
          <TimezoneChangePrompt />
          {/* Inside the store, so theme/accent follow the synced preference. */}
          {/* Around the navigator so the drawer badge and Notifications screen share one invite list. */}
          <NotificationsProvider>
            <SyncedTheme>
              <FocusProvider>
                <ToastProvider>
                  {/* Wraps the whole navigator so multi-select also works on pushed routes. */}
                  <SelectionProvider>
                    <SelectionActionsProvider>
                      <CursorProvider>
                        <SidebarProvider>
                          {/* Tells the root-level focus pill how much bottom edge the phone nav takes. */}
                          <BottomChromeProvider>
                            <OnboardingProvider>
                              <CommandPaletteProvider>
                                <View className="flex-1 bg-white dark:bg-zinc-950">
                                  <UpdateBanner />
                                  {/* Theming the header here also covers the pushed task detail. */}
                                  <Stack
                                    screenOptions={{
                                      headerTitleAlign: "left",
                                      ...headerThemeOptions(scheme),
                                      contentStyle: { backgroundColor: sceneBackground(scheme) },
                                    }}
                                  >
                                    <Stack.Screen
                                      name="(drawer)"
                                      options={{ headerShown: false }}
                                    />
                                  </Stack>
                                  <FocusBar onOpen={() => router.push("/focus")} />
                                  <GlobalCommandPalette />
                                  <RouteBreadcrumbs />
                                  <OnboardingModal />
                                  {/* After the wizard, so its explainer draws over it. */}
                                  <PermissionExplainerHost />
                                  <PersistentStorageExplainer />
                                  <PermissionsSheetHost />
                                </View>
                              </CommandPaletteProvider>
                            </OnboardingProvider>
                          </BottomChromeProvider>
                        </SidebarProvider>
                      </CursorProvider>
                    </SelectionActionsProvider>
                  </SelectionProvider>
                </ToastProvider>
              </FocusProvider>
            </SyncedTheme>
          </NotificationsProvider>
        </StoreProvider>
      )}
    </AuthGate>
  );
}

export default function RootLayout() {
  const { colorScheme: scheme } = useColorScheme();
  const dark = isDark(scheme);
  return (
    // A style, not a className: NativeWind does not wrap GestureHandlerRootView, so its classes were
    // dropped and the window's default white showed wherever the screen above did not paint.
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: sceneBackground(scheme) }}>
      {/* Default accent for the login screen; SyncedTheme re-provides the synced one inside the store. */}
      <NavigationThemeProvider
        value={withAccent(dark ? DarkTheme : DefaultTheme, dark, DEFAULT_ACCENT)}
      >
        <ThemeProvider>
          <AuthProvider>
            <CrashReporterBinding />
            <LocalModeProvider>
              <Gate />
            </LocalModeProvider>
          </AuthProvider>
          <SystemBars scheme={scheme} />
        </ThemeProvider>
      </NavigationThemeProvider>
    </GestureHandlerRootView>
  );
}
