/**
 * jest allows one `resolver`, and two are needed: jest-expo's (React Native's, which strips
 * `react-native`'s `exports` map) and reanimated's (which resolves its JS-only initializers and
 * worklets' modules without the `.native` extensions, since there is no native runtime here).
 * Reanimated's runs first and hands what it does not rewrite on to React Native's.
 */
const reanimatedResolver = require("react-native-reanimated/jest/resolver");
const reactNativeResolver = require(require("jest-expo/jest-preset").resolver);

/** @type {import('jest-resolve').SyncResolver} */
module.exports = (request, options) =>
  reanimatedResolver(request, {
    ...options,
    defaultResolver: (r, o) =>
      reactNativeResolver(r, { ...o, defaultResolver: options.defaultResolver }),
  });
