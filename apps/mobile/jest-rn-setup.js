/**
 * React Native's jest setup, made safe for the jsdom suites. It defines `window` as the global, which
 * Jest 30's jsdom environment already owns as a non-configurable property, so the setup throws
 * before any test runs. Under jsdom that `window` is already the global, so the definition is
 * dropped there; the native environment runs the setup unchanged.
 */
const owned = Object.getOwnPropertyDescriptor(globalThis, "window");
if (owned && !owned.configurable) {
  const defineProperties = Object.defineProperties;
  Object.defineProperties = (target, props) => {
    if (target === globalThis && "window" in props) {
      const { window: _window, ...rest } = props;
      return defineProperties(target, rest);
    }
    return defineProperties(target, props);
  };
  try {
    require(require("jest-expo/jest-preset").setupFiles[0]);
  } finally {
    Object.defineProperties = defineProperties;
  }
} else {
  require(require("jest-expo/jest-preset").setupFiles[0]);
}
