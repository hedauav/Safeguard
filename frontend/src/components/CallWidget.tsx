import { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { CreditCard, ExternalLink, FlaskConical, Upload } from 'lucide-react'

/**
 * Why *client* tools and not the server tools' return values.
 *
 * The agent's `offer_renewal` / `collect_deductible` / `attach_document` tools run on
 * our backend and return a URL to the model. That URL never reaches this browser: the
 * only tool event the widget forwards to the page is `AgentToolResponse`, and its
 * payload is metadata only — `{tool_name, tool_call_id, tool_type, is_error, is_called,
 * event_id}`. There is no result field to read. So the model has to hand the link
 * back to us deliberately, which is what the `show_payment_link` and `show_upload_link`
 * *client* tools in the ElevenLabs workspace are for: the agent calls one after the
 * corresponding server tool succeeds, and the SDK invokes the function we register
 * below, in this tab, with the arguments.
 *
 * Getting our functions into the SDK is the other half. We do not construct the
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
 * goes silently inert: the agent would call the tool, the SDK would find no handler,
 * and no card would appear. That fails closed — no wrong link is shown — but it is
 * worth re-checking the bundle whenever the widget is upgraded.
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

interface UploadPrompt {
  url: string
  hostname: string
  /** e.g. "your repair estimate and photos for CLM-2026-000123". Never empty. */
  requestText: string
  /** e.g. "PDF, JPG or PNG". Empty when the agent sent no usable types. */
  acceptedText: string
  /** e.g. "10 MB". Empty when the agent sent no usable limit. */
  sizeText: string
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

/** First of `keys` present on `params` as a non-empty trimmed string, else ''. */
function firstString(params: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * The agent's tool schema only has string, number and boolean, so a list of document
 * types arrives as prose — "repair_estimate, photos" — and occasionally as a JSON array
 * a model decided to send anyway. Accept all three shapes rather than showing the
 * customer a raw `["photos"]`.
 */
function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []

  const raw = value.trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return toStringList(parsed)
    } catch {
      // Fall through to the plain split; a half-written array is still readable prose.
    }
  }
  return raw
    .split(/[,;]| and /i)
    .map((item) => item.replace(/^["'\[\s]+|["'\]\s]+$/g, '').trim())
    .filter(Boolean)
}

/** "a, b and c" — spoken order, so the card reads the way the agent says it. */
function joinWords(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * "repair_estimate" is a column name, not something to put in front of a customer.
 * The backend humanises the same list for the spoken message; we match it here so the
 * screen and the voice say the same words.
 */
function humanizeDocument(doc: string): string {
  return doc.replace(/[_-]+/g, ' ').trim().toLowerCase()
}

/**
 * What to upload, and for which claim. A bare URL tells a caller nothing about what we
 * are still waiting on, and "we need documents" tells them nothing about which ones —
 * so both halves are built here and neither is invented. With no document list the
 * phrase degrades to "your documents", which is vague but true.
 */
function describeUploadRequest(documents: string[], claimNumber: string): string {
  const named = joinWords(documents.map(humanizeDocument))
  const what = named ? `your ${named}` : 'your documents'
  return claimNumber ? `${what} for ${claimNumber}` : what
}

/**
 * MIME types are what the server enforces and gibberish to everybody else. Show the
 * extension a caller would recognise, and fall back to the subtype rather than dropping
 * a type we do not have a name for — an unlisted accepted type reads as a rejection.
 */
const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/jpg': 'JPG',
  'image/png': 'PNG',
  'image/heic': 'HEIC',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
}

function describeAcceptedTypes(value: unknown): string {
  const labels = toStringList(value)
    .map((mime) => {
      const key = mime.toLowerCase()
      return MIME_LABELS[key] ?? (key.split('/')[1] ?? key).toUpperCase()
    })
    .filter(Boolean)

  const unique = [...new Set(labels)]
  if (unique.length === 0) return ''
  if (unique.length === 1) return unique[0]
  return `${unique.slice(0, -1).join(', ')} or ${unique[unique.length - 1]}`
}

/**
 * A byte count on screen is a byte count nobody reads. Rounded up is the wrong
 * direction — it would advertise a limit the server rejects — so this rounds down to
 * one decimal and keeps whole numbers whole.
 */
function describeSizeLimit(value: unknown): string {
  const bytes = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isFinite(bytes) || bytes <= 0) return ''

  const mb = bytes / (1024 * 1024)
  if (mb >= 1) {
    const rounded = Math.floor(mb * 10) / 10
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} MB`
  }
  return `${Math.max(1, Math.floor(bytes / 1024))} KB`
}

/**
 * Parse a URL the model handed us, or null. Never invent a destination: a missing or
 * garbled link renders nothing at all, and the tool's return value says so, so the
 * agent does not go on to describe a button that is not there.
 */
function parseWebUrl(raw: string): URL | null {
  let parsed: URL | null = null
  try {
    parsed = raw ? new URL(raw) : null
  } catch {
    return null
  }
  if (!parsed) return null
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return parsed
}

/**
 * Mounts the ElevenLabs browser voice widget, plus the cards the agent drives through
 * the `show_payment_link` and `show_upload_link` client tools.
 *
 * The agent id must come from configuration: a hardcoded fallback silently
 * points the widget at someone else's agent when the env var is missing,
 * which looks like it works but talks to the wrong backend.
 */
export function CallWidget() {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID

  // Two independent slots, not one "current card" slot.
  //
  // A single caller is quite normally asked for both — the excess on a claim and the
  // photos that claim is still missing — and the two are answers to different
  // questions. If mentioning a document replaced the payment card, a live link to a
  // real charge would disappear mid-sentence while the agent was still saying "you can
  // tap it", and the caller would be looking at the wrong thing while being told to
  // look at the right one. So they stack: each tool owns its own slot and clears only
  // its own. Within a slot the newer call replaces the older, because a second payment
  // link supersedes the first rather than joining it.
  const [payment, setPayment] = useState<PaymentPrompt | null>(null)
  const [upload, setUpload] = useState<UploadPrompt | null>(null)

  useEffect(() => {
    const handleCall = (event: Event) => {
      const config = (event as CustomEvent<ConvaiCallEventDetail>).detail?.config
      if (!config) return

      // A new conversation is starting. Anything left over from the last one is about
      // a policy or a claim this caller may not even hold, and a stale card is worse
      // than none: a payment button is a live link to a real charge and an upload
      // button sends somebody's documents onto a stranger's claim.
      setPayment(null)
      setUpload(null)

      const showPaymentLink: ClientToolHandler = (parameters) => {
        const params = parameters ?? {}
        const parsed = parseWebUrl(typeof params.payment_link_url === 'string' ? params.payment_link_url.trim() : '')

        if (!parsed) {
          setPayment(null)
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
        //
        // None of this applies to the upload link below: that one points at our own
        // API, has no simulated variant, and there is nothing to be defrauded of by
        // being shown where to send a photograph.
        const flaggedSimulated = params.simulated === true
        const unreachableHost = parsed.hostname.toLowerCase().endsWith('.invalid')
        const simulated = flaggedSimulated || unreachableHost

        const amountText = formatAmount(params.amount, params.currency)
        const purposeText = describePurpose(params.purpose, params.reference)
        const summary = [amountText, purposeText].filter(Boolean).join(' ')

        setPayment({
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

      const showUploadLink: ClientToolHandler = (parameters) => {
        const params = parameters ?? {}
        // The declared schema is `upload_url`, `claim_number`, `documents_missing`,
        // `max_bytes`, `accepted_mime_types` — the names attach_document returns, which
        // is what the prompt tells the agent to pass through unchanged. The extra keys
        // read below are fallbacks for the near-misses a model reaches for when it
        // paraphrases its own schema (`claim_id`, `documents_outstanding`). Reading one
        // more key is free; showing nothing because the argument arrived under a
        // synonym is a caller left writing a URL down off a phone call.
        const parsed = parseWebUrl(firstString(params, ['upload_url', 'upload_link_url', 'url']))

        if (!parsed) {
          setUpload(null)
          return 'No upload link was shown: upload_url was missing or not a usable web address. Do not tell the customer that anything is on screen — read the address out instead.'
        }

        const claimNumber = firstString(params, ['claim_number', 'claim_id', 'reference'])
        const documents = toStringList(
          params.documents_missing ??
            params.documents_outstanding ??
            params.document_types ??
            params.documents_needed ??
            params.documents,
        )

        const requestText = describeUploadRequest(documents, claimNumber)

        setUpload({
          url: parsed.toString(),
          hostname: parsed.hostname,
          requestText,
          acceptedText: describeAcceptedTypes(params.accepted_mime_types ?? params.accepted_types),
          sizeText: describeSizeLimit(params.max_bytes ?? params.max_size_bytes),
        })

        return `The upload button is on screen: ${requestText}. Tell the customer they can tap it to send the files, and offer to read the address out in case they cannot see it.`
      }

      // Merge rather than assign: if anything else ever registers a client tool on this
      // config, clobbering the whole map would disable it without a trace.
      config.clientTools = {
        ...config.clientTools,
        show_payment_link: showPaymentLink,
        show_upload_link: showUploadLink,
      }
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
      {(payment || upload) && (
        <PromptStack>
          {payment && <PaymentPromptCard prompt={payment} />}
          {upload && <UploadPromptCard prompt={upload} />}
        </PromptStack>
      )}
      {createElement('elevenlabs-convai', { 'agent-id': agentId })}
    </>
  )
}

/**
 * Sits directly above the widget bubble and holds however many cards are live.
 *
 * The embed's own host element is `z-index:1000`, so the Tailwind `z-50` used elsewhere
 * in this file would put the stack behind an expanded widget panel; `z-[1001]` keeps it
 * visible next to the conversation. It scrolls internally rather than growing off the
 * top of a short viewport, since a card that has escaped the screen is a card the
 * agent is talking about and the caller cannot see.
 */
function PromptStack({ children }: { children: ReactNode }) {
  return (
    <div className="fixed bottom-28 right-6 z-[1001] flex max-h-[calc(100vh-9rem)] w-72 flex-col gap-3 overflow-y-auto">
      {children}
    </div>
  )
}

type CardTone = 'neutral' | 'warning'

/** The shell every card shares: width, border, heading row. */
function PromptCard({
  tone = 'neutral',
  icon: Icon,
  heading,
  children,
}: {
  tone?: CardTone
  icon: ComponentType<{ className?: string }>
  heading: string
  children: ReactNode
}) {
  const shell = tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
  const head = tone === 'warning' ? 'text-amber-800' : 'text-gray-500'

  return (
    <div className={`shrink-0 rounded-lg border p-4 shadow-lg ${shell}`}>
      <div className={`flex items-center gap-2 ${head}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <p className="text-xs font-semibold uppercase tracking-wide">{heading}</p>
      </div>
      {children}
    </div>
  )
}

