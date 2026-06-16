# Lovable → Dokploy deploy kit

Reusable files + a one-command script to host **Lovable "TanStack Start"** projects on
**Dokploy**, with auto-deploy on every GitHub push.

Why a kit is needed: outside Lovable's sandbox, `vite build` produces a client bundle + an SSR
handler but **no `index.html` and no runnable server** — so Nixpacks/buildpacks have nothing to
start and plain "Static" has nothing to serve. These files give the build a real target.

The same files work **unchanged on any Lovable TanStack Start repo** (they all share
`@lovable.dev/vite-tanstack-config`).

## Two flavors

| Flavor | What runs | Use for | Port |
|---|---|---|---|
| **static** (default) | nginx serving a prerendered SPA | landing / marketing pages | 80 |
| **ssr** | the real Node app server (`node-server` preset) | apps using server functions / SSR / dynamic routes | 3000 |

Both prerender your `<head>` SEO/OG tags. SSR additionally renders the full body server-side.

## Files

```
deploy-kit/
  Dockerfile.static       # SPA -> nginx
  Dockerfile.ssr          # Node SSR server
  vite.deploy.config.ts   # isolated build config (DEPLOY_TARGET=spa|ssr); leaves vite.config.ts untouched
  nginx.conf              # SPA fallback + immutable asset caching (static flavor only)
  .dockerignore
  deploy-lovable.sh       # CLI automation: copies kit, pushes, creates+deploys the Dokploy app
  webapp/                 # interactive web app (npm start) — same flow in the browser
  README.md
```

## Prerequisites (one-time)

1. **Dokploy GitHub App connected** to your account (Dokploy → Git → GitHub) with access to your repos.
2. A **Dokploy API token** (Dokploy → Profile/Settings → API).
3. `git`, `curl`, `jq` installed locally.

## Web app (easiest — interactive)

A zero-dependency browser UI that asks for everything, lists your Dokploy projects, lets you pick
**new or existing app**, and runs the whole flow with live logs.

```bash
cd deploy-kit/webapp
npm start            # or: node server.js
# open http://127.0.0.1:4317
```

Flow: **Connect** (Dokploy URL + API key) → it lists projects/environments + GitHub providers →
enter the GitHub repo, pick **static/ssr**, choose **new or existing app**, optional custom domain →
**Deploy**. No `npm install` needed (pure Node ≥18). Binds to localhost only; your API key stays on
your machine. A GitHub token field is optional — leave blank to use the machine's existing git auth.

## Usage (CLI / automated)

```bash
# 1) point at your Dokploy + creds
export DOKPLOY_URL=https://your-dokploy.host
export DOKPLOY_API_KEY=xxxxxxxx

# 2) find the IDs you need (environment + github provider)
./deploy-lovable.sh --discover
export DOKPLOY_ENVIRONMENT_ID=...   # the target project's environment
export DOKPLOY_GITHUB_ID=...        # your connected GitHub provider

# 3) deploy — target can be a local path, a GitHub URL, or an owner/repo slug
./deploy-lovable.sh you/my-landing                        # static (clones it for you)
./deploy-lovable.sh https://github.com/you/my-app --ssr   # Node SSR app
./deploy-lovable.sh /path/to/local/repo --name myapp --branch main
```

The script clones the repo if needed, copies the kit in, commits + pushes, then via the Dokploy API:
creates the app → sets GitHub source (auto-deploy on push) → sets Dockerfile build → generates a
random domain → deploys, and prints the URL.

**Re-runnable / idempotent:** running it again on the same repo reuses the existing Dokploy app
(matched by name in the environment), re-applies config, keeps the existing domain, and redeploys —
no duplicates. URLs/slugs are cloned into `deploy-clones/<repo>` and `git pull`ed on re-runs.

## Usage (manual, no script)

1. Copy `vite.deploy.config.ts`, `.dockerignore`, and **one** Dockerfile (renamed to `Dockerfile`)
   into the repo root. For static, also copy `nginx.conf`.
2. `git add … && git commit && git push`.
3. Dokploy → **New Application** → **GitHub** → pick repo + branch → **Build Type = Dockerfile**
   (Build stage: `runtime`) → **Generate Domain** (set port **80** for static / **3000** for ssr) → **Deploy**.

## Notes & caveats

- **Auto-deploy on push** is enabled by the script; every push to the chosen branch redeploys.
- **Additive & Lovable-safe:** the kit never edits `vite.config.ts`. Lovable commits incrementally
  and preserves files it didn't generate, so the kit survives Lovable's pushes. If you ever recreate
  the project on Lovable from scratch, re-run the kit.
- **`npm install`, not `npm ci`:** Lovable manages deps via bun, so the committed `package-lock.json`
  is usually out of sync with `package.json`. Builds resolve deps fresh (not lockfile-pinned).
- **SSR runtime is self-contained:** the `node-server` preset bundles deps into `.output`, so the
  runtime image needs no `node_modules`. If a build ever externalizes a dep and runtime can't find a
  module, copy `node_modules` into the SSR runtime stage too.
- **HTTPS:** the script attaches an `sslip.io` host over HTTP. For a real domain, point DNS at the
  server and switch the domain's certificate to **Let's Encrypt** in Dokploy.
