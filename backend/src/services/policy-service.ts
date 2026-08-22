import { SupabaseClient } from '@supabase/supabase-js';
import { isNotFound, unavailable } from './lookup-result.js';
import { referenceCandidates } from './reference-number.js';

export async function lookupPolicy(
  supabase: SupabaseClient,
  policyNumber: string
) {
  let data: any = null;
  let error: any = null;

  // Spoken policy numbers usually arrive without dashes.
  for (const candidate of referenceCandidates(policyNumber)) {
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