/** The one call to action a card is allowed. Always a new tab, never an opener. */
function CardAction({ url, label, className }: { url: string; label: string; className: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors ${className}`}
    >
      {label}
      <ExternalLink className="w-4 h-4 shrink-0" />
    </a>
  )
}

/** Where the button actually goes, so the caller can check it before tapping. */
function CardHost({ hostname, className }: { hostname: string; className?: string }) {
  return <p className={`mt-2 font-mono text-[11px] break-all ${className ?? 'text-gray-400'}`}>{hostname}</p>
}

function PaymentPromptCard({ prompt }: { prompt: PaymentPrompt }) {
  const { url, hostname, amountText, purposeText, simulated } = prompt

  if (simulated) {
    // Deliberately not an anchor and not button-shaped. The whole point of this branch
    // is that there is nothing here to act on, and anything that looks tappable would
    // undo that. The amount still shows, because the agent is reading it out loud and
    // the customer should be able to check the figure against what they hear.
    return (
      <PromptCard tone="warning" icon={FlaskConical} heading="Simulated payment">
        <p className="mt-2 text-sm font-medium text-amber-900">
          {amountText ? `${amountText} ${purposeText}`.trim() : purposeText || 'Payment requested'}
        </p>
        <p className="mt-2 text-xs text-amber-800">
          This is a simulated link and cannot be paid. No money will be collected and no
          payment page will open.
        </p>
        <CardHost hostname={hostname} className="text-amber-700/80" />
      </PromptCard>
    )
  }

  const label = amountText
    ? `Pay ${amountText} ${purposeText}`.trim()
    : `Open payment page ${purposeText}`.trim()

  return (
    <PromptCard icon={CreditCard} heading="Payment ready">
      <CardAction url={url} label={label} className="bg-green-600 hover:bg-green-700" />
      <CardHost hostname={hostname} />
    </PromptCard>
  )
}

/**
 * Blue rather than green, and its own heading, because the two cards can be on screen
 * together and a caller glancing at them needs to see at once which one takes money and
 * which one takes files.
 */
function UploadPromptCard({ prompt }: { prompt: UploadPrompt }) {
  const { url, hostname, requestText, acceptedText, sizeText } = prompt

  const limits = [acceptedText, sizeText && `up to ${sizeText} each`].filter(Boolean).join(' · ')

  return (
    <PromptCard icon={Upload} heading="Documents needed">
      <p className="mt-2 text-sm font-medium text-gray-900">Upload {requestText}</p>
      <CardAction url={url} label="Upload documents" className="bg-blue-600 hover:bg-blue-700" />
      {/* Stated up front because the alternative is finding out at the far end of a
          slow upload from a phone that the file was never going to be accepted. */}
      {limits && <p className="mt-2 text-xs text-gray-500">{limits}</p>}
      <CardHost hostname={hostname} />
    </PromptCard>
  )
}
