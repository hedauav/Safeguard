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

  const describe = (err: unknown): string => {
    const anyErr = err as { response?: { status?: number; data?: { error?: string } } }
    const status = anyErr?.response?.status
    if (status === 401) return 'Admin token rejected. Check the token below.'
    if (status === 503) return anyErr.response?.data?.error ?? 'Editing is disabled on the server.'
    return anyErr?.response?.data?.error ?? (err instanceof Error ? err.message : String(err))
  }

  const run = async (
    kind: 'save' | 'sync' | 'reset',
    action: () => Promise<void>,
    success: string
  ) => {
    setBusy(kind)
    setBanner(null)
    try {
      await action()
      setBanner({ kind: 'ok', text: success })
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
      const w = res.data.warnings?.length ? ` (${res.data.warnings.length} warning(s))` : ''
      setBanner({
        kind: 'ok',
        text: `Synced ${res.data.toolsAttached} tools to the live agent${w}.`,
      })
      load()
    }, 'Synced to ElevenLabs.')

  const onReset = () =>
    run('reset', async () => {
      const res = await resetAgentConfig()
      if (!res.data) throw new Error(res.error ?? 'Reset failed')
      load()
    }, 'Restored the shipped defaults.')

  if (loading) return <LoadingSpinner />
  if (error || !config) return <ErrorState message={error ?? 'No configuration returned'} onRetry={load} />

  const canEdit = config.features.editing_enabled
  const toggleTool = (name: string) =>
    setDisabled((d) => (d.includes(name) ? d.filter((n) => n !== name) : [...d, name]))

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agent Configuration</h1>
          <p className="text-sm text-gray-500 mt-1">
            Edit the live agent, then push it to ElevenLabs.
            {config.synced_at && (
              <span className="ml-2 text-gray-400">
                Last synced {new Date(config.synced_at).toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onSave}
            disabled={!canEdit || !dirty || busy !== null}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
          >
            <Save className="w-4 h-4" />
            {busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
          <button
            onClick={onSync}
            disabled={!canEdit || !config.features.sync_enabled || busy !== null}
            title={config.features.sync_enabled ? '' : 'Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server'}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200 transition-colors"
          >
            <UploadCloud className="w-4 h-4" />
            {busy === 'sync' ? 'Syncing…' : 'Sync to ElevenLabs'}
          </button>
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

      {!canEdit && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">
            Editing is disabled because <code className="font-mono text-xs">ADMIN_TOKEN</code> is
            not set on the server. The page is read-only until it is configured.
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
