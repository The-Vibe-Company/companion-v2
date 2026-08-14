/**
 * Tailwind runs for one surface: the Companion thread. Every other page in this app is written in
 * the hand-authored stylesheets under `src/styles`, and they keep working because `chat.css` imports
 * Tailwind's theme and utilities without its preflight — see the scoped mini-preflight there.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
