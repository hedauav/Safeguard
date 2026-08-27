# SafeGuard — Setup & Deployment

Work through this in order. Steps 1–5 give you a working system; step 6 (evidence
archival / on-chain attestation) is optional and can be added later without
changing anything else.

---

## 0. Credentials checklist

Collect these before you start. Nothing else in this guide will work without them.

| # | Service | What you need | Where to get it | Cost |
|---|---------|---------------|-----------------|------|
| 1 | **Supabase** | Project URL, `anon` key, `service_role` key | [supabase.com](https://supabase.com) → New project → Settings → API | Free tier |
| 2 | **ElevenLabs** | API key, Agent ID, webhook secret | [elevenlabs.io](https://elevenlabs.io) → Agents | Free tier has limited minutes |
| 3 | **Railway** | Account (backend hosting) | [railway.app](https://railway.app) | Free trial, then usage-based |
| 4 | **Vercel** | Account (frontend hosting) | [vercel.com](https://vercel.com) | Free tier |
| 5 | **Twilio** *(optional)* | Account SID, auth token, phone number | [twilio.com](https://twilio.com) | Pay per number + minutes |
| 6 | **Agent wallet** *(optional)* | Fresh private key + testnet funds | Generate — see step 6 | Free (testnet) |

> **Do not reuse the key `0x952163c7…23fe8`** that previously appeared in
> `deploy-registry.ts` and `test-synapse.ts`. It was committed to a public
> repository and is permanently compromised. Those files have been deleted, but
> the key remains in git history.

---

## 1. Database

1. Create a Supabase project. Note the URL and both API keys.
2. Open the SQL editor and run **`backend/database/run-all.sql`** in full.
   That creates all 18 tables and inserts demo customers, policies, and claims.
   It is idempotent — safe to re-run.
3. Confirm the tables exist. The seven the product is built around:
   `customers`, `policies`, `claims`, `call_logs`, `call_tool_executions`,
   `escalations`, `scheduled_callbacks`. The agent and evidence tables:
   `agent_registrations`, `agent_settings`, `filecoin_uploads`,
   `evidence_bundles`, `claim_documents`. The money and adjudication tables:
   `policy_renewals`, `deductible_payments`, `razorpay_webhook_events`,
   `adjudications`, `adjudication_reviews`. And the claim timeline:
   `journey_events`.

If you later edit an individual migration, regenerate the combined file with
`bash backend/database/build-run-all.sh`. The numbered migrations run `0002`
through `0023`; **there is no `0014` and there never has been** — that gap is
expected, not a missing file.

> **`filecoin_uploads` no longer grants columns to `anon` by default.**
> Migration `0023_filecoin_error_column_grant_fix.sql` revokes `SELECT` on the
> whole table from `anon` and `authenticated`, then re-grants exactly eleven
> named columns — everything except `error`, which can capture a wallet address
> and an RPC URL from a failed Synapse upload. Two consequences to know before
> you touch this table:
>
> - **`select=*` against `filecoin_uploads` now fails outright** for the anon
>   key, rather than silently omitting the hidden column. Verified against the
>   live database with the deployed publishable key: `select=*` and
>   `order=error.desc` both return `401`, while `select=id,upload_status`
>   returns `200`. Browser code must name its columns.
> - **Any column added to this table in future is invisible to `anon` until it
>   is explicitly granted.** This is the reverse of the old behaviour, where a
>   new column was readable the instant it existed — and it is why `0022`'s
>   column-level `REVOKE` was a no-op: a column `REVOKE` cannot subtract from a
>   table-level `GRANT`. If you add a column meant to be public, add it to the
>   grant list in `0023` as well.
>
> The service role is unaffected, so `/health`, `check:setup` and the evidence
> pipeline still read `error` normally. Row-level policies are a separate gate
> and `0023` does not touch them.

---

## 2. Run locally

```bash
# Backend
cd backend
cp .env.example .env          # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev                   # http://localhost:3005

# Frontend (second terminal)
cd frontend
cp .env.example .env          # fill in VITE_SUPABASE_* and VITE_API_URL
npm install
npm run dev                   # http://localhost:5173
```

Check `http://localhost:3005/health`. It reports what is configured and, beside
it, what was last observed to happen — neither half is allowed to stand in for
the other. This is the deployed API's own answer, fetched at `619d32c` and
trimmed only of timestamps and of the wallet address (which is also repeated at
top level as `agent_address`); every other field and value is verbatim:

```json
{
  "status": "ok",
  "environment": "production",
  "mode": "live",
  "features": {
    "filecoin_uploads": {
      "configured": true,
      "unavailable_reason": null,
      "last_attempt": "failed",
      "last_success_at": null,
      "reason": "the most recent upload was recorded as failed"
    },
    "chain_attestation": {
      "configured": true,
      "last_attempt": "succeeded",
      "last_success_tx": "0xafbb33a53da4cceef515d4860b5e272aa14f6a139940b26676f43da4a94065ac",
      "reason": null
    },
    "eas_attestation": false,
    "webhook_signature_verification": true,
    "renewal_payment_links": "razorpay",
    "deductible_collection_and_refund": "razorpay",
    "claim_settlement_payouts": "simulated"
  },
  "observed": { "source": "database", "cache_ttl_seconds": 30, "error": null },
  "security": {
    "webhook_signature": "enforced",
    "razorpay_webhook_signature": "enforced",
    "tools_authentication": "enforced",
    "cors_allowed_origins": ["https://safeguard-dashboard-cyan.vercel.app"],
    "cors_allows_localhost": false,
    "rate_limits_per_minute": { "global": 300, "tools": 120, "onchain": 15 }
  },
  "wallet": {
    "network": "base-sepolia",
    "balance_eth": "0.009965220305348748",
    "balance_status": "funded",
    "reason": null
  },
  "filecoin_unavailable_reason": null,
  "agent_address": "0x0E65C4ECFeF90C33f87c77935C679C94C641Bf67",
  "ablations": [],
  "build": {
    "git_sha": "619d32c312af0a570631f5f1701ccf5d417b1fdd",
    "git_describe": "619d32c",
    "dirty": false
  }
}
```

Read it in three passes.

- `configured: false` means a feature is switched off for want of a credential,
  not that it is broken, and nothing is simulated in its absence.
- `configured: true` next to `last_attempt: "failed"` — which is what Filecoin
  reports above — means the credential is present and the path is failing
  anyway. That combination is the reason the two halves are printed side by
  side rather than collapsed into one flag.
- Under `security`, `enforced` means the secret is set, `development-bypass`
  means it is missing outside production and requests are let through, and
  `fail-closed` means it is missing *in* production and the endpoints behind it
  are refusing everything. All three read `enforced` above.
  `razorpay_webhook_signature` read `fail-closed` until `RAZORPAY_WEBHOOK_SECRET`
  was set on Railway — that is what the state looks like when it is a real gap
  rather than a deliberate choice, and it is worth checking on every deploy.

Locally the shape is identical and the values differ — `environment` reads
`development`, `cors_allows_localhost` is `true`, and every credential left
blank in `.env` reports itself off.

A build deployed with `npm run deploy` also carries a `build` block naming the
commit that is answering, and `/version` reports the same (see step 4). Deployed
any other way, both report `git_sha: "unstamped"` rather than guessing. The copy
running in production today is stamped — `619d32c`, `dirty: false` — so the
question step 4's `npm run check:drift` exists to answer is no longer *which
commit is serving traffic* but only *whether it is the same one you are looking
at*. At the time of writing it is not: the API is on `619d32c` and this branch
is one commit ahead of it, so `check:drift` exits non-zero. That is the normal
state between a commit and the deploy that ships it, and it is the state the
check is meant to make visible rather than an error.

Smoke-test a tool endpoint against the seeded data. Every `/api/tools/*` route
sits behind `TOOLS_API_TOKEN`; with none configured it falls open in
development, so the header below matters only once you have set one:

```bash
curl -X POST http://localhost:3005/api/tools/check-policy \
  -H 'Content-Type: application/json' \
  -H "x-tools-token: $TOOLS_API_TOKEN" \
  -d '{"policy_number":"POL-2024-001234"}'
```

Run the backend test suite with `npm test` (from `backend/`) — 606 tests at
`8da0356`, re-confirmed unchanged at `3c624c4`, up from the 364 reported at
`a4e6938`, and no database required. That count is `backend/src` alone, which is
all the glob `src/**/*.test.ts` reaches and all CI runs. The 85 tests under
`backend/eval/tests/` — 75 before the Wilson-interval and McNemar tests landed —
are outside that glob and outside CI; run them with
`npx tsx --test eval/tests/*.test.ts`.

---

## 3. Configure the ElevenLabs agent

The backend is the source of truth for the agent definition. With it running,
fetch everything you need to paste in:

```bash
curl http://localhost:3005/api/agent-config
```

The dashboard renders the same thing at **Agent Config** in the sidebar.

1. In ElevenLabs, create a **Conversational AI agent**.
2. Set the **system prompt** to `system_prompt` from that response.
3. Set the **first message** to `first_message`.
4. Add each entry in `tools` as a **webhook tool**:
   - Name → `name`
   - Description → `description`
   - Method → `POST`
   - URL → `url` (must be the *public* backend URL, not localhost — see step 4)
   - Body parameters → each entry in `parameters`, marked required as indicated
5. Under workspace settings, enable the **post-call webhook**:
   - URL → `integration.webhook_url`
   - Copy the generated **webhook secret** into `ELEVENLABS_WEBHOOK_SECRET`
6. Copy the **Agent ID** into the frontend's `VITE_ELEVENLABS_AGENT_ID`.

> ElevenLabs cannot reach `localhost`. To test tools before deploying, expose the
> backend with a tunnel (`ngrok http 3005`) and use that hostname. Otherwise
> finish step 4 first and use the Railway URL.

---

## 4. Deploy the backend (Railway)

> **`git push` updates GitHub and nothing else.** Railway is not connected to
> the repository — it deploys only when someone runs the CLI. This project
> exists in four places and none of them updates another:
>
> | Copy | How it changes |
> |---|---|
> | GitHub | `git push` |
> | API (Railway) | `cd backend && npm run deploy` |
> | Dashboard (Vercel) | `cd frontend && vercel --prod` — see step 5 |
> | ElevenLabs voice agent | its own sync: `npm run setup:elevenlabs`, or **Agent Config → Sync** in the dashboard. Neither deploy above touches it. |
>
> Getting this wrong is how the repository, the documentation and production
> came to disagree earlier in this project, and it was invisible because
> nothing reported which commit was serving traffic.

`railway.json` and `Dockerfile` are already configured; the healthcheck path is
`/health`.

```bash
npm i -g @railway/cli
railway login                 # opens a browser
cd backend
railway init                  # create/link a project
npm run deploy                # stamp the commit, then railway up
```

`npm run deploy` writes the commit into `src/generated/version.ts`, runs
`railway up --service safeguard-api --detach`, then restores the generated file.
The stamp is the point: **`railway up` uploads the working directory, not a
commit.** A deploy therefore ships whatever is on that machine, uncommitted
edits included, and Railway sets no commit sha for CLI deploys —
`RAILWAY_GIT_COMMIT_SHA` is only populated for repo-triggered ones. Stamping is
what lets `/health`'s `build` block and `/version` name the commit that is
answering, and report `dirty: true` when the running code exists on no commit
anywhere. Deployed any other way, both say `unstamped` rather than guess.

To see whether the copies agree:

```bash
cd backend && npm run check:drift
# from the repo root: node scripts/check-drift.mjs
```

It prints local `HEAD`, `origin/main`, the commit the API reports and whether
the deployed dashboard bundle is stale, and exits non-zero when they disagree.
It does **not** check the ElevenLabs agent; nothing does.

Set variables in the Railway dashboard (or `railway variables --set`).
`backend/.env.example` documents every one of these in full; this is the
shortlist and what a missing value means.

| Variable | Value | If unset |
|---|---|---|
| `SUPABASE_URL` | from step 1 | server will not start |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 | server will not start |
| `NODE_ENV` | `production` | secrets fail *open* instead of closed |
| `FRONTEND_URL` | your Vercel URL (after step 5) | the dashboard gets no CORS headers |
| `ELEVENLABS_WEBHOOK_SECRET` | from step 3 | post-call webhooks refuse with 503 |
| `TOOLS_API_TOKEN` | any long random string (`openssl rand -hex 32`) | **every `/api/tools/*` route, `conversation-init` and the audit write refuse with 503** |
| `ADMIN_TOKEN` | any long random string | the agent-config write endpoints are disabled |
| `ELEVENLABS_API_KEY` | from step 3 | agent-config sync disabled |
| `ELEVENLABS_AGENT_ID` | from step 3 | agent-config sync disabled |
| `GROQ_API_KEY` | console.groq.com | adjudication runs the deterministic checks and then escalates, saying no model read the documents |
| `GROQ_MODEL` | e.g. `openai/gpt-oss-120b` | defaults to `openai/gpt-oss-120b` |
| `ADJUDICATION_TIMEOUT_MS` | | defaults to 20000 |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | test keys start `rzp_test` | renewal and deductible links are simulated and resolve nowhere |
| `RAZORPAY_WEBHOOK_SECRET` | set on the webhook itself, not derived from the key pair | deductible captures cannot be verified; in production the endpoint refuses every delivery |
| `RATE_LIMIT_MAX` | | defaults to 300/min |
| `RATE_LIMIT_TOOLS_MAX` | | defaults to 120/min |
| `RATE_LIMIT_ONCHAIN_MAX` | | defaults to 15/min |
| `SETTLEMENT_AUTO_APPROVE_LIMIT` | | defaults to 50000 |
| `DEDUCTIBLE_MAX_LINK_AMOUNT` | | defaults to 100000 |
| `RENEWAL_TERM_MONTHS` / `RENEWAL_MAX_LINK_AMOUNT` | | default to 12 and 200000 |
| `AGENT_PRIVATE_KEY` | step 6 | Filecoin and attestation stay off |
| `CLAIM_REGISTRY_ADDRESS` | step 6 | on-chain attestation stays off |
| `CLAIM_REGISTRY_V2_ADDRESS` | step 6 | falls back to v1, which cannot attest when archival fails |
| `EAS_CONTRACT_ADDRESS` / `EAS_SCHEMA_UID` / `EAS_SCHEMA` | step 6 | EAS attestation stays off — all three or none |
| `AGENT_ID` | ERC-8004 token id | the identity card shows no id |
| `SIMULATE_BLOCKCHAIN` | `true` for demos | real behaviour |

Railway supplies `PORT` automatically. Confirm with
`curl https://<your-app>.up.railway.app/health`.

Then go back to step 3 and update every tool URL and the webhook URL to the
Railway hostname — and remember that neither this deploy nor the next one
pushes those changes to ElevenLabs. That takes its own sync.

---

## 5. Deploy the frontend (Vercel)

Vercel's git integration is **not** connected either: pushing to `main` leaves
the deployed dashboard exactly as it was. The frontend ships only from the CLI.

```bash
npm i -g vercel
cd frontend
vercel                        # link and deploy a preview
vercel --prod                 # promote to production
```

Set environment variables in the Vercel project settings:

| Variable | Value |
|---|---|
| `VITE_API_URL` | your Railway backend URL |
| `VITE_SUPABASE_URL` | from step 1 |
| `VITE_SUPABASE_ANON_KEY` | from step 1 (anon, **not** service_role) |
| `VITE_ELEVENLABS_AGENT_ID` | from step 3 |

Vite inlines these at **build** time, so redeploy after changing any of them.

Finally set `FRONTEND_URL` on Railway to the Vercel URL.

---

## 6. Optional: evidence archival and on-chain attestation

Skip this entirely if you only want the voice + claims product. Everything below
is additive; with these variables unset the app runs normally and reports the
features as disabled.

### 6a. Generate a fresh agent wallet

```bash
node -e "const{generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('AGENT_PRIVATE_KEY='+k);console.log('address       ='+privateKeyToAccount(k).address)"
```

Keep the key out of source control. Set it only as a hosting environment
variable.

### 6b. Fund it

- **Base Sepolia ETH** — [faucet](https://www.alchemy.com/faucets/base-sepolia), for attestation gas.
- **Filecoin Calibration tFIL** — [faucet](https://faucet.calibnet.chainsafe-fil.io/), for storage gas.
- **USDFC** on Calibration, plus a funded Warm Storage payment rail — required by
  Synapse for actual storage. Without it, uploads fail with
  `InsufficientLockupFunds`; the backend records the upload as `failed` and skips
  attestation rather than inventing a CID.

### 6c. Deploy the ClaimRegistry contract

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
cd contracts
forge install                 # if lib/forge-std is missing
forge test                    # 46 test functions in the source: 16 for ClaimRegistry, 30 for V2
PRIVATE_KEY=0x... forge script script/DeployClaimRegistry.s.sol \
  --rpc-url https://sepolia.base.org --broadcast
```

Copy the deployed address into `CLAIM_REGISTRY_ADDRESS`.

`verifyClaim()` is owner-only — the deploying wallet becomes the owner. Anyone
may `fileClaim()`, and the contract records who did.

> `backend/src/abis/ClaimRegistry.json` holds the interface only. If you change
> the contract, update that file to match.

> **CI does not run the contracts.** `.github/workflows/ci.yml` has a backend
> job (typecheck + `npm test`) and a frontend job (lint + build), and no
> Foundry job at all. The 46 contract tests only run when someone runs
> `forge test` by hand.

### 6d. Set the variables

On Railway:

```
AGENT_PRIVATE_KEY=0x...
CLAIM_REGISTRY_ADDRESS=0x...
BASE_SEPOLIA_RPC_URL=          # optional, defaults to https://sepolia.base.org
FILECOIN_RPC_URL=              # optional, defaults to the Calibration glif node
```

For EAS attestations additionally set `EAS_CONTRACT_ADDRESS`, `EAS_SCHEMA_UID`,
and `EAS_SCHEMA` — all three, or the feature stays off.

Re-check `/health` to confirm the features flipped to `true`.

---

## 7. Optional: phone calls (Twilio)

Browser calling works without this. For a real phone number, buy one in Twilio
and connect it in the ElevenLabs agent's phone settings — ElevenLabs handles the
telephony bridge, so the backend needs no Twilio configuration.

---

## Verification checklist

- [ ] `/health` returns `status: ok`
- [ ] `/health` reports `security.tools_authentication: "enforced"` and your
      dashboard as the only entry in `cors_allowed_origins`
- [ ] Dashboard **Claims** lists the seeded claims
- [ ] `POST /api/tools/check-policy` with `POL-2024-001234`, carrying
      `x-tools-token`, returns a policy — and returns **401** without it
- [ ] A browser call reaches the agent and it answers with the first message
- [ ] Asking about claim `CLM-2026-000234` returns real data from the database
- [ ] After hanging up, the call appears under **Call History** with a transcript
- [ ] That call's tool executions are listed
- [ ] `npm run check:drift` exits zero — the repository, the API and the
      dashboard are all on the same commit
- [ ] *(if step 6)* A filed claim shows a **tx hash** under **Evidence**
      (the `/blockchain` route). The **CID** beside it will be empty, and that
      is the expected result, not a broken deployment: Filecoin archival has
      never once succeeded here.
      `/health` says so directly — `filecoin_uploads.last_attempt` is `failed`
      and `last_success_at` is `null` — and live claim rows carry
      `filecoin_cid: null`. Attestation is the half that works; the tx hash
      resolves on Base Sepolia. Treat a missing CID as a known gap, and only a
      missing tx hash as a failure to investigate.

---

## Security before real use

This is a prototype, but it is no longer wide open. What is already in place, and
visible from outside at `/health`:

- **The 14 `/api/tools/*` routes are behind a shared token** (`TOOLS_API_TOKEN`,
  sent as `x-tools-token` or `Authorization: Bearer`), along with
  `conversation-init` and the tool-execution audit write. Twelve of the 14 are
  the webhook voice tools of step 3; the other two — `adjudicate-claim` and
  `refund-deductible` — are back-office and are deliberately not registered as
  voice tools. Both route files apply the token as a `preHandler` hook across
  the whole plugin, so the count is the number of routes, not a list anyone has
  to keep in sync. Production reports
  `security.tools_authentication: "enforced"`. With no token configured they
  refuse with 503 in production rather than falling open.
- **CORS is a single-origin allowlist**, not `origin: true`. Production reports
  one entry — the deployed dashboard — and `cors_allows_localhost: false`.
- **Post-call webhooks are signature-verified** when
  `ELEVENLABS_WEBHOOK_SECRET` is set, and refuse rather than process unverified
  ones in production.
- The agent-config write endpoints require `ADMIN_TOKEN` and are disabled
  without one.

What is still missing, and matters before real customer data:

- **The read endpoints are unauthenticated.** `GET /api/claims`,
  `/api/claims/:id`, `/api/calls`, `/api/calls/:id`, `/api/escalations`,
  `/api/analytics`, `/api/agent-config` and the adjudication review queue are
  open to anyone who knows the URL. They return customer names, phone numbers,
  claim details and full call transcripts. The dashboard has no login.
- **The document upload and verify endpoints take no token**, unlike the tool
  routes.
- **No caller identity verification.** The agent discloses claim details to
  whoever reads out a claim number.
