import { useNavigate } from 'react-router-dom'
import {
  Shield,
  Phone,
  HardDrive,
  Layers,
  Server,
  Mic2,
  Globe,
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

          {/* Right: Auth buttons */}
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => navigate('/claims')} className="text-base text-gray-600 hover:text-gray-900 transition-colors px-3 py-2">
              Log in
            </button>
            <button onClick={() => navigate('/claims')} className="bg-gray-900 text-white text-base font-medium px-6 py-3 rounded-full hover:bg-gray-700 transition-colors">
              Get Started
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
            <p className="text-sm text-gray-400 mb-1">Avg processing time</p>
            <p className="text-3xl font-bold text-gray-900">&lt; 2 min</p>
            <p className="text-sm text-gray-500 mt-1">from call to filed claim</p>
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
          <div className="absolute bottom-0 right-6 bg-gray-50 rounded-2xl px-6 py-5 shadow-sm border border-gray-200 w-64">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <p className="text-sm text-gray-400">Live processing</p>
            </div>
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
              { icon: HardDrive, name: 'Filecoin' },
              { icon: Layers, name: 'Base' },
              { icon: Server, name: 'Supabase' },
              { icon: Phone, name: 'Twilio' },
              { icon: Globe, name: 'Ethereum' },
              { icon: Shield, name: 'Base Sepolia' },
              { icon: Zap, name: 'EAS Protocol' },
            ].map(({ icon: Icon, name }) => (
              <div key={`a-${name}`} className="flex items-center gap-2 text-gray-400 whitespace-nowrap mx-10">
                <Icon className="w-5 h-5 flex-shrink-0" />
                <span className="text-base font-semibold">{name}</span>
              </div>
            ))}
            {/* Exact duplicate for seamless loop */}
            {[
              { icon: Mic2, name: 'ElevenLabs' },
              { icon: HardDrive, name: 'Filecoin' },
              { icon: Layers, name: 'Base' },
              { icon: Server, name: 'Supabase' },
              { icon: Phone, name: 'Twilio' },
              { icon: Globe, name: 'Ethereum' },
              { icon: Shield, name: 'Base Sepolia' },
              { icon: Zap, name: 'EAS Protocol' },
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
            { value: '202', label: 'Evaluation cases, all passing' },
            { value: '488 ms', label: 'Median tool latency' },
            { value: '62', label: 'Claims in the test dataset' },
            { value: '117', label: 'Automated tests' },
          ].map(({ value, label }) => (
            <div key={label}>
              <div className="text-5xl font-black text-gray-900 tracking-tight mb-1">{value}</div>
              <div className="text-base text-gray-500">{label}</div>
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
              <p className="text-lg text-gray-600 leading-relaxed">
                From the first ring to a filed claim — SafeGuard's agent understands what a caller needs, retrieves it from live policy data, and acts on it without a human in the loop.
              </p>
            </div>
          </div>

          {/* 3-col card grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Phone, label: 'AI Voice Agent', desc: 'ElevenLabs-powered conversational AI handles inbound claims calls 24/7, extracting structured data from natural conversation.' },
              { icon: ClipboardList, label: 'Grounded in Real Data', desc: 'The agent never invents a claim or policy detail. Every answer comes from a tool call against live records.' },
              { icon: Shield, label: 'Human Escalation', desc: 'When a caller is unhappy or a case is complex, the agent hands off to a supervisor with full context and an SLA.' },
              { icon: BarChart2, label: 'Real-time Analytics', desc: 'Live dashboards track call metrics, claim outcomes, and processing KPIs as they happen.' },
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
                Enterprise-grade<br />infrastructure.
              </h2>
            </div>
            <div className="flex items-end">
              <p className="text-lg text-gray-600 leading-relaxed">
                We integrate best-in-class tools so you don't have to worry about the stack — just the outcomes.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { icon: Mic2, name: 'ElevenLabs', desc: 'State-of-the-art conversational AI with low-latency voice synthesis and real-time function calling.' },
              { icon: HardDrive, name: 'Filecoin', desc: 'Evidence bundles archived via the Synapse SDK. A failed upload is recorded as unarchived, never as stored.' },
              { icon: Layers, name: 'Base Sepolia', desc: 'The evidence hash is anchored on-chain, so later alteration is detectable without trusting our database.' },
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
              No setup fees. Deploy in minutes. Full audit trail from day one.
            </p>
            <button onClick={() => navigate('/claims')} className="bg-gray-900 text-white text-sm font-medium px-6 py-3 rounded-full hover:bg-gray-700 transition-colors flex items-center gap-2">
              Get Started Free <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          {/* Right: simple stat block */}
          <div className="bg-gray-50 border border-gray-200 rounded-2xl p-10 grid grid-cols-2 gap-6">
            {[
              { v: '24/7', l: 'Always available' },
              { v: '< 2min', l: 'Time to claim' },
              { v: '0', l: 'Manual steps' },
              { v: '∞', l: 'Audit records' },
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
          <p className="text-sm text-gray-400">© 2025 SafeGuard. All rights reserved.</p>
        </div>
      </footer>

    </div>
  )
}
