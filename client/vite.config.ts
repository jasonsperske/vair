import { defineConfig } from "vite";

const SERVER_PORT = process.env.VAIR_SERVER_PORT ?? "8787";

export default defineConfig({
  server: {
    // Loopback by default. `adb reverse tcp:5173 tcp:5173` (plan.md §15) gives
    // the headset a localhost origin, which is a secure origin — that is what
    // getUserMedia and WebXR require, and it needs no LAN exposure at all.
    // VAIR_LAN=1 opens it up for the rare case where USB is not an option.
    host: process.env.VAIR_LAN === "1" ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
