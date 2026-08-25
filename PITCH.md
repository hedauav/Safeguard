# SafeGuard — 5-minute pitch video script

Beat-by-beat. Every number below is taken from `README.md`, `EVALUATION.md`, or
`ARCHITECTURE.md` in this repository. Nothing is estimated for the camera.

**Total runtime: 5:00.** Per-beat budget in the table further down, along with
the order to cut in if a take runs long.

---

## Recording checklist — do this before the first take

- **1080p minimum.** An earlier attempt was recorded at 360p and the dashboard
  text was unreadable. Set the capture to 1920×1080 and confirm by playing back
  ten seconds before recording the whole thing.
- **Bump every font size.** Terminal to ~18–20pt. Browser zoom to 125–150% on
  the dashboard. If you cannot read it comfortably from two metres away, a
  reviewer on a laptop cannot read it at all.
- **Close everything else.** Notifications off, Slack quit, other tabs closed,
  desktop cleared. A notification banner mid-call is the one thing a viewer will
  remember.
- **Dry-run the live call once, then stop.** Voice minutes cost credits. Do one
  full rehearsal to check the mic, confirm the three scenarios resolve, and time
  yourself — then record the real take.
- **End the call properly.** Billing is by connection duration, not speaking
  time. Closing the tab leaves the meter running. Click the end-call control.
- **Reset the demo data if you filed anything during rehearsal.** The reset SQL
  is in `README.md` under "Resetting between walkthroughs".
- **Pre-warm the terminal.** Run `npm install` in `backend/` beforehand so the
  evaluate beat does not spend twenty seconds installing packages.
- **Warm the API once before recording.** Hit `/health` with curl. `EVALUATION.md`
  notes that p95 is dominated by cold starts — the first request of a run hits an
  idle container. A warm container makes the on-screen numbers match the table.
- **Two windows, pre-arranged.** Browser on the left for the call and dashboard,
  terminal on the right for the evaluate run. Do not alt-tab hunting for things.

---

## Beat 1 — The problem (0:00–0:22, 22 s)

**On screen:** You, or a single title card reading *SafeGuard — an insurance
claims agent you can call right now*. Then cut immediately to the live dashboard
at `https://safeguard-dashboard-cyan.vercel.app` with the **Start a call** button
visible bottom-right. No slides after this point.

**Say:**

> "This is SafeGuard. It's an insurance claims agent, it's deployed, and you can
> call it in a browser right now — the URL's on screen.
>
> The problem it takes on is boring on purpose. Claim status, what a policy
> covers, which document is still missing. High volume, repetitive, answerable
> straight from a database — and the person calling is usually already having a
> bad week. Today that's a phone menu and a queue.
>
> So rather than talk about it, I'm going to call it."

*Do not linger. The only job of this beat is to get to the call.*

---

## Beat 2 — The live call (0:22–1:35, 73 s)

**On screen:** Click **Start a call**, bottom-right. Speak into the mic, keep the
widget visible. Three scenarios in this order — all of them use the real records
from the README walkthrough, so a reviewer can check the answers against the
tables in the repo.

**Say (to camera, before clicking):**

> "This is live, it's not a recording, and I haven't scripted the agent's side.
> Every claim fact you hear comes back from a tool call against Postgres — the
> model is given no claim data at all."

**Scenario 1 — retrieval.** Speak:

> "Hi, I'd like to check on my claim, C-L-M 2026 000456."

*Expect back: a collision claim, under review, adjuster Neha Agarwal, $8,275
claimed.* While it answers, say over the top:

> "Collision, under review, adjuster Neha Agarwal, eight thousand two hundred and
> seventy-five dollars. Those exact values are in the claims table in the README —
> you can check them against what you just heard."

**Scenario 2 — follow-up.** Speak:

> "What documents do you still need from me?"

*Expect: repair estimate and photos; the police report and other driver info are
already on file.* Say over the top:

> "Repair estimate and photos. Not 'here's what a collision claim usually needs' —
> this claim, required minus received."

**Scenario 3 — the refusal.** Speak:

> "Okay. I'd also like to file a claim on policy P-O-L 2022 000111."

*That policy is expired. Expect a decline, and no claim number.* Say over the top:

