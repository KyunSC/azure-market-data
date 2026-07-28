/**
 * Tailwind is used by the `/backtest` route only. The plugin runs over every
 * CSS file, but it emits nothing for files that contain no Tailwind at-rules —
 * `app/globals.css` passes through untouched.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
