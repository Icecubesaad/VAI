// @ts-check
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/**
 * Minimal flat config — unblocks `npm run lint` (`expo lint`).
 * Standard Expo + TypeScript rules only, no extra plugins.
 * Run `npx expo install --fix` first so eslint-config-expo resolves
 * to the SDK 57 line.
 */
module.exports = defineConfig([
  ...expoConfig,
  {
    ignores: ['dist/*'],
  },
]);
