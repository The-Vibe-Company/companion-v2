/**
 * Tailwind runs for one surface: the Companion thread. `src/styles/chat.css` imports its utilities
 * with `source(none)` and names the three directories the thread is built from, so no other page
 * gains a utility.
 *
 * Adding this file does have one app-wide consequence, stated here rather than left to be
 * discovered: Next injects `postcss-flexbugs-fixes` and `postcss-preset-env` only while no PostCSS
 * config exists, so that chain is now gone for every stylesheet in this app. That is deliberate.
 * Restating the chain here was tried and is worse: outside Next, `postcss-preset-env` resolves its
 * own browser floor rather than the framework's, and at that floor it rewrites the modern selectors
 * and colour functions these stylesheets are written in — the login page broke outright. The
 * stylesheets already target browsers that need no prefixing: they use `oklch()`, `:has()`, `dvh`,
 * and cascade layers throughout, none of which a prefixer would help with, and Lightning CSS inside
 * `@tailwindcss/postcss` still prefixes for its own targets on build.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
