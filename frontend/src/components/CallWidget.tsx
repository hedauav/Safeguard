import { createElement, useEffect, useState } from 'react'
import { CreditCard, ExternalLink, FlaskConical } from 'lucide-react'

/**
 * Why a *client* tool and not the server tool's return value.
 *
 * The agent's `offer_renewal` / `collect_deductible` tools run on our backend and
 * return a payment URL to the model. That URL never reaches this browser: the only
 * tool event the widget forwards to the page is `AgentToolResponse`, and its payload
 * is metadata only — `{tool_name, tool_call_id, tool_type, is_error, is_called,
 * event_id}`. There is no result field to read. So the model has to hand the link
 * back to us deliberately, which is what the `show_payment_link` *client* tool in the
 * ElevenLabs workspace is for: the agent calls it after a payment tool succeeds, and
 * the SDK invokes the function we register below, in this tab, with the arguments.
 *
 * Getting our function into the SDK is the other half. We do not construct the
 * Conversation ourselves — the `@elevenlabs/convai-widget-embed` bundle does, and it
 * builds the options object itself. Its one seam is a DOM event: immediately before
 * `startSession` it dispatches `elevenlabs-convai:call` (bubbling and composed, so it
 * escapes the widget's shadow root and reaches `window`), then reads `detail.config`
 * back out and calls `startSession({ ...config, onMessage, onAgentToolRequest, ... })`.
 * Because our config is spread FIRST and the keys it overrides are all `on*` callbacks
 * — verified against the pinned bundle, which overrides exactly onModeChange,
 * onStatusChange, onCanSendFeedbackChange, onMessage, onAgentChatResponsePart,
 * onAgentToolRequest, onAgentToolResponse, onRichContent, onAgentTyping,
 * onExternalAgentConnected, onExternalAgentDisconnected, onDebug and onDisconnect —
 * `clientTools` passes through untouched. The SDK itself defaults `clientTools` to
 * `{}` before spreading caller options, so ours wins.
 *
 * If a future embed release starts setting `clientTools` of its own, this listener
 * goes silently inert: the agent would call `show_payment_link`, the SDK would find no
 * handler, and no button would appear. That fails closed — no wrong link is shown —
 * but it is worth re-checking the bundle whenever the widget is upgraded.
 */

/** The widget invokes a client tool with the raw JSON arguments the model produced. */
type ClientToolHandler = (parameters: Record<string, unknown>) => string

interface ConvaiCallEventDetail {
  config?: {
    clientTools?: Record<string, ClientToolHandler>
    [key: string]: unknown
  }
}

interface PaymentPrompt {
  /** Kept for the real case only; never rendered as an href when `simulated`. */
  url: string
  hostname: string
  /** Null when the model sent an amount we could not make sense of. */
  amountText: string | null
  /** e.g. "to renew POL-2022-000111". May be empty if the agent sent nothing usable. */
  purposeText: string
  simulated: boolean
}

/**
 * Format the amount using the currency the agent supplied rather than assuming INR —
 * the same agent handles policies priced in other currencies, and a hardcoded ₹ would
 * quietly misprice them. An unrecognised code degrades to "CODE 1,980" instead of
 * throwing, because a slightly ugly amount is still worth showing.
 */
function formatAmount(amount: unknown, currency: unknown): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null

  const code =
    typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim())
      ? currency.trim().toUpperCase()
      : null

  if (!code) return amount.toLocaleString()

  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount)
  } catch {
    return `${code} ${amount.toLocaleString()}`
  }
}

/**
 * Turn `purpose` + `reference` into a phrase a customer can check against their own
 * paperwork. "Pay ₹1,980 to renew POL-2022-000111" is verifiable; a bare link is not.
 */
function describePurpose(purpose: unknown, reference: unknown): string {
  const ref = typeof reference === 'string' && reference.trim() ? reference.trim() : null
  const kind = typeof purpose === 'string' ? purpose.trim().toLowerCase() : ''

  if (kind === 'renewal') return ref ? `to renew ${ref}` : 'to renew your policy'
  if (kind === 'deductible') return ref ? `for the deductible on ${ref}` : 'for your deductible'
  if (kind) return ref ? `for ${kind} on ${ref}` : `for ${kind}`
  return ref ? `for ${ref}` : ''
}

/**
 * Mounts the ElevenLabs browser voice widget, plus the payment button the agent drives
 * through the `show_payment_link` client tool.
 *
 * The agent id must come from configuration: a hardcoded fallback silently
 * points the widget at someone else's agent when the env var is missing,
 * which looks like it works but talks to the wrong backend.
 */
