#!/usr/bin/env node
/**
 * Answers one question: are the three copies of this project the same?
 *
 *   node scripts/check-drift.mjs
 *
 * SafeGuard exists in three places and none of them updates the others.
 * Railway deploys from the CLI, so `git push` never touches the API. Vercel
 * builds the dashboard from GitHub, so `railway up` never touches the UI. The
 * ElevenLabs voice agent is a fourth copy again, updated only by an explicit
 * sync. That is how the repository, the docs and production drifted into three
 * different systems earlier in this project — and it was invisible, because
 * nothing reported which commit was serving traffic.
 *
 * This prints all of it side by side and exits non-zero when they disagree,
 * so drift is a failed command rather than a discovery weeks later.
 */
import { execFileSync } from 'node:child_process';

const API = process.env.API_BASE_URL ?? 'https://safeguard-api-production-7c24.up.railway.app';
const DASHBOARD = process.env.FRONTEND_URL ?? 'https://safeguard-dashboard-cyan.vercel.app';
const TIMEOUT_MS = 20_000;

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const short = (sha) => (sha && sha.length >= 12 ? sha.slice(0, 12) : (sha ?? '?'));

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

const problems = [];
const note = (line) => problems.push(line);

// --- local and GitHub -------------------------------------------------------

const localSha = git('rev-parse', 'HEAD');
const localDirty = (git('status', '--porcelain') ?? '').length > 0;
git('fetch', '--quiet', 'origin');
const remoteSha = git('rev-parse', 'origin/main');
const ahead = git('rev-list', '--count', 'origin/main..HEAD');
const behind = git('rev-list', '--count', 'HEAD..origin/main');

console.log('');
console.log('  local     ', short(localSha), localDirty ? '(UNCOMMITTED CHANGES)' : '(clean)');
console.log('  github    ', short(remoteSha), `(ahead ${ahead ?? '?'}, behind ${behind ?? '?'})`);

if (localDirty) note('The working tree has uncommitted changes.');
if (ahead && ahead !== '0') note(`${ahead} commit(s) are on this machine and not on GitHub.`);
if (behind && behind !== '0') note(`${behind} commit(s) are on GitHub and not here.`);

// --- the deployed API -------------------------------------------------------

const version = await getJson(`${API}/version`);

if (version.error) {
  console.log('  api        unreachable —', version.error);
  note(`Could not reach ${API}/version.`);
} else {
  const stamped = version.stamped === true;
  console.log(
    '  api       ',
    short(version.git_sha),
    stamped ? (version.dirty ? '(STAMPED, BUILT FROM A DIRTY TREE)' : '(stamped)') : '(NOT STAMPED)'
  );

  if (!stamped) {
    note(
      'The API did not report a stamped commit, so it was deployed without ' +
        '`npm run deploy` and what it is running cannot be identified.'
    );
  } else {
    if (version.dirty) {
      note('The API was built from a dirty working tree — it runs code that is on no commit.');
    }
    if (localSha && version.git_sha !== localSha) {
      note(`The API is running ${short(version.git_sha)}, this machine is on ${short(localSha)}.`);
    }
  }
}

// --- the deployed dashboard -------------------------------------------------
//
// Vercel bakes no commit marker into the bundle, so there is nothing to compare
// a sha against. What can be checked is whether the deployed bundle contains a
// feature the current source has — a cheap, honest staleness probe rather than
// a version claim we cannot make.

const probe = { path: '/review', label: 'Review Queue route' };
let dashboardState = 'unknown';
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const page = await fetch(DASHBOARD, { signal: controller.signal });
  const html = await page.text();
  clearTimeout(timer);
  const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
  if (!asset) {
    dashboardState = 'no bundle found in index.html';
  } else {
    const bundle = await (await fetch(`${DASHBOARD}${asset}`)).text();
    const hasProbe = bundle.includes(probe.path);
    dashboardState = hasProbe ? `carries ${probe.label}` : `MISSING ${probe.label}`;
    if (!hasProbe) {
      note(
        `The deployed dashboard bundle does not contain ${probe.path}, so it predates ` +
          'the Review Queue and is behind the repository.'
      );
    }
  }
} catch (error) {
  dashboardState = `unreachable — ${String(error instanceof Error ? error.message : error)}`;
  note(`Could not read the dashboard bundle at ${DASHBOARD}.`);
}
console.log('  dashboard ', dashboardState);

// --- verdict ----------------------------------------------------------------

console.log('');
if (problems.length === 0) {
  console.log('  No drift: local, GitHub and production agree.');
  console.log('');
  process.exit(0);
}

console.log(`  ${problems.length} problem(s):`);
for (const line of problems) console.log(`    - ${line}`);
console.log('');
console.log('  Backend deploys with `cd backend && npm run deploy` (stamps the commit,');
console.log('  then railway up). The dashboard deploys from GitHub via Vercel. The');
console.log('  ElevenLabs agent needs its own sync and is not checked here.');
console.log('');
process.exit(1);