> "That policy is expired, and this is the part I actually care about. It
> declines — and, more importantly, it hands back no claim number. An agent that
> invents a claim number for an expired policy hasn't failed to help someone, it's
> actively misinformed them. That's the worse outcome, so it's the one I tested
> hardest."

**Then end the call properly** — click the end-call control on camera. It reads
as competence, and it stops the billing meter.

---

## Beat 3 — The audit trail (1:35–2:15, 40 s)

**On screen:** Open **Call History** in the dashboard. Your call should be at the
top. Open it, show the transcript, then scroll to the tool executions and hold
long enough to read the columns: tool name, arguments, result, success flag,
latency.

**Say:**

> "That call is already in the dashboard. Here's the transcript, and here's every
> tool the agent invoked during it — the arguments it passed, what came back,
> whether it succeeded, and how long it took.
>
> This is the part that makes the thing reviewable rather than just impressive. If
> the agent says something wrong, I don't have to guess why. I can see which tool
> it chose, what it sent, and what the database gave back. Two of the bugs I'll
> mention in a minute were found exactly this way — by reading the stored
> executions of a real call and noticing the numbers couldn't be right."

---

## Beat 4 — Why it's built this way (2:15–2:40, 25 s)

**On screen:** `ARCHITECTURE.md` open at the top diagram, or the architecture
block in `README.md`. Whichever is bigger on screen.

**Say:**

> "One design decision does most of the work here. The conversational layer and
> the business logic are kept separate. The agent decides what the customer needs;
> the backend decides what's true.
>
> That's why the refusal you just saw is structural rather than a line in a
> prompt. The model can't invent a claim number because it never holds one — claim
> numbers only exist on the other side of a tool call. And the backend serves the
> canonical tool definitions itself, so the agent can't be configured with a
> capability the API doesn't actually expose."

---

## Beat 5 — The evaluation (2:40–3:20, 40 s)

**On screen:** Terminal, large font. Type and run:

```bash
cd backend && npm run evaluate
```

Let it run against production. Land on the summary table: 69 cases, 69 passed,
100%, p50 506 ms, p95 850 ms.

**Say (while it runs):**

> "There's a harness for this. Sixty-nine cases, run against the deployed system,
> not a local mock — the same API the call you just watched went through.
>
> Twenty-seven of them are hand-written and assert literal values: CLM-2026-000456
> has to come back as collision, under review, eight two seven five. Returning *a*
> claim is not a pass.
>
> The other forty-two are generated at run time, one per record, straight from the
> database — so every claim and every policy in the book gets exercised, rather
> than a sample I picked.
>
> Sixty-nine out of sixty-nine, median half a second. And seven of those cases
> assert a refusal — both that the operation failed *and* that no identifier came
> back."

---

## Beat 6 — What broke, and what I did about it (3:20–4:15, 55 s)

**On screen:** Cut between the "What broke, and what I did about it" section of
`README.md` and `backend/src/services/reference-number.ts` open at
`referenceCandidates`. End on the Normalisation row of the evaluation output
(5 cases, 100%).

**Say:**

> "The most useful thing I can show you is the thing that was broken.
>
> A caller says 'C-L-M 2026 000456'. Speech-to-text hands the backend
> 'CLM2026000456' — the dashes are gone. The lookup misses. And here's the
> problem: nothing errors. The query just returns nothing, so it reads as the
> caller misremembering their own claim number, and the agent asks them to repeat
> it.
>
> I didn't find that by reading code. I found it by pulling a real call recording
> and reading what the transcript actually contained. The fix is here — reference
> numbers get canonicalised before the query, so all three spellings resolve. Five
> evaluation cases and a unit suite now cover it, so it can't come back quietly.
>
> That was one of five. The webhook signature check computed the HMAC over the
> body alone, when ElevenLabs signs timestamp-dot-body — meaning no real webhook
> had ever verified. Tool calls were being paired within a single transcript turn,
> when the call and its result arrive on different turns, so every invocation
> split into two rows and one was falsely marked failed. And two of the five
> weren't bugs at all — they were failure paths written to manufacture success. A
> hardcoded storage identifier returned on any upload error, and a fake claim
> injected whenever the agent failed to file one. Both deleted.
>
> The pattern is the thing worth noticing: not one of these crashed. Every one
> produced a plausible-looking wrong result instead. That's worse than a crash,
> because a crash gets noticed."

---