export function CallWidget() {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID
  const [prompt, setPrompt] = useState<PaymentPrompt | null>(null)

  useEffect(() => {
    const handleCall = (event: Event) => {
      const config = (event as CustomEvent<ConvaiCallEventDetail>).detail?.config
      if (!config) return

      // A new conversation is starting. Anything left over from the last one is about
      // a policy this caller may not even hold, and a stale payment button is worse
      // than none: it is a live link to a real charge, presented in the wrong context.
      setPrompt(null)

      const showPaymentLink: ClientToolHandler = (parameters) => {
        const params = parameters ?? {}
        const rawUrl = typeof params.payment_link_url === 'string' ? params.payment_link_url.trim() : ''

        // Never invent a destination. If the model omitted the URL or garbled it, we
        // render nothing and say so in the return value, so the agent does not go on
        // to tell the customer about a button that is not there.
        let parsed: URL | null = null
        try {
          parsed = rawUrl ? new URL(rawUrl) : null
        } catch {
          parsed = null
        }
        if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
          setPrompt(null)
          return 'No payment link was shown: payment_link_url was missing or not a usable web address. Do not tell the customer that anything is on screen.'
        }

        // The simulated guard, belt and braces.
        //
        // When the backend has no live Razorpay credentials it mints a placeholder link
        // on a `.invalid` host — a TLD reserved by RFC 2606 precisely so it can never
        // resolve. Such a link cannot be paid, so presenting it as a payment button
        // would be a lie told to a customer about money: they would tap it, get a
        // browser error, and reasonably believe our payment system is broken.
        //
        // We therefore treat a link as simulated if EITHER the agent flagged it OR the
        // host is unreachable by construction. Two independent checks because the flag
        // is model-produced and therefore fallible: if the agent drops `simulated` or
        // passes it as false, the host test still catches it. The converse also holds —
        // a link flagged simulated on a real-looking host stays inert, because a claimed
        // simulation is not something to overrule on the customer's behalf.
        const flaggedSimulated = params.simulated === true
        const unreachableHost = parsed.hostname.toLowerCase().endsWith('.invalid')
        const simulated = flaggedSimulated || unreachableHost

        const amountText = formatAmount(params.amount, params.currency)
        const purposeText = describePurpose(params.purpose, params.reference)
        const summary = [amountText, purposeText].filter(Boolean).join(' ')

        setPrompt({
          url: parsed.toString(),
          hostname: parsed.hostname,
          amountText,
          purposeText,
          simulated,
        })

        // This string is sent straight back to the model as the tool result, so it has
        // to be both short and true — it is what the agent will paraphrase out loud.
        if (simulated) {
          return `Shown on screen as a SIMULATED link${summary ? ` (${summary})` : ''}. It is labelled as unpayable and there is no clickable button. Read the amount aloud and say plainly that this is a demo link that cannot be paid.`
        }
        return `The payment button is on screen${summary ? `: ${summary}` : ''}. Tell the customer they can tap it, and read the amount aloud as well.`
      }

      // Merge rather than assign: if anything else ever registers a client tool on this
      // config, clobbering the whole map would disable it without a trace.
      config.clientTools = { ...config.clientTools, show_payment_link: showPaymentLink }
    }

    window.addEventListener('elevenlabs-convai:call', handleCall)
    return () => window.removeEventListener('elevenlabs-convai:call', handleCall)
  }, [])

  if (!agentId) {
    return (
      <div className="fixed bottom-6 right-6 p-3 bg-yellow-50 border border-yellow-200 rounded-lg max-w-xs z-50">
        <p className="text-xs text-yellow-800 font-medium">Voice widget disabled</p>
        <p className="text-xs text-yellow-700 mt-1">
          Set <code className="font-mono">VITE_ELEVENLABS_AGENT_ID</code> in your frontend
          environment to enable browser calling.
        </p>
      </div>
    )
  }

  return (
    <>
      {prompt && <PaymentPromptCard prompt={prompt} />}
      {createElement('elevenlabs-convai', { 'agent-id': agentId })}
    </>
  )
}

/**
 * Sits directly above the widget bubble. The embed's own host element is `z-index:1000`,
 * so the Tailwind `z-50` used elsewhere in this file would put the card behind an
 * expanded widget panel; `z-[1001]` keeps it visible next to the conversation.
 */
function PaymentPromptCard({ prompt }: { prompt: PaymentPrompt }) {
  const { url, hostname, amountText, purposeText, simulated } = prompt

  if (simulated) {
    // Deliberately not an anchor and not button-shaped. The whole point of this branch
    // is that there is nothing here to act on, and anything that looks tappable would
    // undo that. The amount still shows, because the agent is reading it out loud and
    // the customer should be able to check the figure against what they hear.
    return (
      <div className="fixed bottom-28 right-6 z-[1001] w-72 rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-lg">
        <div className="flex items-center gap-2 text-amber-800">
          <FlaskConical className="w-4 h-4 shrink-0" />
          <p className="text-xs font-semibold uppercase tracking-wide">Simulated payment</p>
        </div>
        <p className="mt-2 text-sm font-medium text-amber-900">
          {amountText ? `${amountText} ${purposeText}`.trim() : purposeText || 'Payment requested'}
        </p>
        <p className="mt-2 text-xs text-amber-800">
          This is a simulated link and cannot be paid. No money will be collected and no
          payment page will open.
        </p>
        <p className="mt-2 font-mono text-[11px] break-all text-amber-700/80">{hostname}</p>
      </div>
    )
  }

  const label = amountText
    ? `Pay ${amountText} ${purposeText}`.trim()
    : `Open payment page ${purposeText}`.trim()

  return (
    <div className="fixed bottom-28 right-6 z-[1001] w-72 rounded-lg border border-gray-200 bg-white p-4 shadow-lg">
      <div className="flex items-center gap-2 text-gray-500">
        <CreditCard className="w-4 h-4 shrink-0" />
        <p className="text-xs font-semibold uppercase tracking-wide">Payment ready</p>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700"
      >
        {label}
        <ExternalLink className="w-4 h-4 shrink-0" />
      </a>
      <p className="mt-2 font-mono text-[11px] break-all text-gray-400">{hostname}</p>
    </div>
  )
}
