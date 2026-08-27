import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FlaskConical,
  Loader2,
  Paperclip,
  Upload,
  X,
} from 'lucide-react'

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
  /**
   * Bumped on every `show_upload_link` call so the card remounts and drops any
   * upload state from the previous claim. A "sent successfully" line left over
   * from the last document, sitting under a picker now pointed at a different
   * claim, is a lie by omission.
   */
  key: number
  /** POST target. Never rendered as an href — it is an API endpoint, not a page. */
  url: string
  hostname: string
  /** e.g. "your repair estimate and photos for CLM-2026-000123". Never empty. */
  requestText: string
  /** Raw `documents_missing` values, e.g. ["repair_estimate"]. The `document_type`
   *  field the endpoint requires must be one of these verbatim, so they are kept
   *  unhumanised here and only prettified at the point of display. */
  documents: string[]
  /** Raw MIME types for the picker's `accept`. Empty when the agent sent none. */
  acceptedMimes: string[]
  /** e.g. "PDF, JPG or PNG". Empty when the agent sent no usable types. */
  acceptedText: string
  /** The server's ceiling in bytes, or null when the agent did not pass one — in
   *  which case nothing is refused locally and the server has the only say. */
  maxBytes: number | null
  /** e.g. "10 MB". Empty when the agent sent no usable limit. */
  sizeText: string
}

/**
 * The parts of the upload response this card is willing to state out loud.
 *
 * Every field is nullable because the backend that fills them in is being
 * extended in parallel: `documents_missing`, `documents_complete`,
 * `claim_advanced` and `claim_status` may simply not be there yet, and a card
 * that renders "undefined documents outstanding" is worse than one that stays
 * quiet about what it was not told.
 */
