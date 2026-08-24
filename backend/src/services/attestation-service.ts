import { keccak256, toBytes } from 'viem';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EvidenceBundle {
  claimId?: string;
  claim_id?: string;
  claimNumber?: string;
  claim_number?: string;
  policyNumber?: string;
  policy_number?: string;
  customerId?: string;
  customer_id?: string;
  incidentDate?: string;
  incident_date?: string;
  incidentDescription?: string;
  incident_description?: string;
  documents?: string[];
  photoCids?: string[];
  filed_at?: string;
  claim_type?: string;
  call_log_id?: string;
  timestamp?: string;
  metadata?: Record<string, JsonValue>;
  /**
   * One entry per file uploaded against the claim: its type and the keccak256
   * of its bytes. Folding these in is what makes the anchored bundle hash
   * commit to the files themselves rather than to a list of their names.
   */
  document_hashes?: Array<{ document_type: string; content_hash: string }>;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize((value as Record<string, JsonValue>)[key]);
        return acc;
      }, {} as Record<string, JsonValue>);
  }
  return value;
}

export function computeEvidenceHash(input: JsonValue): string {
  const canonical = canonicalize(input);
  const serialized = JSON.stringify(canonical);
  return keccak256(toBytes(serialized));
}

/**
 * keccak256 of raw file bytes, 0x-prefixed.
 *
 * The same primitive as computeEvidenceHash so a claim carries one hashing
 * convention rather than two: that one canonicalises JSON before hashing,
 * this one hashes the bytes exactly as they arrived. Nothing is normalised —
 * a single flipped byte in an uploaded photo has to change the hash, or the
 * whole tamper-evidence claim is decorative.
 */
export function computeContentHash(bytes: Uint8Array): string {
  return keccak256(bytes);
}

export function buildEvidenceBundle(input: EvidenceBundle): { bundle: EvidenceBundle; hash: string } {
  const hash = computeEvidenceHash(input as unknown as JsonValue);
  return { bundle: input, hash };
}
