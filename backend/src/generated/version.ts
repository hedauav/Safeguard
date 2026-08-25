/**
 * Stamped at deploy time by `scripts/stamp-version.mjs`.
 *
 * Railway deploys this backend from the CLI, not from GitHub, so
 * `RAILWAY_GIT_COMMIT_SHA` — which Railway only populates for repo-triggered
 * deploys — is never set. `/version` was therefore answering `unknown` to the
 * one question it exists to answer. `railway up` also ships the working
 * directory rather than a commit, so a deploy can carry uncommitted changes
 * with nothing afterwards able to tell.
 *
 * `npm run deploy` rewrites this file from `git rev-parse HEAD` immediately
 * before uploading, then restores this placeholder, so the committed state
 * never pretends to know which commit is live.
 */
export const BUILD_GIT_SHA = 'unstamped';
export const BUILD_GIT_DESCRIBE = 'unstamped';
export const BUILD_TIME = 'unstamped';
/** False when the deploy did not go through `npm run deploy`. */
export const BUILD_STAMPED = false;
/** True when the working tree carried uncommitted changes at stamp time. */
export const BUILD_DIRTY = false;
