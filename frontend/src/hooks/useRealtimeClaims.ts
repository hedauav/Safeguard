import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { Claim } from '../types'

export function useRealtimeClaims() {
  const [claims, setClaims] = useState<Claim[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchClaims = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const { data, error: err } = await supabase
        .from('claims')
        .select(`
          *,
          customers!claims_customer_id_fkey ( full_name )
        `)
        .order('updated_at', { ascending: false })

      if (err) throw err

      // The embedded customers join arrives alongside the claim columns.
      type ClaimRow = Omit<Claim, 'customer_name'> & { customers?: { full_name?: string } | null }

      const mapped = ((data ?? []) as ClaimRow[]).map(({ customers, ...claim }) => ({
        ...claim,
        customer_name: customers?.full_name || 'Unknown',
      })) as Claim[]
      setClaims(mapped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch claims')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchClaims()

    const channel = supabase
      .channel('claims-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'claims' },
        () => {
          fetchClaims()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchClaims])

  return { claims, loading, error, refetch: fetchClaims }
}