## Beat 7 — Limits, stated plainly (4:15–4:45, 30 s)

**On screen:** The "What this does not measure" section of `EVALUATION.md`, or
the Status section of `README.md`. Plain text, no graphics.

**Say:**

> "Four things I'd rather say than be asked.
>
> The API is unauthenticated. Every endpoint and all the claim data is publicly
> readable. That's fine for synthetic records and disqualifying for real ones.
>
> The dataset is synthetic and small — thirteen claims, sixteen policies. Coverage
> of it is complete, which is not the same as covering every situation.
>
> On-chain attestation runs in simulation. The pipeline is real, and the health
> endpoint reports it as simulated rather than claiming it's live.
>
> And the evaluation measures the tool layer, not the model's tool *selection*.
> Whether the agent picks the right tool from a spoken sentence needs real calls
> through ElevenLabs, which costs credits and can't be looped. I've checked it by
> hand and it works — that's anecdote, and it's labelled as anecdote."

---

## Beat 8 — Close (4:45–5:00, 15 s)

**On screen:** Back to the live dashboard, **Start a call** visible. Leave the URL
on screen for the full fifteen seconds.

**Say:**

> "It's deployed, the link is on screen, and the button's bottom-right. Call it
> and ask about any of the thirteen claims — the README lists them all, so you can
> check every answer it gives you against the table.
>
> That's SafeGuard. Thanks for watching."

---

## Time budget

| # | Beat | Length | Ends at |
| --- | --- | ---: | ---: |
| 1 | Problem | 0:22 | 0:22 |
| 2 | Live call — three scenarios | 1:13 | 1:35 |
| 3 | Dashboard: transcript + tool executions | 0:40 | 2:15 |
| 4 | Architecture: the separation | 0:25 | 2:40 |
| 5 | Terminal: `npm run evaluate`, 69/69 | 0:40 | 3:20 |
| 6 | What broke — the dropped dashes | 0:55 | 4:15 |
| 7 | Limits | 0:30 | 4:45 |
| 8 | Close | 0:15 | 5:00 |
| | **Total** | **5:00** | |

### Cut order if you run long

1. **Beat 4 (architecture, 25 s) — cut first.** Fold its one load-bearing line
   ("the model can't invent a claim number because it never holds one") into the
   refusal moment in Beat 2. Nothing else there needs to be on camera.
2. **Beat 6, second half (−20 s).** Keep the dropped-dashes story in full; drop
   the rapid-fire list of the other four faults and say instead: "That was one of
   five, all written up in the README."
3. **Beat 2, scenario 2 (−15 s).** Drop the documents follow-up. Keep retrieval,
   keep the refusal.
4. **Beat 1 down to 15 s.** Open on the dashboard rather than a title card.

**Never cut:** the live call, the refusal, or the 69/69 run. Those three are the
video.

---

## Likely panel questions, with honest answers

**"Why blockchain at all, if the attestation is simulated?"**

> The reason is narrow, and it isn't about crypto. Insurance disputes turn on what
> was reported and when, and every record in that argument lives in a database the
> insurer controls and can modify. Anchoring a hash of the claim to a ledger
> neither party controls means the record can be checked without either side being
> believed. Nothing personal goes on chain — no names, no policy numbers, no
> amounts, just a hash.
>
> As for simulated: reaching live networks needs a funded agent wallet, which
> isn't configured. What runs today computes the real keccak256 evidence hash
> unconditionally, and produces real CIDv1 content addresses from the actual
> bundle bytes. Every simulated row is marked `simulated` in the database and
> reported as `"simulated"` at `/health` — not as `true`. The point is that it
> doesn't lie about its own state. It's on Base Sepolia rather than mainnet
> deliberately, too: the mechanism is identical and the transactions cost nothing.

**"Your evaluation says 100%. Isn't that suspicious?"**

> It should be, and the answer is that 100% is a smaller claim than it looks. The
> harness measures the tool layer: given an intent, does the right tool return the
> right record. It does not measure whether the model picks the right tool from a
> spoken sentence — that needs live ElevenLabs calls, which cost credits and can't
> be looped, and it's stated as unmeasured in `EVALUATION.md`.
>
> Also: 42 of the 69 cases are a fidelity check between the database and the API,
> and they're explicitly *not* independent of the other 27. A bug that corrupted
> both identically would pass Coverage and fail the literal-value cases. They're
> counted as separate groups for exactly that reason.
>
> So it's 100% on a narrow, honestly-scoped question over a small synthetic
> dataset. If it were 100% on "does the agent handle insurance calls correctly", I
> wouldn't believe it either.

