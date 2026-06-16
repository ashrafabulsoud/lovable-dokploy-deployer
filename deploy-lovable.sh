#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# deploy-lovable.sh
#
# One command to take a Lovable "TanStack Start" repo -> GitHub -> Dokploy,
# with auto-deploy on every push. Safe to re-run (idempotent).
#
# Requires: git, curl, jq, and a Dokploy API token.
#
# Config (env vars):
#   DOKPLOY_URL             e.g. https://dokploy.example.com   (no trailing slash)
#   DOKPLOY_API_KEY         Dokploy API token
#   DOKPLOY_ENVIRONMENT_ID  target project environment id      (see: --discover)
#   DOKPLOY_GITHUB_ID       connected GitHub provider id        (see: --discover)
#
# Usage:
#   ./deploy-lovable.sh --discover                      # list env + github ids
#   ./deploy-lovable.sh <target> [--ssr|--static] [--name N] [--branch B]
#
#   <target> may be:
#     - a local repo path            (./my-app)
#     - a GitHub URL                 (https://github.com/you/my-app[.git])
#     - an owner/repo slug           (you/my-app)
#   URLs/slugs are cloned into ./deploy-clones/<repo> (pulled if already there).
# ============================================================================

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
req() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required" >&2; exit 1; }; }
req git; req curl; req jq

api_post() { curl -fsS -X POST "${DOKPLOY_URL%/}/api/$1" \
  -H "x-api-key: ${DOKPLOY_API_KEY}" -H "Content-Type: application/json" -d "$2"; }
api_get()  { curl -fsS "${DOKPLOY_URL%/}/api/$1" -H "x-api-key: ${DOKPLOY_API_KEY}"; }
unwrap()   { jq -r "(.data // .)${1:-}"; }   # Dokploy returns bare; // .data handles wrapped too

# --- discover: print environment ids + github provider ids ---
if [[ "${1:-}" == "--discover" ]]; then
  : "${DOKPLOY_URL:?set DOKPLOY_URL}"; : "${DOKPLOY_API_KEY:?set DOKPLOY_API_KEY}"
  echo "== Projects / environments =="
  api_get "project.all" | jq -r '(.data // .)[] | .name as $p | .environments[]
    | "  env: \(.environmentId)   project: \($p) / \(.name)"'
  echo "== GitHub providers =="
  api_get "github.githubProviders" | jq -r '(.data // .)[]
    | "  githubId: \(.githubId)   name: \(.gitProvider.name)"'
  exit 0
fi

# --- args ---
FLAVOR="static"; APP_NAME=""; BRANCH="main"; TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssr) FLAVOR="ssr"; shift;;
    --static) FLAVOR="static"; shift;;
    --name) APP_NAME="${2:?}"; shift 2;;
    --branch) BRANCH="${2:?}"; shift 2;;
    -h|--help) sed -n '2,40p' "$0"; exit 0;;
    -*) echo "unknown flag: $1" >&2; exit 1;;
    *) TARGET="$1"; shift;;
  esac
done
[[ -n "$TARGET" ]] || { echo "usage: ./deploy-lovable.sh <target> [--ssr|--static]" >&2; exit 1; }
: "${DOKPLOY_URL:?set DOKPLOY_URL}"
: "${DOKPLOY_API_KEY:?set DOKPLOY_API_KEY}"
: "${DOKPLOY_ENVIRONMENT_ID:?set DOKPLOY_ENVIRONMENT_ID (run with --discover)}"
: "${DOKPLOY_GITHUB_ID:?set DOKPLOY_GITHUB_ID (run with --discover)}"

# --- resolve target -> REPO_DIR (clone URLs/slugs, pull if already cloned) ---
if [[ -d "$TARGET/.git" ]]; then
  REPO_DIR="$TARGET"
else
  case "$TARGET" in
    http*|git@*) URL="$TARGET" ;;
    */*)         URL="https://github.com/${TARGET%.git}.git" ;;
    *) echo "target is neither a git repo nor a URL/slug: $TARGET" >&2; exit 1 ;;
  esac
  NAME="$(basename "${URL%.git}")"
  REPO_DIR="$KIT_DIR/deploy-clones/$NAME"
  if [[ -d "$REPO_DIR/.git" ]]; then
    echo "==> updating existing clone $REPO_DIR"; git -C "$REPO_DIR" pull --ff-only
  else
    echo "==> cloning $URL"; mkdir -p "$KIT_DIR/deploy-clones"; git clone "$URL" "$REPO_DIR"
  fi
fi
cd "$REPO_DIR"

SLUG="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git/?$##')"
OWNER="${SLUG%%/*}"; REPO="${SLUG##*/}"
[[ -n "$APP_NAME" ]] || APP_NAME="$REPO"
[[ "$FLAVOR" == "ssr" ]] && PORT=3000 || PORT=80
echo "==> repo=$OWNER/$REPO branch=$BRANCH flavor=$FLAVOR app=$APP_NAME port=$PORT"

