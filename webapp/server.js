'use strict';
// Zero-dependency web app: Lovable (GitHub) -> Dokploy deployer.
// Serves an interactive UI, proxies the Dokploy API, and runs the
// clone -> add kit -> push -> create/config -> domain -> deploy flow.
// Local-only by default (binds 127.0.0.1). Run: `npm start` (or `node server.js`).

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const KIT_DIR = path.join(__dirname, '..');           // the deploy-kit/ folder (Dockerfiles etc.)
const PUBLIC = path.join(__dirname, 'public');
const WORK = path.join(__dirname, '.work');           // scratch clones
// Load .env for local runs (on Dokploy these come from the app's Env tab).
try { process.loadEnvFile(); } catch { /* no .env file — fine */ }
const PORT = process.env.PORT || 4317;
const HOST = process.env.HOST || '127.0.0.1';

// Server-side config from environment. Secrets never leave the server.
const ENV = {
  dokployUrl: process.env.DOKPLOY_URL || '',
  apiKey: process.env.DOKPLOY_API_KEY || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  githubId: process.env.DOKPLOY_GITHUB_ID || '',
  environmentId: process.env.DOKPLOY_ENVIRONMENT_ID || '',
};

// ---------------- Dokploy API ----------------
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
// Strip secrets (credentials in URLs, GitHub PATs/tokens) from anything we log or return.
const redact = (s) => String(s)
  .replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@')
  .replace(/gh[posru]_[A-Za-z0-9_]{10,}/g, '***')
  .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '***');
