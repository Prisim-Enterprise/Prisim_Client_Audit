import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#101a2b",
          900: "#172438",
          800: "#24344b",
        },
        accent: {
          50: "#effaf8",
          100: "#d8f3ee",
          500: "#168a78",
          600: "#117564",
          700: "#0f5d51",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgb(16 26 43 / 0.04), 0 8px 24px rgb(16 26 43 / 0.04)",
      },
    },
  },
  plugins: [],
} satisfies Config;
