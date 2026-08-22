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
   That creates all 10 tables and inserts demo customers, policies, and claims.
   It is idempotent — safe to re-run.
3. Confirm the tables exist: `customers`, `policies`, `claims`, `call_logs`,
   `call_tool_executions`, `escalations`, `scheduled_callbacks`,
   `agent_registrations`, `filecoin_uploads`, `evidence_bundles`.

If you later edit an individual migration, regenerate the combined file with
`bash backend/database/build-run-all.sh`.

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

Check `http://localhost:3005/health`. It reports which integrations are actually
configured:

```json
{
  "status": "ok",
  "features": {
    "filecoin_uploads": false,
    "chain_attestation": false,
    "eas_attestation": false,
    "webhook_signature_verification": false
  }
}
```

`false` means that feature is switched off, not that it is broken. Optional
features stay off until you supply their credentials, and nothing is simulated
in their absence.

Smoke-test a tool endpoint against the seeded data:

```bash
curl -X POST http://localhost:3005/api/tools/check-policy \
  -H 'Content-Type: application/json' \
  -d '{"policy_number":"POL-2024-001234"}'
```

Run the backend test suite with `npm test` (from `backend/`).

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

`railway.json` and `Dockerfile` are already configured; the healthcheck path is
`/health`.

```bash
npm i -g @railway/cli
railway login                 # opens a browser
cd backend
railway init                  # create/link a project
railway up                    # build and deploy
```

Set variables in the Railway dashboard (or `railway variables --set`):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `ELEVENLABS_WEBHOOK_SECRET` | from step 3 |
| `NODE_ENV` | `production` |
| `FRONTEND_URL` | your Vercel URL (after step 5) |

Railway supplies `PORT` automatically. Confirm with
`curl https://<your-app>.up.railway.app/health`.

Then go back to step 3 and update every tool URL and the webhook URL to the
Railway hostname.

---

## 5. Deploy the frontend (Vercel)

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
forge test                    # 16 tests, including access control
PRIVATE_KEY=0x... forge script script/DeployClaimRegistry.s.sol \
  --rpc-url https://sepolia.base.org --broadcast
```

Copy the deployed address into `CLAIM_REGISTRY_ADDRESS`.

`verifyClaim()` is owner-only — the deploying wallet becomes the owner. Anyone
may `fileClaim()`, and the contract records who did.

> `backend/src/abis/ClaimRegistry.json` holds the interface only. If you change
> the contract, update that file to match.

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
- [ ] Dashboard **Claims** lists the seeded claims
- [ ] `POST /api/tools/check-policy` with `POL-2024-001234` returns a policy
- [ ] A browser call reaches the agent and it answers with the first message
- [ ] Asking about claim `CLM-2026-000234` returns real data from the database
- [ ] After hanging up, the call appears under **Call History** with a transcript
- [ ] That call's tool executions are listed
- [ ] *(if step 6)* A filed claim shows a CID and tx hash under **Blockchain**

---

## Security before real use

This is a prototype. The API is currently **unauthenticated** — every endpoint,
including all eight agent tools, is open to anyone who knows the URL. Before
putting real customer data in it you need, at minimum:

- A shared secret or signed header on `/api/tools/*`
- `ELEVENLABS_WEBHOOK_SECRET` set (otherwise post-call webhooks are unverified)
- Authentication on the dashboard, and CORS narrowed from the current `origin: true`
- Caller identity verification before the agent discloses claim details