interface UploadResult {
  /** The endpoint's own customer-facing sentence. */
  message: string
  documentsMissing: string[] | null
  documentsComplete: boolean | null
  claimAdvanced: boolean | null
  claimStatus: string | null
  warnings: string[]
}

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; filename: string }
  | { kind: 'done'; result: UploadResult }
  /**
   * `indeterminate` separates "the server answered and refused" from "we never
   * heard back". The first is safe to retry; the second is not, because the
   * request may have completed server-side and a second attempt would write a
   * second document and a second attestation.
   */
  | { kind: 'failed'; message: string; indeterminate: boolean }

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
    .map((item) => item.replace(/^["'[\s]+|["'\]\s]+$/g, '').trim())
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
 * screen and the voice say the same words. `under_review` — a claim status — gets the
 * same treatment for the same reason.
 */
function humanizeToken(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim().toLowerCase()
}

const humanizeDocument = humanizeToken

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

function describeAcceptedTypes(mimes: string[]): string {
  const labels = mimes
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
 * The size ceiling as a number we can actually compare a chosen file against, or null
 * when the agent passed nothing usable. Null matters: it is the difference between
 * "this file is too big" and "we were never told what too big means", and only the
 * first of those justifies refusing a file before it is sent.
 */
function toByteLimit(value: unknown): number | null {
  const bytes = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  return bytes
}

/**
 * A byte count on screen is a byte count nobody reads. Rounded up is the wrong
 * direction — it would advertise a limit the server rejects — so this rounds down to
 * one decimal and keeps whole numbers whole.
 */
function describeSizeLimit(value: number | null): string {
  if (value === null) return ''
  const bytes = value

  const mb = bytes / (1024 * 1024)
  if (mb >= 1) {
    const rounded = Math.floor(mb * 10) / 10
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} MB`
  }
  return `${Math.max(1, Math.floor(bytes / 1024))} KB`
}

/**
 * The multipart part names the upload endpoint reads.
 *
 * `POST /api/claims/:claimNumber/documents` walks the multipart parts itself: the first
 * part of type `file` is the document (its field name is not inspected, but the route's
 * own 415 message names it `file`, so that is what we send), and it looks for exactly
 * two value fields by name — `document_type`, which is required and must be one of the
 * types the claim still asks for, and `extracted_text`, which we do not have and do not
 * invent. Anything else is ignored. There is no auth guard on this route: unlike
 * `/tools/*` and the calls endpoints, it registers no `requireToolsToken` preHandler,
 * so no header is needed and none is sent.
 */
const FILE_FIELD = 'file'
const DOCUMENT_TYPE_FIELD = 'document_type'

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the upload response without trusting its shape.
 *
 * The fields describing where the claim now stands are being added to the route by
 * another change in flight, so each is taken only if it arrived with the type it is
 * supposed to have, and left null otherwise. A null here means "not told", and the card
 * says nothing rather than guessing — announcing "no documents outstanding" because a
 * field was absent would tell a caller their claim is complete when it is not.
 */
function parseUploadResult(payload: unknown): UploadResult {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return {
    message: asText(body.message),
    documentsMissing: asStringArray(body.documents_missing),
    documentsComplete: asBoolean(body.documents_complete),
    claimAdvanced: asBoolean(body.claim_advanced),
    claimStatus: asText(body.claim_status) || null,
    warnings: asStringArray(body.warnings) ?? [],
  }
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
 * The origin this app is allowed to send a claimant's document to.
 *
 * Derived from the API base the app was built against, so it cannot drift from
 * where the rest of the dashboard talks.
 */
function apiOrigin(): string | null {
  try {
    const base = import.meta.env.VITE_API_URL
    return base ? new URL(base).origin : null
  } catch {
    return null
  }
}

/**
 * An upload destination, or null.
 *
 * `upload_url` reaches us through the model, and the backend builds it from the
 * request's own Host header (`webhook-tools.ts`). Neither is trustworthy: a
 * poisoned header on the tool call, or a model that simply emits a different
 * string, would otherwise have this component POST a policyholder's document to
 * somebody else's server — and the agent would read that address out loud while
 * it happened.
 *
 * So the URL is checked against the origin this app was built to talk to, not
 * merely for being a URL. A mismatch renders nothing, which is the safe
 * failure: the caller is told the picker is unavailable rather than quietly
 * sending their file somewhere we cannot vouch for.
 */
function parseUploadUrl(raw: string): URL | null {
  const parsed = parseWebUrl(raw)
  if (!parsed) return null

  const allowed = apiOrigin()
  // No configured API origin means we cannot vouch for any destination, so we
  // refuse every one of them rather than fall back to trusting the input.
  if (!allowed || parsed.origin !== allowed) return null

  return parsed
}

/**
 * Monotonic, module-scoped so it survives the component's own re-renders and is not
 * reset by a remount. Its only job is to be different every time.
 */
let uploadSequence = 0

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
        // Origin-checked, not merely parsed. This component is about to send a
        // policyholder's document to whatever address comes back here, and that
        // address travels through the model from a URL the backend built out of
        // its own Host header. Neither link in that chain is trustworthy enough
        // to hand somebody's file to.
        const parsed = parseUploadUrl(firstString(params, ['upload_url', 'upload_link_url', 'url']))

        if (!parsed) {
          setUpload(null)
          // Deliberately not "read the address out": that address is a POST endpoint,
          // so a caller who types it into a browser gets nothing. There is no fallback
          // to offer here, and inventing one wastes the caller's time.
          return 'No upload picker was shown: upload_url was missing, not a usable web address, or did not point at this service. Do not tell the customer that anything is on screen, and do not read the address out — it is an API endpoint, not a page they can open. Say the upload could not be set up and offer to try again.'
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
        const acceptedMimes = toStringList(params.accepted_mime_types ?? params.accepted_types)
        const maxBytes = toByteLimit(params.max_bytes ?? params.max_size_bytes)

        uploadSequence += 1
        setUpload({
          key: uploadSequence,
          url: parsed.toString(),
          hostname: parsed.hostname,
          requestText,
          documents,
          acceptedMimes,
          acceptedText: describeAcceptedTypes(acceptedMimes),
          maxBytes,
          sizeText: describeSizeLimit(maxBytes),
        })

        // The card carries a file picker, not a link, so this says so: the agent used
        // to promise a tappable address that turned out to be a POST endpoint, and a
        // caller told to "open the link" on a card that has no link is stuck.
        return `A file picker is on screen for ${requestText}. Tell the customer to choose the file on the card and it will be sent from this page — there is no link to open and nothing to type. Warn them it takes a few seconds while we fingerprint and record the file, and ask them to wait rather than send it twice.`
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
          {payment && <PaymentPromptCard prompt={payment} onDismiss={() => setPayment(null)} />}
          {upload && (
            <UploadPromptCard key={upload.key} prompt={upload} onDismiss={() => setUpload(null)} />
          )}
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

/**
 * How a card is closed.
 *
 * Every card gets one. Before this, a card stayed up until the page was reloaded, so a
 * caller who had paid — or finished sending documents — sat under a card about work
 * already done, and across a long call several of them piled up until none of them meant
 * anything.
 *
 * `blockedReason`, when set, is the case where closing would strand something rather
 * than merely hide it. The control stays and stays focusable; it just refuses and says
 * why.
 */
interface CardDismiss {
  onDismiss: () => void
  /** Names the card being closed, not just "close" — two can be on screen at once. */
  label: string
  /** Set only while dismissal would lose something the caller still needs. */
  blockedReason?: string
}

/**
 * The close control, in the heading row so it is in the same place on every card.
 *
 * It is a real `<button>` with a label rather than a bare icon `<div>`: the stack sits
 * over the ElevenLabs widget and this is the only way out of it, so it has to be
 * reachable by keyboard and announced by a screen reader. Nothing in a card is
 * positioned or raised above the heading row, so nothing can cover it.
 */
function CardDismissButton({ tone, dismiss }: { tone: CardTone; dismiss: CardDismiss }) {
  const blocked = Boolean(dismiss.blockedReason)
  const colours =
    tone === 'warning'
      ? 'text-amber-700 hover:bg-amber-100 hover:text-amber-900 focus-visible:ring-amber-500'
      : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-gray-500'

  return (
    <button
      type="button"
      // `aria-disabled`, not `disabled`. A disabled button drops out of the tab order
      // entirely, so the one person who most needs the reason the card will not close —
      // the one arriving by keyboard or screen reader — would be the one who never hears
      // it. This one still takes focus and still reads its label; the handler is what
      // refuses.
      aria-disabled={blocked}
      aria-label={dismiss.blockedReason ?? dismiss.label}
      title={dismiss.blockedReason ?? dismiss.label}
      onClick={() => {
        if (!blocked) dismiss.onDismiss()
      }}
      className={`-mr-1.5 ml-auto shrink-0 rounded-md p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 ${
        blocked ? 'cursor-not-allowed opacity-40' : ''
      } ${colours}`}
    >
      <X className="w-4 h-4" />
    </button>
  )
}

/** The shell every card shares: width, border, heading row, close control. */
function PromptCard({
  tone = 'neutral',
  icon: Icon,
  heading,
  dismiss,
  children,
}: {
  tone?: CardTone
  icon: ComponentType<{ className?: string }>
  heading: string
  dismiss: CardDismiss
  children: ReactNode
}) {
  const shell = tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
  const head = tone === 'warning' ? 'text-amber-800' : 'text-gray-500'

  return (
    <div className={`shrink-0 rounded-lg border p-4 shadow-lg ${shell}`}>
      <div className={`flex items-center gap-2 ${head}`}>
        <Icon className="w-4 h-4 shrink-0" />
        <p className="text-xs font-semibold uppercase tracking-wide">{heading}</p>
        <CardDismissButton tone={tone} dismiss={dismiss} />
      </div>
      {children}
    </div>
  )
}

const ACTION_CLASSES =
  'mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-70'

/**
 * The one call to action a card is allowed, in the two forms a card can need.
 *
 * A `url` gives the link form — always a new tab, never an opener — and is only correct
 * when the destination is a page a person can actually open. The upload endpoint is a
 * POST route, so that card takes the `onClick` form instead: rendering it as an anchor
 * is precisely the bug this replaced, a blue button that issued a GET and did nothing.
 */
type CardActionProps =
  | { url: string; label: string; className: string }
  | {
      onClick: () => void
      label: string
      className: string
      icon: ComponentType<{ className?: string }>
      disabled?: boolean
    }

function CardAction(props: CardActionProps) {
  if ('url' in props) {
    return (
      <a
        href={props.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${ACTION_CLASSES} ${props.className}`}
      >
        {props.label}
        <ExternalLink className="w-4 h-4 shrink-0" />
      </a>
    )
  }

  const { onClick, label, className, icon: Icon, disabled } = props
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${ACTION_CLASSES} ${className}`}>
      {label}
      <Icon className="w-4 h-4 shrink-0" />
    </button>
  )
}

/** Where the button actually goes, so the caller can check it before tapping. */
function CardHost({ hostname, className }: { hostname: string; className?: string }) {
  return <p className={`mt-2 font-mono text-[11px] break-all ${className ?? 'text-gray-400'}`}>{hostname}</p>
}

/**
 * Dismissal here is manual and only manual.
 *
 * The capture arrives at our backend as a Razorpay webhook; it never reaches this tab.
 * So this card cannot know whether the caller paid, and it must not pretend to: an
 * "I've paid" control, or a card that closed itself after a plausible interval, would be
 * this browser asserting something about money that it has no way to observe. The caller
 * closes it when they are done with it, and nothing about closing it is a claim either
 * way.
 */
function PaymentPromptCard({ prompt, onDismiss }: { prompt: PaymentPrompt; onDismiss: () => void }) {
  const { url, hostname, amountText, purposeText, simulated } = prompt

  if (simulated) {
    // Deliberately not an anchor and not button-shaped. The whole point of this branch
    // is that there is nothing here to act on, and anything that looks tappable would
    // undo that. The amount still shows, because the agent is reading it out loud and
    // the customer should be able to check the figure against what they hear.
    return (
      <PromptCard
        tone="warning"
        icon={FlaskConical}
        heading="Simulated payment"
        dismiss={{ onDismiss, label: 'Dismiss the simulated payment card' }}
      >
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
    <PromptCard
      icon={CreditCard}
      heading="Payment ready"
      dismiss={{ onDismiss, label: 'Dismiss the payment card' }}
    >
      <CardAction url={url} label={label} className="bg-green-600 hover:bg-green-700" />
      {/* Said out loud because the close control is new and its meaning is not obvious:
          a caller who has just paid needs to know that tidying the card away neither
          confirms nor cancels the charge. The payment page opens in its own tab, so
          closing this one cannot interrupt anything either. */}
      <p className="mt-2 text-xs text-gray-500">
        Closing this card only hides the link — it does not pay or cancel anything.
      </p>
      <CardHost hostname={hostname} />
    </PromptCard>
  )
}

/** Loader2 with the spin applied, so it can be handed to `CardAction` as an icon. */
function Spinner({ className }: { className?: string }) {
  return <Loader2 className={`${className ?? ''} animate-spin`} />
}

/**
 * Blue rather than green, and its own heading, because the two cards can be on screen
 * together and a caller glancing at them needs to see at once which one takes money and
 * which one takes files.
 *
 * The file picker lives here rather than behind a link on purpose. The upload target is
 * `POST /api/claims/:number/documents`; as an anchor it was a GET at a POST-only route,
 * so the blue button a caller was told to tap did nothing at all, and there is no upload
 * page anywhere in this application to send them to instead. Doing it in the card also
 * keeps them on the call, which is the only place anyone is telling them what to send.
 *
 * On dismissal: unlike the payment card this one does know its own lifecycle — it sees
 * the response, whether the send succeeded, and whether documents remain outstanding. It
 * still does not close itself. What the server says back is the only place a caller is
 * told the file was recorded, what is still outstanding, whether the claim moved, and
 * any warning about a file recorded but not archived; a card that disappeared on
 * completion would take all of that with it, usually mid-sentence, and the caller would
 * have no way to get it back. So completion holds a success state and the card becomes
 * closable — with an explicit "Close this card" under the outcome once the set is
 * complete, so a finished caller is offered the exit rather than left hunting the corner
 * for it.
 */
function UploadPromptCard({ prompt, onDismiss }: { prompt: UploadPrompt; onDismiss: () => void }) {
  const { url, hostname, requestText, documents, acceptedMimes, acceptedText, maxBytes, sizeText } = prompt

  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * The no-double-write latch. Set before the request leaves and cleared only once an
   * answer has come back, so a second `change` event — a double tap, a caller picking
   * again while the first upload is still running — is dropped rather than queued.
   * A ref and not state because it has to be correct immediately, not at the next
   * render: every duplicate this stops is a duplicate document row and a duplicate
   * Base Sepolia attestation for the same file.
   */
  const inFlight = useRef(false)
  const [state, setState] = useState<UploadState>({ kind: 'idle' })
  const [documentType, setDocumentType] = useState(documents[0] ?? '')

  const busy = state.kind === 'uploading'
  // A type the claim named goes up verbatim, because the server matches it against
  // `documents_required` exactly. Only a hand-typed one is normalised, and even then
  // only in shape — no word is substituted for another.
  const chosenType = documents.includes(documentType)
    ? documentType
    : documentType.trim().replace(/\s+/g, '_').toLowerCase()

  const limits = [acceptedText, sizeText && `up to ${sizeText} each`].filter(Boolean).join(' · ')

  async function send(file: File) {
    // Checked here only when the agent actually told us the ceiling. Without one we say
    // nothing and let the server decide: refusing a file against a limit we invented
    // would block an upload that would have been accepted.
    if (maxBytes !== null && file.size > maxBytes) {
      setState({
        kind: 'failed',
        indeterminate: false,
        message: `That file is ${describeSizeLimit(file.size)} and the limit is ${sizeText}. Nothing was sent — please choose a smaller copy.`,
      })
      return
    }

    inFlight.current = true
    setState({ kind: 'uploading', filename: file.name })

    const body = new FormData()
    body.append(FILE_FIELD, file, file.name)
    body.append(DOCUMENT_TYPE_FIELD, chosenType)

    let response: Response
    try {
      // No timeout and no retry, deliberately. This request waits on a Filecoin upload
      // and a Base Sepolia receipt, so slow is the normal case, and there is no way from
      // here to tell a request that is still working from one that is lost. Abandoning
      // it and sending again would archive the file twice and attest it twice.
      response = await fetch(url, { method: 'POST', body })
    } catch {
      inFlight.current = false
      setState({
        kind: 'failed',
        indeterminate: true,
        message:
          'The connection dropped before the server answered, so we cannot tell whether the file was recorded. Please tell the agent rather than sending it again straight away — a second send would file a second copy.',
      })
      return
    }

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // A body we cannot read does not change what the status code already said.
      payload = null
    }

    inFlight.current = false
    const parsed = parseUploadResult(payload)

    if (!response.ok) {
      // The server answered, so we know this one was refused and nothing was written —
      // which is exactly why the picker is left usable below.
      setState({
        kind: 'failed',
        indeterminate: false,
        message: parsed.message || `The upload was refused (HTTP ${response.status}) and nothing was recorded.`,
      })
      return
    }

    setState({ kind: 'done', result: parsed })
  }

  function handleFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0] ?? null
    // Cleared straight away so re-picking the same file still raises a change event —
    // after a refusal the caller may well choose the very same file again.
    input.value = ''
    if (!file || inFlight.current) return
    void send(file)
  }

  return (
    <PromptCard
      icon={Upload}
      heading="Documents needed"
      // Refused while a file is on its way. Unmounting the card mid-request would leave
      // an orphaned fetch whose answer nobody sees: the caller would never learn whether
      // the document landed, and the safe assumption — send it again — is the one that
      // files a second copy and a second attestation. `busy` is the rendered face of the
      // `inFlight` latch below; both are set for exactly the same window.
      dismiss={{
        onDismiss,
        label: 'Dismiss the document upload card',
        blockedReason: busy
          ? 'Cannot close yet — your file is still being sent. This card will be closable as soon as the server answers.'
          : undefined,
      }}
    >
      <p className="mt-2 text-sm font-medium text-gray-900">Upload {requestText}</p>

      {/* One outstanding type needs no question asked; several do, because the server
          files the bytes under whichever type we name and nobody else can tell which. */}
      {documents.length > 1 && (
        <label className="mt-2 block">
          <span className="text-xs text-gray-500">Which document is this?</span>
          <select
            value={documentType}
            disabled={busy}
            onChange={(event) => setDocumentType(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-60"
          >
            {documents.map((doc) => (
              <option key={doc} value={doc}>
                {humanizeDocument(doc)}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* The agent sent no list, so we have nothing to offer and will not guess one:
          the type is required and the server checks it against what the claim asks for. */}
      {documents.length === 0 && (
        <label className="mt-2 block">
          <span className="text-xs text-gray-500">Which document is this?</span>
          <input
            type="text"
            value={documentType}
            disabled={busy}
            placeholder="e.g. repair estimate"
            onChange={(event) => setDocumentType(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-60"
          />
        </label>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        // Only when the agent passed types. An empty `accept` would grey out every file
        // in the picker and look like a broken dialog.
        accept={acceptedMimes.length > 0 ? acceptedMimes.join(',') : undefined}
        onChange={handleFileChosen}
      />

      <CardAction
        onClick={() => inputRef.current?.click()}
        disabled={busy || !chosenType}
        icon={busy ? Spinner : Paperclip}
        label={busy ? 'Sending…' : state.kind === 'done' ? 'Send another file' : 'Choose a file to send'}
        className="bg-blue-600 hover:bg-blue-700"
      />

      {state.kind === 'uploading' && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-blue-50 p-2">
          <Loader2 className="mt-0.5 w-3.5 h-3.5 shrink-0 animate-spin text-blue-600" />
          <p className="text-xs text-blue-800">
            Uploading and recording evidence, this can take a moment. We archive{' '}
            <span className="font-medium break-all">{state.filename}</span> and write its
            fingerprint to the chain before answering, so a long wait here is normal and not a
            failure. Please keep this page open and do not send it again. This card stays put
            until there is an answer, then you can close it.
          </p>
        </div>
      )}

      {state.kind === 'done' && <UploadOutcome result={state.result} onDismiss={onDismiss} />}

      {state.kind === 'failed' && (
        <div
          className={`mt-2 flex items-start gap-2 rounded-md p-2 ${
            state.indeterminate ? 'bg-amber-50' : 'bg-red-50'
          }`}
        >
          <AlertTriangle
            className={`mt-0.5 w-3.5 h-3.5 shrink-0 ${state.indeterminate ? 'text-amber-600' : 'text-red-600'}`}
          />
          <p className={`text-xs ${state.indeterminate ? 'text-amber-900' : 'text-red-900'}`}>
            {state.message}
          </p>
        </div>
      )}

      {/* Stated up front because the alternative is finding out at the far end of a
          slow upload from a phone that the file was never going to be accepted. */}
      {limits && <p className="mt-2 text-xs text-gray-500">{limits}</p>}
      <CardHost hostname={hostname} />
    </PromptCard>
  )
}

/**
 * What the server said after it took the file.
 *
 * Each line is drawn from a field that may not exist yet, so each is guarded on its own
 * rather than on the presence of the response as a whole. Silence is the fallback
 * everywhere: telling a caller their claim is complete because a field was missing is
 * the one outcome worse than telling them nothing.
 *
 * The same guardedness governs the closing offer at the foot: it appears only on a
 * positive signal that the set is complete, never on the absence of one. When we were
 * not told, the card simply stays and the corner control is still there.
 */
function UploadOutcome({ result, onDismiss }: { result: UploadResult; onDismiss: () => void }) {
  const { message, documentsMissing, documentsComplete, claimAdvanced, claimStatus, warnings } = result

  const stillMissing =
    documentsMissing && documentsMissing.length > 0 ? joinWords(documentsMissing.map(humanizeDocument)) : ''
  // Either signal is enough on its own, and they agree when both are present.
  const complete = documentsComplete === true || (documentsMissing !== null && documentsMissing.length === 0)

  return (
    <div className="mt-2 rounded-md bg-green-50 p-2">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 w-3.5 h-3.5 shrink-0 text-green-600" />
        <p className="text-xs font-medium text-green-900">
          {message || 'That file was received and recorded.'}
        </p>
      </div>

      {stillMissing ? (
        <p className="mt-1.5 text-xs text-green-800">Still outstanding: {stillMissing}.</p>
      ) : complete ? (
        <p className="mt-1.5 text-xs text-green-800">
          That is everything this claim was waiting for.
        </p>
      ) : null}

      {claimAdvanced === true && (
        <p className="mt-1.5 text-xs text-green-800">
          This is what moved your claim on
          {claimStatus ? ` — it is now ${humanizeToken(claimStatus)}` : ''}.
        </p>
      )}
      {claimAdvanced === false && claimStatus && (
        <p className="mt-1.5 text-xs text-green-800">The claim is still {humanizeToken(claimStatus)}.</p>
      )}

      {/* Surfaced, not swallowed: these are how the server admits a file was recorded
          but not archived, or recorded but the claim did not move. */}
      {warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="text-[11px] text-amber-700">
              {warning}
            </li>
          ))}
        </ul>
      )}

      {/* The card has genuinely finished: the claim asked for a set of documents and the
          server says the set is complete. That is the moment to offer the way out — but
          offer it, not take it. The lines above are the only account the caller gets of
          what was recorded and where the claim now stands, and a card that closed itself
          would pull them away mid-read. So it waits to be closed, and the caller who has
          finished reading is not left looking for the corner. */}
      {!stillMissing && complete && (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 w-full rounded-md border border-green-200 bg-white px-3 py-1.5 text-xs font-medium text-green-800 transition-colors hover:bg-green-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
        >
          Close this card
        </button>
      )}
    </div>
  )
}
