/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * The frontend runs on its own Node server (Vite dev server, or `vite preview`
 * for a production build) on port 5173. API and auth calls go to the separate
 * backend through this proxy, so the browser sees one origin and the session
 * cookie stays first-party.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "CONSOLE_");
  const backend = env.CONSOLE_BACKEND_URL ?? "http://localhost:4000";
  const proxy = {
    "/api": { target: backend, changeOrigin: false },
    "/auth": { target: backend, changeOrigin: false },
  };
  const securityHeaders = {
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 5173, strictPort: true, proxy, headers: securityHeaders },
    build: {
      sourcemap: true,
      target: "es2022",
      // Never inline fonts as data: URIs; the CSP allows fonts from 'self' only.
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      css: false,
    },
  };
});
