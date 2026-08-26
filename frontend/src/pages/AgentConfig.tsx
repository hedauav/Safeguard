import { useEffect, useState } from 'react'
import {
  Volume2, Wrench, MessageSquare, Shield, Check, X,
  Save, RotateCcw, UploadCloud, KeyRound, AlertTriangle,
} from 'lucide-react'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { ErrorState } from '../components/ErrorState'
import {
  getAgentConfig, updateAgentConfig, resetAgentConfig, syncAgentConfig,
  getAdminToken, setAdminToken,
} from '../lib/api'
import type { AgentConfigData } from '../types'

type Banner = { kind: 'ok' | 'err'; text: string } | null

function FeatureRow({ label, enabled, hint }: { label: string; enabled: boolean; hint?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {enabled
        ? <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        : <X className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />}
      <span className={enabled ? 'text-gray-700' : 'text-gray-400'}>
        {label}
        {!enabled && hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
    </li>
  )
}

export function AgentConfig() {
  const [config, setConfig] = useState<AgentConfigData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [banner, setBanner] = useState<Banner>(null)
  const [busy, setBusy] = useState<null | 'save' | 'sync' | 'reset'>(null)

  // Draft state — what the operator is editing before saving.
  const [prompt, setPrompt] = useState('')
  const [firstMessage, setFirstMessage] = useState('')
  const [agentName, setAgentName] = useState('')
  const [disabled, setDisabled] = useState<string[]>([])
  const [token, setToken] = useState(getAdminToken())

  const applyConfig = (data: AgentConfigData) => {
    setConfig(data)
    setPrompt(data.system_prompt)
    setFirstMessage(data.first_message)
    setAgentName(data.agent_name)
    setDisabled(data.disabled_tools)
  }

  const load = () => {
    setLoading(true)
    getAgentConfig()
      .then((res) => {
        if (res.data) applyConfig(res.data)
        else setError(res.error ?? 'Failed to load agent configuration')
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const dirty =
    !!config &&
    (prompt !== config.system_prompt ||
      firstMessage !== config.first_message ||
      agentName !== config.agent_name ||
      disabled.join() !== config.disabled_tools.join())

  /**
   * Turn a failure into something the operator can act on.
   *
   * The API answers with a real message on every path that matters — 401 for a
   * bad token, 502 carrying ElevenLabs' own words, 503 when ADMIN_TOKEN is
   * missing on the server — so prefer the server's text over anything generic.
   * A request that never got a response at all is its own case: axios reports
   * only "Network Error", which usually means CORS, not a broken server.
   */
  const describe = (err: unknown): string => {
    const anyErr = err as {
      isAxiosError?: boolean
      code?: string
      response?: { status?: number; data?: { error?: string } }
    }
    const fromServer = anyErr?.response?.data?.error
    const status = anyErr?.response?.status

    if (!anyErr?.response && (anyErr?.isAxiosError || anyErr?.code === 'ERR_NETWORK')) {
      return (
        'Could not reach the API — the request never got a response. ' +
        'If this page is running on a local dev server against the deployed API, ' +
        'the browser is blocking it with CORS; open the deployed frontend instead, ' +
        'or run the API locally.'
      )
    }
    if (status === 401) return fromServer ?? 'Invalid or missing admin token.'
    if (status === 403) return fromServer ?? 'Admin token rejected.'
    if (status === 502) return `ElevenLabs rejected the sync: ${fromServer ?? 'no detail returned.'}`
    if (status === 503) {
      return fromServer ?? 'Editing is disabled: ADMIN_TOKEN is not configured on the server.'
    }
    return fromServer ?? (err instanceof Error ? err.message : String(err))
  }

  /**
   * Run one write and report what actually happened. The action may return its
   * own message — the sync knows details the caller cannot — and `success` is
   * only the fallback for actions that have nothing extra to say.
   */
  const run = async (
    kind: 'save' | 'sync' | 'reset',
    action: () => Promise<string | void>,
    success: string
  ) => {
    setBusy(kind)
    setBanner(null)
    try {
      const detail = await action()
      setBanner({ kind: 'ok', text: detail || success })
    } catch (err) {
      setBanner({ kind: 'err', text: describe(err) })
    } finally {
      setBusy(null)
    }
  }

  const onSave = () =>
    run('save', async () => {
      const res = await updateAgentConfig({
        agent_name: agentName,
        first_message: firstMessage,
        system_prompt: prompt,
        disabled_tools: disabled,
      })
      if (!res.data) throw new Error(res.error ?? 'Save failed')
      load()
    }, 'Saved. Click "Sync to ElevenLabs" to push it to the live agent.')

  const onSync = () =>
    run('sync', async () => {
      const res = await syncAgentConfig()
      if (!res.data) throw new Error(res.error ?? 'Sync failed')
      const warnings = res.data.warnings ?? []
      load()
      const counts = `${res.data.toolsAttached} tool${res.data.toolsAttached === 1 ? '' : 's'} attached`
      const created = res.data.toolsCreated ? `, ${res.data.toolsCreated} created` : ''
      const updated = res.data.toolsUpdated ? `, ${res.data.toolsUpdated} updated` : ''
      const detail = `Pushed to the live ElevenLabs agent — ${counts}${created}${updated}.`
      return warnings.length ? `${detail} ${warnings.join(' ')}` : detail
    }, 'Pushed to the live ElevenLabs agent.')

  const onReset = () =>
    run('reset', async () => {
      const res = await resetAgentConfig()
      if (!res.data) throw new Error(res.error ?? 'Reset failed')
      load()
    }, 'Restored the shipped defaults.')

  if (loading) return <LoadingSpinner />
  if (error || !config) return <ErrorState message={error ?? 'No configuration returned'} onRetry={load} />

  // Two separate conditions, and the page has to tell them apart: the server
  // may allow editing while *this* browser holds no token, in which case every
  // write would come back 401 after a pointless round trip.
  const serverAllowsEditing = config.features.editing_enabled
  const hasToken = token.trim().length > 0
  const canEdit = serverAllowsEditing && hasToken

  const blockedReason = !serverAllowsEditing
    ? 'ADMIN_TOKEN is not set on the server.'
    : !hasToken
      ? 'Paste the admin token below to enable editing.'
      : null

  // Workstream 1 adds this to GET /api/agent-config; read it defensively so the
  // page keeps working against a server that does not send it yet.
  const promptNameMismatch =
    (config as { custom_prompt_mentions_other_name?: boolean })
      .custom_prompt_mentions_other_name === true

  // Saving stores the change; only a sync reaches callers. When the stored copy
  // is newer than the last push, the live agent is still saying the old thing.
  const pendingSync =
    !!config.updated_at &&
    (!config.synced_at || new Date(config.updated_at) > new Date(config.synced_at))

  const toggleTool = (name: string) =>
    setDisabled((d) => (d.includes(name) ? d.filter((n) => n !== name) : [...d, name]))

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agent Configuration</h1>
          <p className="text-sm text-gray-500 mt-1">
            Saving records a change here. Only <span className="font-medium text-gray-700">Sync
            to ElevenLabs</span> pushes it to the live agent that callers hear.
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {config.updated_at
              ? `Last saved ${new Date(config.updated_at).toLocaleString()}`
              : 'Never edited'}
            <span className="mx-2">·</span>
            {config.synced_at
              ? `Last synced ${new Date(config.synced_at).toLocaleString()}`
              : 'Never synced'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={onSave}
              disabled={!canEdit || !dirty || busy !== null}
              title={blockedReason ?? ''}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
            >
              <Save className="w-4 h-4" />
              {busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            <button
              onClick={onSync}
              disabled={!canEdit || !config.features.sync_enabled || busy !== null}
              title={
                blockedReason ??
                (config.features.sync_enabled
                  ? 'Push the saved configuration to the live ElevenLabs agent'
                  : 'Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server')
              }
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200 transition-colors"
            >
              <UploadCloud className="w-4 h-4" />
              {busy === 'sync' ? 'Syncing…' : 'Sync to ElevenLabs'}
            </button>
          </div>
          {blockedReason && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 text-right">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {blockedReason}
            </p>
          )}
          {!blockedReason && !config.features.sync_enabled && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 text-right">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Sync needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server.
            </p>
          )}
        </div>
      </div>

      {banner && (
        <div className={`mb-5 rounded-lg border p-3 text-sm ${
          banner.kind === 'ok'
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          {banner.text}
        </div>
      )}

      {!serverAllowsEditing && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">
            Editing is disabled because <code className="font-mono text-xs">ADMIN_TOKEN</code> is
            not set on the server. The page is read-only until it is configured.
          </p>
        </div>
      )}

      {serverAllowsEditing && !hasToken && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">
            The server allows editing, but this browser holds no admin token, so saving and
            syncing would be rejected. Paste the token into{' '}
            <span className="font-medium">Admin Token</span> to enable them.
          </p>
        </div>
      )}

      {pendingSync && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <UploadCloud className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <p className="text-sm text-blue-800">
            Saved changes have not been pushed to ElevenLabs yet — callers still hear the
            last synced version. Click <span className="font-medium">Sync to ElevenLabs</span>{' '}
            to make them live.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-gray-400" />
              System Prompt
              {config.customized && (
                <span className="text-xs font-normal text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                  customized
                </span>
              )}
            </h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!canEdit}
              rows={18}
              spellCheck={false}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-sm leading-relaxed text-gray-700 focus:border-blue-400 focus:bg-white focus:outline-none disabled:text-gray-500"
            />
            <p className="mt-2 text-xs text-gray-400">{prompt.length} characters</p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Wrench className="w-5 h-5 text-gray-400" />
              Tools
              <span className="text-sm font-normal text-gray-400">
                ({config.all_tools.filter((t) => !disabled.includes(t.name)).length} of {config.all_tools.length} enabled)
              </span>
            </h2>
            <div className="space-y-3">
              {config.all_tools.map((tool) => {
                const on = !disabled.includes(tool.name)
                return (
                  <div key={tool.name} className={`p-3 rounded-lg border ${on ? 'bg-gray-50 border-gray-200' : 'bg-white border-dashed border-gray-200'}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className={`text-sm font-medium font-mono ${on ? 'text-gray-900' : 'text-gray-400'}`}>
                          {tool.name}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
                      </div>
                      <button
                        onClick={() => toggleTool(tool.name)}
                        disabled={!canEdit}
                        className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                          on ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        } disabled:opacity-60`}
                      >
                        {on ? 'Enabled' : 'Disabled'}
                      </button>
                    </div>
                    <p className="text-xs font-mono text-gray-400 mt-2 break-all">{tool.url}</p>
                    {tool.parameters.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {tool.parameters.map((p) => (
                          <span
                            key={p.name}
                            title={p.description}
                            className={`px-1.5 py-0.5 rounded text-xs font-mono ${
                              p.required ? 'bg-gray-200 text-gray-700' : 'bg-gray-100 text-gray-400'
                            }`}
                          >
                            {p.name}{!p.required && '?'}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-gray-400" />
              Admin Token
            </h2>
            <input
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setAdminToken(e.target.value) }}
              placeholder="Paste to enable editing"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
            <p className="mt-2 text-xs text-gray-400">
              Stored in this browser only. Required for saving and syncing.
            </p>
            {!hasToken && (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                No token in this browser — Save and Sync are disabled.
              </p>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Volume2 className="w-5 h-5 text-gray-400" />
              Voice
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-xs text-gray-500">Agent Name</dt>
                <dd>
                  <input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    disabled={!canEdit}
                    className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none disabled:text-gray-500"
                  />
                  {promptNameMismatch && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        The saved system prompt or first message still names a different agent.
                        Renaming here will not change what callers hear until that text is
                        edited too.
                      </span>
                    </p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">First Message</dt>
                <dd>
                  <textarea
                    value={firstMessage}
                    onChange={(e) => setFirstMessage(e.target.value)}
                    disabled={!canEdit}
                    rows={3}
                    className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none disabled:text-gray-500"
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Provider</dt>
                <dd className="text-sm font-medium text-gray-900">ElevenLabs Agents</dd>
              </div>
              {config.integration.elevenlabs_agent_id && (
                <div>
                  <dt className="text-xs text-gray-500">Agent ID</dt>
                  <dd className="text-xs font-mono text-gray-600 break-all">
                    {config.integration.elevenlabs_agent_id}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Shield className="w-5 h-5 text-gray-400" />
              Enabled Integrations
            </h2>
            <ul className="space-y-2">
              <FeatureRow label="Webhook signature verification" enabled={config.features.webhook_signature_verification} hint="Set ELEVENLABS_WEBHOOK_SECRET" />
              <FeatureRow label="Config editing" enabled={config.features.editing_enabled} hint="Set ADMIN_TOKEN" />
              <FeatureRow label="Push to ElevenLabs" enabled={config.features.sync_enabled} hint="Set ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID" />
            </ul>

            {canEdit && config.customized && (
              <button
                onClick={onReset}
                disabled={busy !== null}
                className="mt-4 flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700"
              >
                <RotateCcw className="w-3 h-3" />
                {busy === 'reset' ? 'Restoring…' : 'Restore shipped defaults'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