# --- copy kit files (additive; never touches vite.config.ts) + push ---
cp "$KIT_DIR/vite.deploy.config.ts" ./vite.deploy.config.ts
cp "$KIT_DIR/.dockerignore" ./.dockerignore
TRACK=(Dockerfile vite.deploy.config.ts .dockerignore)
if [[ "$FLAVOR" == "ssr" ]]; then cp "$KIT_DIR/Dockerfile.ssr" ./Dockerfile
else cp "$KIT_DIR/Dockerfile.static" ./Dockerfile; cp "$KIT_DIR/nginx.conf" ./nginx.conf; TRACK+=(nginx.conf); fi
git add "${TRACK[@]}"
if git diff --cached --quiet; then echo "==> kit already up to date"
else git commit -q -m "Add Dokploy deploy kit ($FLAVOR)"; git push origin "$BRANCH"; echo "==> pushed kit"; fi

# --- find existing app by name in the environment (idempotent) ---
APP_ID="$(api_get "project.all" | jq -r --arg e "$DOKPLOY_ENVIRONMENT_ID" --arg n "$APP_NAME" \
  '(.data // .)[].environments[] | select(.environmentId==$e) | .applications[]?
   | select(.name==$n) | .applicationId' | head -n1)"

if [[ -n "$APP_ID" ]]; then
  echo "==> reusing existing app $APP_NAME ($APP_ID)"
  GEN_APPNAME=""
else
  echo "==> creating Dokploy application"
  CREATE="$(api_post application.create \
    "$(jq -nc --arg n "$APP_NAME" --arg e "$DOKPLOY_ENVIRONMENT_ID" '{name:$n, environmentId:$e}')")"
  APP_ID="$(printf '%s' "$CREATE" | unwrap '.applicationId')"
  GEN_APPNAME="$(printf '%s' "$CREATE" | unwrap '.appName')"
  [[ -n "$APP_ID" && "$APP_ID" != "null" ]] || { echo "create failed: $CREATE" >&2; exit 1; }
  echo "    applicationId=$APP_ID"
fi

# --- configure source + build type (both idempotent updates) ---
echo "==> setting GitHub source (+ auto-deploy on push)"
api_post application.saveGithubProvider "$(jq -nc \
  --arg a "$APP_ID" --arg g "$DOKPLOY_GITHUB_ID" --arg o "$OWNER" --arg r "$REPO" --arg b "$BRANCH" \
  '{applicationId:$a, githubId:$g, owner:$o, repository:$r, branch:$b, buildPath:"/", triggerType:"push"}')" >/dev/null
echo "==> setting Dockerfile build type"
api_post application.saveBuildType "$(jq -nc --arg a "$APP_ID" \
  '{applicationId:$a, buildType:"dockerfile", dockerfile:"Dockerfile", dockerContextPath:".",
    dockerBuildStage:"runtime", herokuVersion:null, railpackVersion:null}')" >/dev/null

# --- ensure a domain exists (only create if the app has none yet) ---
HOST="$(api_get "domain.byApplicationId?applicationId=$APP_ID" 2>/dev/null | unwrap '[0].host' 2>/dev/null || true)"
if [[ -z "$HOST" || "$HOST" == "null" ]]; then
  [[ -n "$GEN_APPNAME" ]] || GEN_APPNAME="$(api_get "application.one?applicationId=$APP_ID" | unwrap '.appName')"
  echo "==> generating + attaching a random domain (port $PORT)"
  HOST="$(api_post domain.generateDomain "$(jq -nc --arg n "$GEN_APPNAME" '{appName:$n}')" | unwrap)"
  api_post domain.create "$(jq -nc --arg a "$APP_ID" --arg h "$HOST" --argjson p "$PORT" \
    '{applicationId:$a, host:$h, port:$p, path:"/", https:false, certificateType:"none", domainType:"application"}')" >/dev/null
else
  echo "==> domain already attached: $HOST"
fi

echo "==> deploying"
api_post application.deploy "$(jq -nc --arg a "$APP_ID" '{applicationId:$a}')" >/dev/null
echo ""
echo "✅ Building now — live shortly at:  http://$HOST"
echo "   (auto-deploy on push is enabled; re-run this script any time to update config)"
