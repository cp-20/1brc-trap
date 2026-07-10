import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        ...(process.env.DEV_AUTH_USER
          ? { headers: { "X-Forwarded-User": process.env.DEV_AUTH_USER } }
          : {}),
      },
    },
  },
});
