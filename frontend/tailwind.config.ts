import type { Config } from 'tailwindcss';

// Brand: Outvexa purple #4F26FC (logo) with a deep navy ink #070C1C. Neutrals are tinted towards the navy so every
// screen that uses the "slate" utilities picks up the same family without being rewritten.
export default {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#f4f1ff', 100: '#eae4ff', 200: '#d6cdff', 300: '#b6a6ff', 400: '#8f74ff', 500: '#6a45fd', 600: '#4f26fc', 700: '#411be0', 800: '#3618b5', 900: '#2e178f', 950: '#1b0c57' },
        ink: { DEFAULT: '#0b1020', 800: '#141a2e', 700: '#222a42', 600: '#384059', 400: '#8a90a8', 300: '#b9bdd0', 200: '#d8dbe7', 100: '#eef0f6' },
        slate: { 50: '#f7f7fb', 100: '#f0f1f7', 200: '#e3e5ef', 300: '#cfd2e0', 400: '#9ea2b8', 500: '#71768d', 600: '#555a71', 700: '#414659', 800: '#2a2f42', 900: '#1b1f2e', 950: '#10131e' },
        paper: '#f6f7fb',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Bricolage Grotesque Variable"', '"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgb(11 16 32 / 0.04)', pop: '0 16px 40px -12px rgb(11 16 32 / 0.35)', brand: '0 6px 16px -6px rgb(79 38 252 / 0.5)' },
    },
  },
  plugins: [],
} satisfies Config;
