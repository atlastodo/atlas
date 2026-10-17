import { render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { OnboardingProvider } from "../data/OnboardingContext";
import { OnboardingModal } from "../ui/OnboardingModal";
import OnboardingRoute from "../../app/(drawer)/onboarding";

/**
 * expo-router's own test renderer needs untranspiled ESM this jest setup does not transform, so the
 * two router primitives the route uses are stood in for: a focus effect that runs on mount, and a
 * redirect that shows where it points.
 */
jest.mock("expo-router", () => {
  const { useEffect: useMountEffect } = jest.requireActual<typeof import("react")>("react");
  const { Text: RNText } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    useFocusEffect: (effect: () => void) => useMountEffect(effect, [effect]),
    Redirect: ({ href }: { href: string }) => <RNText>{`redirect ${href}`}</RNText>,
  };
});

describe("/onboarding route", () => {
  it("opens the app's one wizard and moves on to the default view", async () => {
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "onboarding_completed", true);
    store.set("preference", PREFERENCES_ID, "default_view", "inbox");
    const App = withApp(store);
    await render(
      <App>
        <OnboardingProvider>
          <OnboardingRoute />
          {/* The app-level wizard, as the root layout mounts it. */}
          <OnboardingModal />
        </OnboardingProvider>
      </App>,
    );

    // Exactly one wizard: the route must not stack a second one over the root's.
    expect(screen.getAllByText("Welcome to Atlas Todo")).toHaveLength(1);
    expect(screen.getByText("redirect /inbox")).toBeTruthy();
  });
});