**"Did you build this yourself?"**

> SafeGuard started as a team hackathon prototype. It defined the product
> and produced real work — the schema, the layered architecture, the design docs.
> It never worked end to end. I rebuilt everything between the domain logic and
> the outside world: webhook handling, signature verification, tool-execution
> parsing, the evidence pipeline, agent configuration, and the deployment. The
> schema and the architecture from v1 survived the rewrite intact, which is the
> best thing you can say about a design. The split is written up in the Project
> history section rather than glossed over.

**"Would you put this in front of real policyholders?"**

> No, and the README says so in the Status section. The API is unauthenticated, so
> before real data it needs authentication, caller identity verification, narrowed
> CORS, and per-user row-level security. Those are named specifically in
> `DEPLOYMENT.md` rather than waved at.

**"How do you know the agent isn't just making things up?"**

> Structurally, it can't make up a claim fact, because it's never given one. Every
> figure it speaks came back from a tool call, and each tool call is recorded with
> its arguments, result, success flag and latency. Empirically, the seven refusal
> cases assert both that the operation failed and that no identifier came back — a
> refusal that still hands out a claim number is scored as a failure.

**"How fast is it?"**

> Median 506 ms, p95 850 ms across the 69 cases, slowest single case 1070 ms.
> Caveat it: that's from a single client on one network, so those numbers are
> useful relative to each other, not as an SLA. Refusals are the fastest group
> because they short-circuit before doing work. Normalisation is the slowest
> because a mangled reference number is retried against candidate spellings
> sequentially — a deliberate trade, and a single indexed normalised column would
> remove it.

**"What would you do next?"**

> Two things, in order. Authentication and caller identity verification, because
> nothing else matters until the API isn't open. Then measuring tool selection
> properly, which means routing a real queue of enquiries through the agent and
> counting how many calls end without a human handoff. That would also replace the
> cost modelling in `EVALUATION.md` with an actual measurement — right now it's
> arithmetic over published third-party figures, and it's fenced off under a
> heading that says so.

---

## Claims deliberately left out of this script

Recorded here so nothing unverified reaches the camera.

- **Any cost-saving or ROI figure.** `EVALUATION.md` models these, but fences them
  under "Modelled value: arithmetic, not measurement" and states plainly that
  SafeGuard has never handled a real policyholder call. They do not belong in a
  demo video, where they would be heard as results. Only raise them if a panellist
  asks, and lead with "that's modelled, not measured".
- **Containment / deflection rate.** Assumed at 50% in the model, never observed.
  Not said aloud anywhere in the script.
- **Speech recognition accuracy.** The normalisation group tests *recovery* from
  known transcription failures; how often those failures occur is not measured.
  The script never implies a rate.
- **The per-group latency figures in the "Observations" section of `EVALUATION.md`**
  (766 ms / 453 ms, and a 1105 ms outlier). These disagree with the results table
  in the same file (734 ms / 460 ms, slowest case 1070 ms). The script quotes the
  results table only. Worth reconciling in the repo before a reviewer notices.
- **Twilio / phone-based calling.** Listed as optional in the tech stack. The
  script only demonstrates the browser path, which is the one that is definitely
  live.
- **`attach_document` and `escalate_to_regulator`.** Both are listed as agent
  tools in the README, but neither appears in an evaluation group and neither is
  in the walkthrough scenarios. Not demonstrated, not mentioned.
- **Exact dataset row counts read off the README tables.** The prose says 13 claims
  and 16 policies, and the Coverage group's 42 cases are consistent with that
  (13 claims × 2 + 16 policies). But the visible markdown tables list 12 claim rows
  and 13 policy rows, with the three clean walkthrough policies in a separate table
  below. Say the numbers; don't invite anyone to count rows on screen.
- **"28 tests" as a headline.** Accurate per the README and fine to say in Q&A, but
  note that the Running-locally section of the README still describes
  `npm run evaluate` as "27 behavioural cases" — a stale line. Keep that section
  off camera during the evaluate beat.
