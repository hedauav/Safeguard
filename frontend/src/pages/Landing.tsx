import { useNavigate } from 'react-router-dom'
import {
  Shield,
  Phone,
  HardDrive,
  Layers,
  Server,
  Mic2,
  CreditCard,
  BarChart2,
  Zap,
  ClipboardList,
  ArrowRight,
} from 'lucide-react'

export default function Landing() {
  const navigate = useNavigate()
  return (
    <div className="min-h-screen bg-white font-sans">
      <style>{`
        @keyframes marqueeScroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .marquee-logos {
          width: max-content;
          animation: marqueeScroll 28s linear infinite;
        }
        html { scroll-behavior: smooth; }
      `}</style>

      {/* ── 1. Navbar ── */}
      <nav className="sticky top-0 z-50 bg-white border-b border-gray-200">
        <div className="w-full px-8 flex items-center justify-between" style={{ height: '72px' }}>

          {/* Left: Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <Shield className="w-6 h-6 text-blue-600" />
            <span className="text-xl font-bold text-gray-900">SafeGuard</span>
          </div>

          {/* Center: Nav links */}
          <div className="hidden md:flex items-center gap-8">
            <button onClick={() => document.getElementById('stats')?.scrollIntoView({ behavior: 'smooth' })} className="text-base text-gray-500 hover:text-gray-900 transition-colors bg-transparent border-0 cursor-pointer">Stats</button>
            <button onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })} className="text-base text-gray-500 hover:text-gray-900 transition-colors bg-transparent border-0 cursor-pointer">Features</button>
            <button onClick={() => document.getElementById('tech')?.scrollIntoView({ behavior: 'smooth' })} className="text-base text-gray-500 hover:text-gray-900 transition-colors bg-transparent border-0 cursor-pointer">Technology</button>
            <button onClick={() => document.getElementById('cta')?.scrollIntoView({ behavior: 'smooth' })} className="text-base text-gray-500 hover:text-gray-900 transition-colors bg-transparent border-0 cursor-pointer">Get Started</button>
          </div>

          {/* There is no auth in this app. This slot held "Log in" and "Get
              Started", both of which just navigated to /claims — two false
              affordances pointing at the same unguarded page. "Log in" is gone
              rather than relabelled, because with no account to log in to there
              is no honest label for it that differs from the button beside it. */}
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => navigate('/claims')} className="bg-gray-900 text-white text-base font-medium px-6 py-3 rounded-full hover:bg-gray-700 transition-colors">
              Open the dashboard
            </button>
          </div>

        </div>
      </nav>

      {/* ── 2. Hero (full-bleed oversized type) ── */}
      <section className="relative overflow-hidden px-6 pt-12 pb-16 border-b border-gray-200">
        {/* Giant type block — no max-w, full bleed */}
        <div className="relative">

          {/* Line 1: "Process." — dark, left aligned */}
          <div className="flex items-baseline">
            <span
              className="font-black text-gray-900 leading-none tracking-tight select-none"
              style={{ fontSize: 'clamp(80px, 13vw, 180px)' }}
            >
              Process.
            </span>
          </div>

          {/* Floating card 1 — positioned top-right of this line */}
          <div className="absolute top-4 right-6 bg-gray-50 rounded-2xl px-6 py-5 shadow-sm border border-gray-200 w-56">
            {/* These two figures come from the run recorded in EVALUATION.md
                (2026-08-25, commit 937daf8). They previously read 488 ms over
                202 cases, which EVALUATION.md now retracts: the harness
                generates cases from the database, so filing one claim through
                the live agent moved the total. Re-read that table before
                editing these — do not carry a number forward. */}
            <p className="text-sm text-gray-400 mb-1">Median tool latency</p>
            <p className="text-3xl font-bold text-gray-900">492 ms</p>
            <p className="text-sm text-gray-500 mt-1">measured over 204 cases</p>
          </div>

          {/* Line 2: "Verify." — ghost/faint, slightly indented right */}
          <div className="flex items-baseline justify-end -mt-4">
            <span
              className="font-black leading-none tracking-tight select-none"
              style={{ fontSize: 'clamp(80px, 13vw, 180px)', color: '#d1d5db' }}
            >
              Verify.
            </span>
          </div>

          {/* Line 3: "Resolve." — dark, left, bleeds slightly */}
          <div className="flex items-baseline -mt-4">
            <span
              className="font-black text-gray-900 leading-none tracking-tight select-none"
              style={{ fontSize: 'clamp(80px, 13vw, 180px)' }}
            >
              Resolve.
            </span>
          </div>

          {/* Floating card 2 — bottom right area */}
          {/* This card carried a pulsing green dot labelled "Live processing".
              Nothing fed it — no subscription, no poll, not even a fetch. It was
              decoration that read as a live activity indicator, so the dot and
              the "Live" framing are gone. The list below is a static statement
              of what the agent's tools cover, which is true of the code. */}
          <div className="absolute bottom-0 right-6 bg-gray-50 rounded-2xl px-6 py-5 shadow-sm border border-gray-200 w-64">
            <p className="text-sm text-gray-400 mb-2">What the agent handles</p>
            <p className="text-sm text-gray-600 leading-relaxed">AI voice agent · Claim lookup · Filing</p>
          </div>
        </div>

        {/* Subtitle + CTAs below the type */}
        <div className="mt-12 flex flex-col sm:flex-row sm:items-end justify-between gap-8 max-w-7xl">
          <p className="text-lg text-gray-500 max-w-sm leading-relaxed">
            SafeGuard's AI voice agent handles claims calls in real time — looking up policies, checking documents, and filing claims mid-conversation. No menus. No hold music.
          </p>
          <div className="flex flex-wrap gap-3 shrink-0">
            <button onClick={() => navigate('/claims')} className="bg-gray-900 text-white text-sm font-medium px-6 py-3 rounded-full hover:bg-gray-700 transition-colors flex items-center gap-2">
              Start a Claim <ArrowRight className="w-4 h-4" />
            </button>
            <button onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })} className="border border-gray-400 text-gray-700 text-sm font-medium px-6 py-3 rounded-full hover:bg-gray-100 transition-colors">
              See How It Works
            </button>
          </div>
        </div>
      </section>

      {/* ── 3. Logo strip (marquee) ── */}
      <section className="py-10 border-b border-gray-200 overflow-hidden">
        <p className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-6 px-8">
          Powered by world-class infrastructure
        </p>
        <div className="relative overflow-hidden">
          <div className="marquee-logos flex">
            {/* First copy */}
            {[
              { icon: Mic2, name: 'ElevenLabs' },
              { icon: Server, name: 'Supabase' },
              { icon: CreditCard, name: 'Razorpay' },
              { icon: HardDrive, name: 'Filecoin' },
              { icon: Layers, name: 'Base Sepolia' },
            ].map(({ icon: Icon, name }) => (
              <div key={`a-${name}`} className="flex items-center gap-2 text-gray-400 whitespace-nowrap mx-10">
                <Icon className="w-5 h-5 flex-shrink-0" />
                <span className="text-base font-semibold">{name}</span>
              </div>
            ))}
            {/* Exact duplicate for seamless loop */}
            {[
              { icon: Mic2, name: 'ElevenLabs' },
              { icon: Server, name: 'Supabase' },
              { icon: CreditCard, name: 'Razorpay' },
              { icon: HardDrive, name: 'Filecoin' },
              { icon: Layers, name: 'Base Sepolia' },
            ].map(({ icon: Icon, name }) => (
              <div key={`b-${name}`} className="flex items-center gap-2 text-gray-400 whitespace-nowrap mx-10">
                <Icon className="w-5 h-5 flex-shrink-0" />
                <span className="text-base font-semibold">{name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 4. Stats (inline row) ── */}
      <section id="stats" className="py-20 px-6 border-b border-gray-200">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            // The case count is not a constant: 27 cases are hand-written and
            // the rest are generated from the database (two per claim, one per
            // policy). 204 is what the 2026-08-25 run reported against a
            // database holding 63 claims and 51 policies. Re-run
            // `npm run evaluate` and copy the table — never adjust by hand.
            { value: '204', label: 'Evaluation cases, all passing', source: 'EVALUATION.md — 27 hand-written, 177 generated from the database' },
            { value: '492 ms', label: 'Median tool latency', source: 'EVALUATION.md — p50 across the same 204 cases' },
            { value: '62', label: 'Claims in the seeded dataset', source: 'EVALUATION.md — synthetic records, fully covered' },
            // 364 is what the runner reports for the `src/**` glob npm test uses. The 65
            // tests under backend/eval/tests/ fall outside that glob and outside CI, so
            // they are named separately rather than folded into one flattering total.
            { value: '364', label: 'Automated tests', source: 'Reported by the test runner (npm test), plus 65 more in backend/eval/tests that its glob does not reach' },
          ].map(({ value, label, source }) => (
            <div key={label}>
              <div className="text-5xl font-black text-gray-900 tracking-tight mb-1">{value}</div>
              <div className="text-base text-gray-500">{label}</div>
              <div className="text-xs text-gray-400 mt-2 leading-relaxed">{source}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 5. Features (editorial split + card grid) ── */}
      <section id="features" className="py-20 px-6 border-b border-gray-200">
        <div className="max-w-7xl mx-auto">
          {/* Split header */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 mb-16">
            <div>
              <p className="text-sm font-semibold text-blue-600 uppercase tracking-widest mb-4">How it works</p>
              <h2 className="text-5xl font-bold text-gray-900 leading-tight">
                Two systems working<br />as one.
              </h2>
            </div>
            <div className="flex items-end">
              {/* This paragraph used to claim that every filed claim is
                  adjudicated for a human, enforced server-side. That was not
                  true. `file_claim` (backend/src/routes/webhook-tools.ts) only
                  kicks off the evidence pipeline; `adjudicate_claim` is a
                  separate tool the model chooses to call, and it can be
                  switched off from the Agent Config page. What IS enforceable
                  is narrower and worth saying on its own: no code path lets the
                  agent write a claim's status. The only two writers are a human
                  review decision (routes/adjudication-review.ts) and a
                  settlement (services/settlement-service.ts). */}
              <p className="text-lg text-gray-600 leading-relaxed">
                From the first ring to a filed claim — SafeGuard's agent understands what a caller needs, retrieves it from live policy data, and acts through a bounded set of tool calls. What it cannot do is decide the outcome: no tool the agent can reach sets a claim's status. A claim is only ever approved or denied by a human working the review queue, or moved to paid by a settlement. A claim the agent files lands as submitted and waits there.
              </p>
            </div>
          </div>

          {/* 3-col card grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Phone, label: 'AI Voice Agent', desc: 'ElevenLabs-powered conversational AI built to take inbound claims calls, extracting structured data from natural conversation. Designed to run unattended; not yet fielding live policyholder calls.' },
              { icon: ClipboardList, label: 'Grounded in Real Data', desc: 'The agent never invents a claim or policy detail. Every answer comes from a tool call against live records.' },
              // "Filed claims are adjudicated ... then held for a human" implied
              // adjudication runs automatically on filing. It does not — it is a
              // separate tool call. The holding half is true and is the part
              // that matters, so lead with that.
              { icon: Shield, label: 'A Human Decides', desc: 'Where a claim is adjudicated, the recommendation is produced against deterministic rules and then held for a human to approve or reject — the recommendation never moves the claim itself. When a caller is unhappy or a case is complex, the agent hands off to a supervisor with full context, a priority, and a reference number the caller can quote.' },
              // Not real-time: Analytics.tsx fetches once on mount. No polling,
              // no websocket, no refresh. Describe the fetch, not a stream.
              { icon: BarChart2, label: 'Analytics', desc: 'Call metrics, claim outcomes, and processing KPIs, computed from the database and read when you open the page.' },
              { icon: Zap, label: 'Answers From Live Data', desc: 'Every figure the agent speaks comes back from a tool call against the database. It holds no claim facts of its own, so it cannot invent one.' },
              { icon: HardDrive, label: 'Full Audit Trail', desc: 'Every call, transcript, and tool execution is recorded, with tamper-evident hashing on each filed claim.' },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="bg-gray-50 border border-gray-200 rounded-2xl p-7">
                <Icon className="w-6 h-6 text-gray-500 mb-6" />
                <h3 className="text-base font-semibold text-gray-900 mb-2">{label}</h3>
                <p className="text-sm leading-relaxed text-gray-600">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 6. Tech Stack (editorial split) ── */}
      <section id="tech" className="py-20 px-6 border-b border-gray-200">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 mb-16">
            <div>
              <p className="text-sm font-semibold text-blue-600 uppercase tracking-widest mb-4">Built on the best</p>
              <h2 className="text-5xl font-bold text-gray-900 leading-tight">
                Built on specialist<br />infrastructure.
              </h2>
            </div>
            <div className="flex items-end">
              <p className="text-lg text-gray-600 leading-relaxed">
                Voice, storage, payments, and attestation are handled by services built for them, so the code we wrote is the part specific to claims. Several of those integrations are optional and report their own status at <code className="text-gray-900">/health</code>.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { icon: Mic2, name: 'ElevenLabs', desc: 'State-of-the-art conversational AI with low-latency voice synthesis and real-time function calling.' },
              { icon: HardDrive, name: 'Filecoin', desc: 'Evidence bundles archived via the Synapse SDK. A failed upload is recorded as unarchived, never as stored.' },
              { icon: Layers, name: 'Base Sepolia', desc: 'Where an attestation wallet is configured, the evidence hash is anchored on-chain, so later alteration is detectable without trusting our database. Attestation is optional and currently off; /health reports whether it is live.' },
            ].map(({ icon: Icon, name, desc }) => (
              <div key={name} className="bg-gray-50 border border-gray-200 rounded-2xl p-7">
                <Icon className="w-6 h-6 text-gray-500 mb-6" />
                <h3 className="text-base font-semibold text-gray-900 mb-2">{name}</h3>
                <p className="text-sm leading-relaxed text-gray-600">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 7. Final CTA (left-aligned, editorial) ── */}
      <section id="cta" className="py-20 px-6 border-b border-gray-200">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-5xl font-bold text-gray-900 leading-tight mb-4">
              Ready to modernize<br />your claims process?
            </h2>
            <p className="text-lg text-gray-600 mb-8">
              Every call, tool call, and filed claim is recorded from the first run. SafeGuard is a working prototype, not a production deployment — open it, read the audit trail, and judge it yourself.
            </p>
            <button onClick={() => navigate('/claims')} className="bg-gray-900 text-white text-sm font-medium px-6 py-3 rounded-full hover:bg-gray-700 transition-colors flex items-center gap-2">
              Open the Dashboard <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          {/* Right: simple stat block */}
          <div className="bg-gray-50 border border-gray-200 rounded-2xl p-10 grid grid-cols-2 gap-6">
            <p className="col-span-2 text-sm font-semibold text-gray-400 uppercase tracking-widest -mb-2">
              The seeded dataset
            </p>
            {[
              { v: '32', l: 'Customers' },
              { v: '51', l: 'Policies' },
              { v: '62', l: 'Claims' },
              { v: '11', l: 'Agent tools' },
            ].map(({ v, l }) => (
              <div key={l}>
                <div className="text-4xl font-black text-gray-900 mb-1">{v}</div>
                <div className="text-sm text-gray-500">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 8. Footer ── */}
      <footer className="py-8 px-6 border-t border-gray-200">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-semibold text-gray-900">SafeGuard</span>
          </div>
          <p className="text-sm text-gray-400">© 2026 SafeGuard. All rights reserved.</p>
        </div>
      </footer>

    </div>
  )
}
