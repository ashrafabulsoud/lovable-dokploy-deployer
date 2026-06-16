// Isolated build config for self-hosting Lovable "TanStack Start" apps (Dokploy / any Docker host).
// Kept SEPARATE from vite.config.ts so Lovable's managed config is never touched.
//
// Outside Lovable's sandbox, `vite build` is otherwise Vite-only (no HTML shell, no server),
// so we pick a real deploy target via DEPLOY_TARGET:
//   DEPLOY_TARGET=spa  -> SPA mode: prerenders dist/client/_shell.html (served as index.html by nginx)
//   DEPLOY_TARGET=ssr  -> Node server: emits .output/server/index.mjs (run with `node`)
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const target = process.env.DEPLOY_TARGET ?? "spa";

export default defineConfig(
  target === "ssr"
    ? { nitro: { preset: "node-server" } }
    : { tanstackStart: { spa: { enabled: true } } },
);
