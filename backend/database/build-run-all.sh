#!/usr/bin/env bash
# Regenerate run-all.sql from the individual migrations plus the seed.
# Run from the database/ directory:  bash build-run-all.sh
set -euo pipefail
cd "$(dirname "$0")"

FILES=(
  migration.sql
  0002_filecoin_columns.sql
  0003_filecoin_tables.sql
  0004_call_log_analysis.sql
  seed.sql
  0005_test_dataset.sql
  0006_simulation_mode.sql
  0007_dashboard_read_policies.sql
  0008_agent_settings.sql
  0009_demo_policies.sql
  0010_settlement.sql
  0011_extended_dataset.sql
  0012_policy_renewals.sql
  0013_claim_documents.sql
  0015_escalations_without_call.sql
  0016_rls_for_new_tables.sql
  0017_adjudications.sql
  0018_deductible_payments.sql
  0019_adjudication_reviews.sql
  0020_renewal_capture.sql
  0021_journey_events.sql
)

{
  cat <<'HDR'
-- ============================================
-- SafeGuard — complete database setup
--
-- Generated from, in order:
--   migration.sql
--   0002_filecoin_columns.sql
--   0003_filecoin_tables.sql
--   0004_call_log_analysis.sql
--   seed.sql
--   0005_test_dataset.sql
--   0006_simulation_mode.sql
--   0007_dashboard_read_policies.sql
--   0008_agent_settings.sql
--   0009_demo_policies.sql
--   0010_settlement.sql
--   0011_extended_dataset.sql
--   0012_policy_renewals.sql
--   0013_claim_documents.sql
--   0015_escalations_without_call.sql
--   0016_rls_for_new_tables.sql
--   0017_adjudications.sql
--   0018_deductible_payments.sql
--   0019_adjudication_reviews.sql
--   0020_renewal_capture.sql
--   0021_journey_events.sql
--
-- Paste the whole file into the Supabase SQL editor and run it.
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.
--
-- Regenerate with: bash database/build-run-all.sh
-- ============================================

HDR
  for f in "${FILES[@]}"; do
    echo ""
    echo "-- ============================================"
    echo "-- SOURCE: $f"
    echo "-- ============================================"
    echo ""
    cat "$f"
    echo ""
  done
} > run-all.sql

echo "Wrote run-all.sql ($(wc -l < run-all.sql) lines)"
