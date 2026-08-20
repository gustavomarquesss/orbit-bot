import daisyui from "daisyui";

// Paleta exata do design de referência do usuário (vermelho de marca + cinza
// neutro, escala 50→950) — sobrescreve o red/gray padrão do Tailwind pra
// bg-red-600/text-gray-400/etc baterem com o hex exato pedido, em vez de
// aproximar pelos tons padrão do Tailwind (que são ligeiramente diferentes).
const red = {
  50: "#FFF1F1",
  100: "#FFE1E1",
  200: "#FFC7C7",
  300: "#FFA0A0",
  400: "#FF6B6B",
  500: "#F53D4D",
  600: "#E11D33",
  700: "#BC1226",
  800: "#9B1225",
  900: "#7F1524",
  950: "#450A10",
};
const gray = {
  50: "#FAFAFA",
  100: "#F4F4F5",
  200: "#E4E4E7",
  300: "#D4D4D8",
  400: "#A1A1AA",
  500: "#71717A",
  600: "#52525B",
  700: "#3F3F46",
  800: "#27272A",
  900: "#18181B",
  950: "#09090B",
};

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/admin/views/**/*.ejs",
    "./src/**/*.{ts,tsx,js,jsx}",
    "./public/**/*.js",
  ],
  theme: {
    extend: {
      colors: { red, gray },
      fontFamily: {
        sans: ["Inter", "-apple-system", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        // Regra do design de referência: nunca repetir o mesmo tom de
        // vermelho nos dois modos — mais claro no escuro (red-400),
        // mais escuro no claro (red-600) — é isso que evita o efeito "cru".
        dark: {
          primary: red[400],
          "primary-content": gray[900],
          secondary: red[300],
          accent: red[500],
          neutral: gray[800],
          "base-100": gray[950],
          "base-200": gray[900],
          "base-300": gray[800],
          "base-content": gray[50],
          info: "#38bdf8",
          success: "#4ade80",
          warning: "#facc15",
          error: "#f87171",
        },
      },
      {
        light: {
          primary: red[600],
          "primary-content": gray[50],
          secondary: red[500],
          accent: red[700],
          neutral: gray[200],
          "base-100": gray[50],
          "base-200": "#ffffff",
          "base-300": gray[200],
          "base-content": gray[900],
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
