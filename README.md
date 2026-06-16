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
  Dockerfile              # self-hosts the web app itself (Node, :4317) on Dokploy
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
**Deploy**. No `npm install` needed (pure Node ≥18). Binds to localhost only.

**Auto-detect flavor:** type a repo URL (or click *Detect flavor*) and the app scans the repo for
server-side code (`createServerFn`, API routes, `*.server.ts`, …) and pre-selects **SSR** if found,
else **Static**.

**Config from environment (no secrets in the browser):** the server reads these from its environment
— set them in the Dokploy app's **Env tab** when self-hosting, or a local **`.env`** file (auto-loaded
on Node ≥20.6):

```
DOKPLOY_URL=https://your-dokploy.host
DOKPLOY_API_KEY=...
GITHUB_TOKEN=...                 # PAT with repo write access (needed in the hosted container)
DOKPLOY_GITHUB_ID=...            # optional: pre-select the GitHub provider
DOKPLOY_ENVIRONMENT_ID=...       # optional: pre-select the project environment
```

When `DOKPLOY_URL` + `DOKPLOY_API_KEY` are set, the UI auto-connects on load; secret values stay on the
server (the UI only learns *whether* they're present, never their value). Any field you leave blank in
the form falls back to the environment.

### Self-hosting the web app

The root `Dockerfile` runs the web app as a Dokploy application (Node server on `:4317`). Deploy this
repo like any other (Build Type = **Dockerfile**), then **protect it** — it can push to your GitHub and
control your Dokploy, so put it behind **HTTP Basic Auth** (Dokploy → app → Advanced → Security) and set
the secrets in the **Env tab** rather than typing them in the browser. The hosted container has no git
credentials of its own, so `GITHUB_TOKEN` (a PAT with repo write access) is required there.

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

## Status & roadmap

Working MVP: connect → pick app → detect flavor → push kit → create/configure → deploy, with token
redaction and env-based config. Highest-leverage next steps:

- **Stream the Dokploy build log + verify the live URL** (currently it stops at "deploying").
- **Idempotent app reuse in the web app** (match an existing app by repo to avoid duplicates).
- **Lifecycle controls** (redeploy / stop / delete / logs) and **app env-var management** from the UI.
- **Hardening:** real auth (beyond Basic Auth), encrypted secret storage, audit log.

Note: the **Lovable → GitHub** link itself can't be automated — Lovable exposes no API for it, so that
one connection stays a one-time manual step per project. Everything from GitHub onward is automated.
