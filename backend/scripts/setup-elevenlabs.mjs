/**
 * Creates the SafeGuard webhook tools in ElevenLabs and attaches them to the agent.
 *
 * Tool definitions are fetched from the live backend's /api/agent-config, so the
 * agent is always configured against the endpoints the backend actually serves.
 *
 *   ELEVENLABS_API_KEY=xi_... npm run setup:elevenlabs
 *
 * Optional env:
 *   ELEVENLABS_AGENT_ID   existing agent to configure; omit to create a new one
 *   API_BASE_URL          defaults to the deployed Railway backend
 *   SYNC_PROMPT=false     skip overwriting the agent's system prompt
 *
 * Re-runnable: existing tools of the same name are updated, not duplicated.
 */
import 'dotenv/config';

const API_KEY = process.env.ELEVENLABS_API_KEY;
// When unset, a new agent is created in whichever workspace the API key belongs to.
let AGENT_ID = process.env.ELEVENLABS_AGENT_ID || null;
const BASE_URL =
  process.env.API_BASE_URL || 'https://safeguard-api-production-7c24.up.railway.app';
const SYNC_PROMPT = process.env.SYNC_PROMPT !== 'false';

const EL = 'https://api.elevenlabs.io/v1';

if (!API_KEY) {
  console.error('ELEVENLABS_API_KEY is not set.');
  console.error('Get one at https://elevenlabs.io/app/settings/api-keys');
  process.exit(1);
}

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function el(path, options = {}) {
  const res = await fetch(`${EL}${path}`, {
    ...options,
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${res.status} ${path} — ${detail.slice(0, 400)}`);
  }
  return body;
}

// --- Pull the canonical tool definitions from the backend -------------------

console.log(`Fetching agent definition from ${BASE_URL} ...`);
const configRes = await fetch(`${BASE_URL}/api/agent-config`);
if (!configRes.ok) {
  console.error(`Could not reach the backend: HTTP ${configRes.status}`);
  process.exit(1);
}
const { data: config } = await configRes.json();
console.log(`  ${config.tools.length} tools defined\n`);

/** Convert our parameter list into an ElevenLabs request_body_schema. */
function bodySchema(tool) {
  const properties = {};
  for (const p of tool.parameters) {
    properties[p.name] = { type: p.type, description: p.description };
  }
  return {
    type: 'object',
    description: `Arguments for ${tool.name}`,
    properties,
    required: tool.parameters.filter((p) => p.required).map((p) => p.name),
  };
}

const toolConfigFor = (tool) => ({
  type: 'webhook',
  name: tool.name,
  description: tool.description,
  response_timeout_secs: 20,
  api_schema: {
    url: tool.url,
    method: tool.method,
    request_body_schema: bodySchema(tool),
  },
});

// --- Create the agent if we were not given one ------------------------------

if (!AGENT_ID) {
  console.log('No ELEVENLABS_AGENT_ID given — creating a new agent ...');
  const created = await el('/convai/agents/create', {
    method: 'POST',
    body: JSON.stringify({
      name: 'SafeGuard Claims Agent',
      conversation_config: {
        agent: {
          prompt: { prompt: config.system_prompt },
          first_message: config.first_message,
          language: 'en',
        },
      },
    }),
  });
  AGENT_ID = created.agent_id;
  console.log(`${green('  created')}  agent ${AGENT_ID}
`);
} else {
  console.log(`Using existing agent ${AGENT_ID}
`);
}

// --- Reconcile tools --------------------------------------------------------

console.log('Existing tools in your workspace:');
const existing = await el('/convai/tools');
const byName = new Map();
for (const t of existing.tools ?? []) {
  const name = t.tool_config?.name ?? t.name;
  if (name) byName.set(name, t.id);
}
console.log(`  ${byName.size} found\n`);

const toolIds = [];
const failures = [];

for (const tool of config.tools) {
  const payload = { tool_config: toolConfigFor(tool) };
  const existingId = byName.get(tool.name);

  try {
    if (existingId) {
      await el(`/convai/tools/${existingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toolIds.push(existingId);
      console.log(`${green('  updated')}  ${tool.name}`);
    } else {
      const created = await el('/convai/tools', { method: 'POST', body: JSON.stringify(payload) });
      toolIds.push(created.id);
      console.log(`${green('  created')}  ${tool.name}`);
    }
  } catch (err) {
    failures.push({ tool: tool.name, error: err.message });
    console.log(`${red('  failed ')}  ${tool.name}`);
    console.log(dim(`            ${err.message.slice(0, 200)}`));
  }
}

if (toolIds.length === 0) {
  console.error('\nNo tools were created. Aborting before touching the agent.');
  process.exit(1);
}

// --- Attach to the agent ----------------------------------------------------

console.log(`\nAttaching ${toolIds.length} tools to ${AGENT_ID} ...`);

const agentUpdate = {
  ...(SYNC_PROMPT ? { name: `SafeGuard Claims Agent (${config.agent_name})` } : {}),
  conversation_config: {
    agent: {
      prompt: {
        tool_ids: toolIds,
        ...(SYNC_PROMPT ? { prompt: config.system_prompt } : {}),
      },
      ...(SYNC_PROMPT ? { first_message: config.first_message } : {}),
    },
  },
};

try {
  await el(`/convai/agents/${AGENT_ID}`, { method: 'PATCH', body: JSON.stringify(agentUpdate) });
  console.log(green('  agent updated'));
} catch (err) {
  console.log(red(`  agent update failed — ${err.message.slice(0, 300)}`));
  failures.push({ tool: 'agent update', error: err.message });
}

// --- Verify by reading the agent back ---------------------------------------

console.log('\nVerifying ...');
try {
  const agent = await el(`/convai/agents/${AGENT_ID}`);
  const attached = agent.conversation_config?.agent?.prompt?.tool_ids ?? [];
  console.log(`  tools attached : ${attached.length}`);
  console.log(`  first message  : ${agent.conversation_config?.agent?.first_message ?? '(unset)'}`);
} catch (err) {
  console.log(dim(`  could not read agent back: ${err.message.slice(0, 160)}`));
}

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log(green(`All ${toolIds.length} tools configured and attached.`));
  console.log(`
AGENT ID: ${AGENT_ID}`);
  console.log(dim('  set as VITE_ELEVENLABS_AGENT_ID in the frontend, then redeploy'));
  console.log('\nStill to do by hand (no API for it): enable the post-call webhook at');
  console.log('  https://elevenlabs.io/app/settings/webhooks');
  console.log(`  URL: ${config.integration.webhook_url}`);
} else {
  console.log(red(`${failures.length} step(s) failed:`));
  for (const f of failures) console.log(`  ${f.tool}: ${f.error.slice(0, 200)}`);
  process.exitCode = 1;
}
