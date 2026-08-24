import { SupabaseClient } from '@supabase/supabase-js';
import { isNotFound, unavailable } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';
import { ablations } from '../config/ablation.js';

export async function lookupPolicy(
  supabase: SupabaseClient,
  policyNumber: string
) {
  let data: any = null;
  let error: any = null;

  // Spoken policy numbers usually arrive without dashes.
  // Policy lookup normalises independently of the claim path, so the
  // ablation has to reach both — measuring one and reporting it as the layer's
  // whole contribution would understate it.
  const candidates = ablations.normalisation ? [policyNumber] : referenceCandidates(policyNumber);
  for (const candidate of candidates) {
    const attempt = await supabase
      .from('policies')
      .select('*, customers!inner(full_name)')
      .eq('policy_number', candidate)
      .maybeSingle();
    if (attempt.data) { data = attempt.data; error = null; break; }
    if (attempt.error && !isNotFound(attempt.error)) { error = attempt.error; break; }
    error = attempt.error;
  }

  if (error && !isNotFound(error)) {
    console.error('lookupPolicy: query failed:', error);
    return unavailable('policy');
  }

  if (!data) {
    return {
      found: false as const,
      message: "I couldn't find a policy with that number. Could you read it back to me?",
    };
  }

  const customer_name = (data.customers as any)?.full_name || 'Unknown';

  return {
    found: true as const,
    policy: {
      policy_number: data.policy_number,
      policy_type: data.policy_type,
      provider: data.provider,
      status: data.status,
      coverage_amount: data.coverage_amount,
      deductible: data.deductible,
      premium_monthly: data.premium_monthly,
      coverage_details: data.coverage_details,
      customer_name,
    },
  };
}