async function dokploy(base, key, route, method = 'GET', body) {
  const res = await fetch(`${trimSlash(base)}/api/${route}`, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`Dokploy ${route} -> ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return data && typeof data === 'object' && 'data' in data ? data.data : data;
}

// ---------------- helpers ----------------
const sendJson = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
function run(cmd, args, opts = {}, onLog) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } });
    let out = '';
    const h = (buf) => { const s = buf.toString(); out += s; if (onLog) s.split(/\r?\n/).forEach((l) => l && onLog(l)); };
    p.stdout.on('data', h); p.stderr.on('data', h);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}
function parseRepo(input) {
  let s = String(input || '').trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '');
  const [owner, repo] = s.split('/');
  if (!owner || !repo) throw new Error('Could not parse owner/repo from: ' + input);
  return { owner, repo };
}

// ---------------- /api/connect : list projects + github providers ----------------
async function handleConnect(req, res) {
  const b = await readBody(req);
  const dokployUrl = b.dokployUrl || ENV.dokployUrl;
  const apiKey = b.apiKey || ENV.apiKey;
  if (!dokployUrl || !apiKey) return sendJson(res, 400, { error: 'dokployUrl and apiKey are required' });
  try {
    const projects = await dokploy(dokployUrl, apiKey, 'project.all', 'GET');
    let providers = [];
    try { providers = await dokploy(dokployUrl, apiKey, 'github.githubProviders', 'GET'); } catch { /* optional */ }
    sendJson(res, 200, {
      projects: (projects || []).map((p) => ({
        name: p.name,
        projectId: p.projectId,
        environments: (p.environments || []).map((e) => ({
          environmentId: e.environmentId,
          name: e.name,
          applications: (e.applications || []).map((a) => ({
            applicationId: a.applicationId, name: a.name, status: a.applicationStatus,
          })),
        })),
      })),
      githubProviders: (providers || []).map((g) => ({ githubId: g.githubId, name: g.gitProvider?.name || g.githubId })),
    });
  } catch (e) { sendJson(res, 502, { error: String(e.message || e) }); }
}

// ---------------- /api/deploy : run the whole flow, stream logs ----------------
async function handleDeploy(req, res) {
  const body = await readBody(req);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const log = (l) => res.write(redact(String(l)).replace(/\n/g, ' ') + '\n');
  const done = (obj) => { res.write('__RESULT__ ' + JSON.stringify(obj) + '\n'); res.end(); };
  try {
    const { repoUrl, branch = 'main', flavor = 'static', appName, mode = 'new', existingAppId, customDomain } = body;
    // Secrets/ids fall back to server environment (Dokploy Env tab / local .env).
    const dokployUrl = body.dokployUrl || ENV.dokployUrl;
    const apiKey = body.apiKey || ENV.apiKey;
    const githubId = body.githubId || ENV.githubId;
    const environmentId = body.environmentId || ENV.environmentId;
    const githubToken = body.githubToken || ENV.githubToken;
    for (const [k, v] of Object.entries({ dokployUrl, apiKey, githubId, repoUrl })) if (!v) throw new Error('Missing input: ' + k);
    if (mode === 'new' && !environmentId) throw new Error('Missing input: environmentId');
    if (mode === 'existing' && !existingAppId) throw new Error('Pick an existing app');

    const { owner, repo } = parseRepo(repoUrl);
    const name = appName || repo;
    const port = flavor === 'ssr' ? 3000 : 80;
    log(`repo=${owner}/${repo} branch=${branch} flavor=${flavor} app=${name} port=${port}`);

    // clone
    await fsp.mkdir(WORK, { recursive: true });
    const dir = path.join(WORK, repo);
    await fsp.rm(dir, { recursive: true, force: true });
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;
    log('cloning repo...');
    await run('git', ['clone', '--depth', '1', '--branch', branch, cloneUrl, dir], { env: { GIT_TERMINAL_PROMPT: '0' } }, log);

    // add kit (additive; never touches vite.config.ts)
    log('adding deploy kit...');
    await fsp.copyFile(path.join(KIT_DIR, 'vite.deploy.config.ts'), path.join(dir, 'vite.deploy.config.ts'));
    await fsp.copyFile(path.join(KIT_DIR, '.dockerignore'), path.join(dir, '.dockerignore'));
    const track = ['Dockerfile', 'vite.deploy.config.ts', '.dockerignore'];
    if (flavor === 'ssr') {
      await fsp.copyFile(path.join(KIT_DIR, 'Dockerfile.ssr'), path.join(dir, 'Dockerfile'));
    } else {
      await fsp.copyFile(path.join(KIT_DIR, 'Dockerfile.static'), path.join(dir, 'Dockerfile'));
      await fsp.copyFile(path.join(KIT_DIR, 'nginx.conf'), path.join(dir, 'nginx.conf'));
      track.push('nginx.conf');
    }

    // commit + push
    await run('git', ['-C', dir, 'add', ...track], {}, log);
    try {
      await run('git', ['-C', dir, '-c', 'user.email=deploy@kit', '-c', 'user.name=deploy-kit',
        'commit', '-m', `Add Dokploy deploy kit (${flavor})`], {}, log);
    } catch { log('nothing to commit (kit already present)'); }
    log('pushing to GitHub...');
    await run('git', ['-C', dir, 'push', 'origin', branch], {}, log);

    // create or reuse app
    let appId, appNameGen = '';
    if (mode === 'existing') {
      appId = existingAppId; log(`using existing app ${appId}`);
    } else {
      log('creating Dokploy application...');
      const created = await dokploy(dokployUrl, apiKey, 'application.create', 'POST', { name, environmentId });
      appId = created.applicationId; appNameGen = created.appName;
      log(`applicationId=${appId}`);
    }

    // configure source + build
    log('setting GitHub source (+ auto-deploy on push)...');
    await dokploy(dokployUrl, apiKey, 'application.saveGithubProvider', 'POST',
      { applicationId: appId, githubId, owner, repository: repo, branch, buildPath: '/', triggerType: 'push' });
    log('setting Dockerfile build type...');
    await dokploy(dokployUrl, apiKey, 'application.saveBuildType', 'POST',
      { applicationId: appId, buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '.', dockerBuildStage: 'runtime', herokuVersion: null, railpackVersion: null });

    // domain
    let host = null, https = false;
    try {
      const ds = await dokploy(dokployUrl, apiKey, `domain.byApplicationId?applicationId=${appId}`, 'GET');
      if (Array.isArray(ds) && ds[0]) { host = ds[0].host; https = !!ds[0].https; }
    } catch { /* ignore */ }
    if (customDomain) {
      host = customDomain.trim(); https = true;
      log(`attaching custom domain ${host} (Let's Encrypt)...`);
      await dokploy(dokployUrl, apiKey, 'domain.create', 'POST',
        { applicationId: appId, host, port, path: '/', https: true, certificateType: 'letsencrypt', domainType: 'application' });
    } else if (!host) {
      if (!appNameGen) appNameGen = (await dokploy(dokployUrl, apiKey, `application.one?applicationId=${appId}`, 'GET')).appName;
      log('generating random domain...');
      host = await dokploy(dokployUrl, apiKey, 'domain.generateDomain', 'POST', { appName: appNameGen });
      await dokploy(dokployUrl, apiKey, 'domain.create', 'POST',
        { applicationId: appId, host, port, path: '/', https: false, certificateType: 'none', domainType: 'application' });
    } else {
      log(`domain already attached: ${host}`);
    }

    // deploy
    log('triggering deploy...');
    await dokploy(dokployUrl, apiKey, 'application.deploy', 'POST', { applicationId: appId });
    done({ ok: true, url: `${https ? 'https' : 'http'}://${host}`, applicationId: appId });
  } catch (e) {
    const msg = redact(String(e.message || e));
    log('ERROR: ' + msg);
    done({ ok: false, error: msg });
  }
}

