import daisyui from "daisyui";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/admin/views/**/*.ejs",
    "./src/**/*.{ts,tsx,js,jsx}",
    "./public/**/*.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "-apple-system", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        // Paleta escura neutra (slate/zinc) com verde de destaque (PIX).
        // Nome "dark" mantém compatibilidade com o toggle existente, que
        // grava data-theme="dark"/"light" no <html> (ver partials/header.ejs).
        dark: {
          primary: "#22c55e",
          "primary-content": "#052e16",
          secondary: "#34d399",
          accent: "#16a34a",
          neutral: "#27272a",
          "base-100": "#0f1115",
          "base-200": "#1a1d24",
          "base-300": "#27272a",
          "base-content": "#e6e6e6",
          info: "#38bdf8",
          success: "#4ade80",
          warning: "#facc15",
          error: "#f87171",
        },
      },
      {
        light: {
          primary: "#16a34a",
          "primary-content": "#f0fdf4",
          secondary: "#059669",
          accent: "#22c55e",
          neutral: "#e4e4e7",
          "base-100": "#f5f5f7",
          "base-200": "#ffffff",
          "base-300": "#e4e4e7",
          "base-content": "#24262b",
          info: "#0284c7",
          success: "#16a34a",
          warning: "#ca8a04",
          error: "#dc2626",
        },
      },
    ],
    darkTheme: "dark",
  },
};
