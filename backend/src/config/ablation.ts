/**
 * Evaluation-only switches that disable a safety layer so its contribution can
 * be measured.
 *
 * A claim like "100% accuracy" says nothing without a comparison. These flags
 * let the harness run the same cases with a layer removed, which turns the
 * result into "100% with the layer, N% without it" — a statement about whether
 * the layer earns its place.
 *
 * These are dangerous switches. `ABLATE_REFUSAL_GATES` disables the checks that
 * stop a claim being filed against an expired policy. They therefore:
 *
 *   - refuse to activate when NODE_ENV=production; the process exits instead of
 *     starting in a degraded state
 *   - are reported at /health so a server running with one is never mistaken for
 *     a normal deployment
 *
 * Intended use is a local server started by `npm run ablate`, never a deployment.
 */

type Ablation = 'normalisation' | 'refusalGates';

const ENV_KEYS: Record<Ablation, string> = {
  normalisation: 'ABLATE_NORMALISATION',
  refusalGates: 'ABLATE_REFUSAL_GATES',
};

function read(name: Ablation): boolean {
  return process.env[ENV_KEYS[name]] === 'true';
}

const requested = (Object.keys(ENV_KEYS) as Ablation[]).filter(read);

// Fail closed. A production process must never run with a safety layer removed,
// and exiting is louder than logging a warning nobody reads.
if (requested.length && (process.env.NODE_ENV || 'development') === 'production') {
  const names = requested.map((a) => ENV_KEYS[a]).join(', ');
  console.error(
    `[safeguard] refusing to start: ${names} set with NODE_ENV=production.\n` +
      `Ablation flags disable safety checks and are for local evaluation only.`
  );
  process.exit(1);
}

export const ablations = {
  /** Skip alternative spellings; look reference numbers up by exact match only. */
  normalisation: read('normalisation'),
  /** Skip the policy-status and input-validation checks that refuse a filing. */
  refusalGates: read('refusalGates'),
  /** True when any layer is disabled — surfaced at /health. */
  get any(): boolean {
    return this.normalisation || this.refusalGates;
  },
  /** Names of the disabled layers, for reporting. */
  get active(): Ablation[] {
    return requested;
  },
};
