#!/usr/bin/env node
/**
 * Runs the API and exposes it through a Cloudflare quick tunnel.
 *
 *   node scripts/serve-tunnel.mjs             # start both, print the URL
 *   node scripts/serve-tunnel.mjs --publish   # also repoint the Pages site
 *
 * A quick tunnel needs no Cloudflare account, but its hostname changes every
 * time it starts — so --publish updates the VITE_API_BASE_URL repository
 * variable and redeploys GitHub Pages to match. That rebuild takes about a
 * minute, which is the price of not having an account.
 *
 * For a hostname that survives restarts you need a named tunnel, which does
 * need a free Cloudflare account and a domain. See DEPLOY.md.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publish = process.argv.includes('--publish');
const REPO = process.env.GH_REPO || 'rsmatic/orderko';

/**
 * Prefer whatever is on PATH — winget, brew and apt all put it there — and
 * only fall back to the places a manual download tends to land.
 */
function findCloudflared() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;

  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(lookup, ['cloudflared'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (found) return found;
  } catch { /* not on PATH; try the fallbacks */ }

  const fallbacks = process.platform === 'win32'
    ? [
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      path.join(process.env.USERPROFILE ?? '', 'bin', 'cloudflared.exe'),
    ]
    : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'];

  return fallbacks.find((p) => existsSync(p)) ?? 'cloudflared';
}

const CLOUDFLARED = findCloudflared();

const children = [];

/**
 * Quits, and takes the children with it.
 *
 * Leaving them behind is worse than the failure that caused it: an orphaned
 * API keeps port 4000, so the next attempt fails with "something is already on
 * port 4000" and the one after that, with no window left on screen to Ctrl+C.
 */
function bail(message) {
  console.error('\n' + message);
  for (const child of children) child.kill();
  setTimeout(() => process.exit(1), 1000);
}
const log = (tag, line) => console.log(`[${tag}] ${line}`);

function start(tag, command, args, opts = {}) {
  // A shell is what lets Windows run a .cmd or a bare name off PATH, but it
  // also re-parses the command line — and cmd.exe splits
  // "C:\Program Files (x86)\cloudflared\cloudflared.exe" at the first space,
  // reporting that 'C:\Program' is not a recognised command. An absolute path
  // to a real file needs no shell, so it does not get one.
  const shell = process.platform === 'win32' && !path.isAbsolute(command);
  const child = spawn(command, args, { cwd: root, shell, ...opts });
  children.push(child);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log(tag, `exited with code ${code}`);
  });
  return child;
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim()))));
  });
}

// ---------------------------------------------------------------- the API

// Watched, because this runs for days at a time and Node reads the source once
// at startup: without it, pulling a change leaves the API serving the old code
// with nothing on screen to say so, and the first sign is a route that answers
// 404. The paths are named explicitly so only source restarts it — the store
// is written on every order and must not.
//
// A restart is safe: SIGTERM closes the server and flushes the debounced write
// before exiting, which is the same path a manual Ctrl+C takes.
const api = start(
  'api',
  'node',
  ['--watch-path=src', '--watch-path=../../packages/core/src', 'src/index.js'],
  { cwd: path.join(root, 'apps', 'api') },
);
api.stdout.on('data', (d) => String(d).trimEnd().split('\n').forEach((l) => log('api', l)));
api.stderr.on('data', (d) => String(d).trimEnd().split('\n').forEach((l) => log('api', l)));

const ready = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch('http://localhost:4000/api/health');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
})();

if (!ready) {
  bail('The API did not start in time. Is something already on port 4000?');
}

// ------------------------------------------------------------- the tunnel

log('tunnel', 'connecting…');
const tunnel = start('tunnel', CLOUDFLARED, [
  'tunnel', '--url', 'http://localhost:4000', '--no-autoupdate',
]);

const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no tunnel URL after 60s')), 60_000);
  // Without this, a tunnel that dies on startup leaves the script waiting out
  // the full minute before saying anything, and the reason it died has already
  // scrolled past.
  tunnel.on('exit', (code) => {
    if (code === null || code === 0) return;
    clearTimeout(timer);
    reject(new Error(`cloudflared exited with code ${code} before giving a URL`));
  });
  const scan = (chunk) => {
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      clearTimeout(timer);
      resolve(match[0]);
    }
  };
  tunnel.stdout.on('data', scan);
  tunnel.stderr.on('data', scan);
}).catch((err) => {
  bail(`${err.message}. Is ${CLOUDFLARED} installed?`);
});

// Tracking links the simulated driver hands out point at this hostname.
const envPath = path.join(root, 'apps', 'api', '.env');
try {
  const env = await fs.readFile(envPath, 'utf8');
  await fs.writeFile(envPath, env.replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${url}`));
} catch { /* no .env yet; defaults apply */ }

console.log(`\n  API is public at  ${url}/api`);
console.log(`  Health            ${url}/api/health\n`);

if (publish) {
  console.log('  Repointing the Pages site…');
  try {
    await run('gh', ['variable', 'set', 'VITE_API_BASE_URL', '--repo', REPO, '--body', `${url}/api`]);
    await run('gh', ['workflow', 'run', 'deploy-pages.yml', '--repo', REPO]);
    console.log('  Deploy triggered — live in about a minute.');
    console.log(`  Watch it:  gh run watch --repo ${REPO}\n`);
  } catch (err) {
    console.error(`  Could not update the repository variable: ${err.message}`);
    console.error('  Set it by hand:');
    console.error(`    gh variable set VITE_API_BASE_URL --repo ${REPO} --body "${url}/api"\n`);
  }
} else {
  console.log('  The Pages site still points at the previous URL. To update it:');
  console.log(`    gh variable set VITE_API_BASE_URL --repo ${REPO} --body "${url}/api"`);
  console.log(`    gh workflow run deploy-pages.yml --repo ${REPO}`);
  console.log('  Or start with --publish to do both automatically.\n');
}

console.log('  Ctrl+C to stop both.\n');

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 1500);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
