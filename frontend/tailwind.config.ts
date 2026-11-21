import type { Config } from 'tailwindcss';

// Brand: EMN magenta #d134a0. Neutrals are tinted towards it (mauve-grey) so every screen that
// uses the "slate" utilities picks up the same family without being rewritten.
export default {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#fdf2f9', 100: '#fce4f3', 200: '#f9c8e7', 300: '#f29dd2', 400: '#e566b8', 500: '#d134a0', 600: '#c62f96', 700: '#a2247a', 800: '#861f65', 900: '#6f1d54', 950: '#450b31' },
        ink: { DEFAULT: '#1b1220', 800: '#251a2b', 700: '#34263b', 600: '#4a3a52', 400: '#9a8ba3', 300: '#c4b8cb', 200: '#ddd4e2', 100: '#f0ebf3' },
        slate: { 50: '#f8f6f9', 100: '#f1eef3', 200: '#e5e0e9', 300: '#d2cbd8', 400: '#a59cad', 500: '#786f80', 600: '#5c5364', 700: '#463e4d', 800: '#2e2734', 900: '#1f1924', 950: '#130e17' },
        paper: '#f7f5f8',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Bricolage Grotesque Variable"', '"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgb(27 18 32 / 0.04)', pop: '0 16px 40px -12px rgb(27 18 32 / 0.35)', brand: '0 6px 16px -6px rgb(198 47 150 / 0.55)' },
    },
  },
  plugins: [],
} satisfies Config;