// ---------------- /api/config : what's preset from the environment ----------------
function handleConfig(req, res) {
  sendJson(res, 200, {
    dokployUrl: ENV.dokployUrl,
    hasApiKey: !!ENV.apiKey,
    hasGithubToken: !!ENV.githubToken,
    githubId: ENV.githubId,
    environmentId: ENV.environmentId,
  });
}

// ---------------- /api/detect : recommend static vs ssr by scanning the repo ----------------
const SERVER_RE = /createServerFn|createServerFileRoute|createAPIFileRoute|createServerRoute|useServerFn|@tanstack\/react-start\/server/;
async function detectFlavor(root) {
  const signals = new Set();
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx']);
  async function walk(d) {
    let entries; try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'dist', '.output'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); }
      else if (exts.has(path.extname(e.name))) {
        if (/\.server\.(t|j)sx?$/.test(e.name)) signals.add(e.name);
        try { const m = (await fsp.readFile(p, 'utf8')).match(SERVER_RE); if (m) signals.add(m[0]); } catch { /* skip */ }
      }
    }
  }
  await walk(root);
  const arr = [...signals].slice(0, 6);
  return arr.length
    ? { flavor: 'ssr', reason: 'Found server-side code — SSR recommended', signals: arr }
    : { flavor: 'static', reason: 'No server-side code found — Static recommended', signals: [] };
}
async function handleDetect(req, res) {
  const body = await readBody(req);
  const { repoUrl, branch = 'main' } = body;
  const token = body.githubToken || ENV.githubToken;
  if (!repoUrl) return sendJson(res, 400, { error: 'repoUrl is required' });
  let dir;
  try {
    const { owner, repo } = parseRepo(repoUrl);
    await fsp.mkdir(WORK, { recursive: true });
    dir = path.join(WORK, '__detect__' + repo);
    const base = `github.com/${owner}/${repo}.git`;
    // Read-only scan: try anonymous first (works for public repos, ignores a bad/revoked
    // token), then fall back to the token only if needed (private repos).
    const urls = [`https://${base}`, ...(token ? [`https://x-access-token:${token}@${base}`] : [])];
    let cloned = false, lastErr;
    for (const url of urls) {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        await run('git', ['clone', '--depth', '1', '--branch', branch, url, dir], { env: { GIT_TERMINAL_PROMPT: '0' } });
        cloned = true; break;
      } catch (e) { lastErr = e; }
    }
    if (!cloned) throw lastErr;
    sendJson(res, 200, await detectFlavor(dir));
  } catch (e) {
    sendJson(res, 200, { flavor: null, reason: 'Could not scan the repo — check the URL/branch; for a private repo, provide a token that can read it. (' + redact(String(e.message || e)) + ')' });
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------- static + routing ----------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
async function serveStatic(res, file) {
  const p = path.normalize(path.join(PUBLIC, file));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const b = await fsp.readFile(p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('not found'); }
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') return handleConfig(req, res);
    if (req.method === 'POST' && req.url === '/api/connect') return handleConnect(req, res);
    if (req.method === 'POST' && req.url === '/api/detect') return handleDetect(req, res);
    if (req.method === 'POST' && req.url === '/api/deploy') return handleDeploy(req, res);
    if (req.method === 'GET') return serveStatic(res, req.url === '/' ? 'index.html' : req.url.replace(/^\//, '').split('?')[0]);
    res.writeHead(404); res.end('not found');
  } catch (e) { sendJson(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, HOST, () => {
  console.log(`\n  Lovable → Dokploy deployer\n  → http://${HOST}:${PORT}\n`);
});
