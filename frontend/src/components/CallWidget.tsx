import { createElement } from 'react'

/**
 * Mounts the ElevenLabs browser voice widget.
 *
 * The agent id must come from configuration: a hardcoded fallback silently
 * points the widget at someone else's agent when the env var is missing,
 * which looks like it works but talks to the wrong backend.
 */
export function CallWidget() {
  const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID

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

  return createElement('elevenlabs-convai', { 'agent-id': agentId })
}
