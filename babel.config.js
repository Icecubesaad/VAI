module.exports = function (api) {
  api.cache(true);
  return {
    // NativeWind v4 official setup: jsxImportSource + preset.
    // Keep babel-preset-expo FIRST; if reanimated is added later,
    // 'react-native-reanimated/plugin' must be LAST in plugins.
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};
