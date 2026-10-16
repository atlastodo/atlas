/**
 * Jest setup for the RN app: the libraries' own test doubles for native modules that do not exist
 * in a node process (reanimated, worklets, AsyncStorage). Our own modules are not mocked here.
 *
 * Reanimated reaches for react-native-worklets at import, so worklets' official `src/mock` must be
 * registered before reanimated's `setUpTests()`. A custom jest `resolver` is not an option: jest-expo
 * already sets the only one jest allows.
 */
jest.mock("react-native-worklets", () => jest.requireActual("react-native-worklets/src/mock"));
jest
  .requireActual<typeof import("react-native-reanimated")>("react-native-reanimated")
  .setUpTests();
jest.requireActual("./src/lib/polyfillCrypto");

// Tests assume the default server URL; a CI that sets EXPO_PUBLIC_API_URL for release jobs must not change that.
delete process.env.EXPO_PUBLIC_API_URL;

// Real crypto runs in these tests and can outlast the 1 s default for findBy*/waitFor on a loaded runner.
jest
  .requireActual<typeof import("@testing-library/react-native")>("@testing-library/react-native")
  .configure({ asyncUtilTimeout: 15_000 });

/**
 * The jsdom environment has no `TextEncoder`/`TextDecoder` (jest swaps in jsdom's globals), and
 * `@noble/hashes` calls `utf8ToBytes` at import, so web-env suites importing the store would die.
 */
if (typeof globalThis.TextEncoder === "undefined") {
  const util = jest.requireActual<{
    TextEncoder: typeof globalThis.TextEncoder;
    TextDecoder: typeof globalThis.TextDecoder;
  }>("util");
  globalThis.TextEncoder = util.TextEncoder;
  globalThis.TextDecoder = util.TextDecoder;
}

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

/**
 * `expo-clipboard` has no jest double and `copyText` swallows its rejection, so a copy test would
 * pass while copying nothing. This in-memory double records the last string; read it with
 * `lastCopiedText()` from `src/testutil`.
 */
jest.mock("expo-clipboard", () => {
  let current = "";
  return {
    __esModule: true,
    setStringAsync: jest.fn(async (text: string) => {
      current = text;
      return true;
    }),
    getStringAsync: jest.fn(async () => current),
  };
});

/**
 * `expo-audio` has no jest double and reads its native module at import, which every screen reaches
 * through the focus chime. The chime is fire-and-forget, so a no-op player suffices.
 */
jest.mock("expo-audio", () => ({
  __esModule: true,
  createAudioPlayer: () => ({
    play: () => {},
    pause: () => {},
    seekTo: () => {},
    remove: () => {},
  }),
}));

/**
 * expo-notifications subscribes its handler module at import, and jest-expo's double of that
 * module answers `addListener` with nothing, so the `remove()` in `setNotificationHandler` throws.
 * This double hands back a removable subscription.
 */
jest.mock("expo-notifications/build/NotificationsHandlerModule", () => ({
  __esModule: true,
  default: {
    addListener: () => ({ remove: () => {} }),
    handleNotificationAsync: jest.fn(async () => {}),
  },
}));

/**
 * gesture-handler 3's GestureDetector throws unless a GestureHandlerRootView is above it, which the
 * app's root layout provides and a component test does not. Default the context to "inside a root".
 */
jest.mock("react-native-gesture-handler/lib/module/GestureHandlerRootViewContext", () => ({
  __esModule: true,
  default: jest.requireActual<typeof import("react")>("react").createContext(true),
}));

/** The library's own double: zero insets, so components reading insets render without a provider. */
jest.mock(
  "react-native-safe-area-context",
  () =>
    // The 5.x mock is a `default` export object; unwrap it to expose the named hooks.
    jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// Declared out here because a jest.mock factory may only reference outside names starting with `mock`.
type MockNode = import("react").ReactNode;
type MockListProps = {
  data: unknown[];
  renderItem: (info: { item: unknown; index: number }) => MockNode;
  keyExtractor: (item: unknown, index: number) => string;
  onReorder: (event: { from: number; to: number }) => void;
  ListHeaderComponent?: MockNode;
  ListEmptyComponent?: MockNode;
  ListFooterComponent?: MockNode;
};

/**
 * `react-native-reorderable-list` needs a real gesture, so this double is a plain list with an
 * `onReorder` trigger: a button labelled `reorder:<first-key>` that moves the first row to the last
 * position. Tests press it and check the persisted rank against `reorderRank`.
 */
jest.mock("react-native-reorderable-list", () => {
  const R = jest.requireActual<typeof import("react")>("react");
  const RN = jest.requireActual<typeof import("react-native")>("react-native");
  const ReorderableList = (props: MockListProps) => {
    const { data, renderItem, keyExtractor, onReorder } = props;
    const rows = data.map((item: unknown, index: number) =>
      R.createElement(R.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })),
    );
    const trigger =
      data.length > 0
        ? R.createElement(
            RN.Pressable,
            {
              accessibilityRole: "button",
              accessibilityLabel: `reorder:${keyExtractor(data[0], 0)}`,
              onPress: () => onReorder({ from: 0, to: data.length - 1 }),
            },
            R.createElement(RN.Text, null, "reorder"),
          )
        : null;
    return R.createElement(
      RN.View,
      null,
      props.ListHeaderComponent,
      data.length === 0 ? props.ListEmptyComponent : rows,
      props.ListFooterComponent,
      trigger,
    );
  };
  // Stable, like the library's per-cell lift: memoised task rows take it as a prop.
  const lift = () => {};
  // The nested list behaves like the flat one and the container is a passthrough view.
  const ScrollViewContainer = (props: { children?: MockNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    __esModule: true,
    default: ReorderableList,
    NestedReorderableList: ReorderableList,
    ScrollViewContainer,
    useReorderableDrag: () => lift,
  };
});

/** Initialise i18n (synchronous, the catalogs are bundled) so `t()` resolves to real copy. */
jest.requireActual("./src/i18n");

/**
 * A list schedules its next render window on a plain 50 ms `setTimeout` (`_scheduleCellsToRenderUpdate`).
 * In a test that timer can fire between a test's last assertion and the unmount that would have
 * cancelled it, and React then reports a state update outside `act`. Production has no `act`; the
 * test double runs the timer's callback inside one, which changes no behaviour, only the warning.
 */
{
  const { VirtualizedList } = jest.requireActual<typeof import("react-native")>("react-native");
  // React's own synchronous `act`: RNTL 14's is always async and must be awaited, which a timer
  // callback cannot do (an unawaited one is reported and interleaves with the test's own scopes).
  const { act } = jest.requireActual<typeof import("react")>("react");
  const proto = VirtualizedList.prototype as unknown as {
    _scheduleCellsToRenderUpdate: (...args: unknown[]) => unknown;
  };
  const schedule = proto._scheduleCellsToRenderUpdate;
  // A private method: if a React Native upgrade drops it, the warning comes back, nothing breaks.
  if (typeof schedule === "function")
    proto._scheduleCellsToRenderUpdate = function (this: unknown, ...args: unknown[]) {
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void, ...rest: unknown[]) =>
        realSetTimeout(
          () => {
            act(() => callback());
          },
          ...(rest as [number]),
        )) as typeof setTimeout;
      try {
        return schedule.apply(this, args);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    };
}
