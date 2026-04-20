// All MACRO.* values are baked in at build time by the bun build --define
// flag (see package.json `build` script). They are always present at runtime,
// so we type them as required strings to avoid forcing every callsite to
// guard against `undefined`.
declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  FEEDBACK_CHANNEL: string
  ISSUES_EXPLAINER: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
}
