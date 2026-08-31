#!/usr/bin/env node
/**
 * Print what was actually read out of a claim's documents.
 *
 * The point of this script is that it reads the stored column and nothing
 * else. It does not re-run the parser, so what it prints is what the
 * adjudicator would be shown — the difference between "the extractor works"
 * and "the extractor's output reached the database" is exactly where a feature
 * like this quietly fails.
 *
 *   node scripts/show-extracted-text.mjs CLM-2026-000456
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, which backend/.env has.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Load backend/.env without pulling in a dependency.
for (const line of readFileSync(join(here, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const claimNumber = process.argv[2]

if (!claimNumber) {
  console.error('Usage: node scripts/show-extracted-text.mjs CLM-2026-000456')
  process.exit(1)
}
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env')
  process.exit(1)
}

const headers = { apikey: key, Authorization: `Bearer ${key}` }

const claims = await fetch(
  `${url}/rest/v1/claims?claim_number=eq.${encodeURIComponent(claimNumber)}&select=id,claim_number,claimed_amount`,
  { headers }
).then((r) => r.json())

if (!Array.isArray(claims) || claims.length === 0) {
  console.error(`No claim ${claimNumber}.`)
  process.exit(1)
}

const claim = claims[0]
const docs = await fetch(
  `${url}/rest/v1/claim_documents?claim_id=eq.${claim.id}` +
    '&select=document_type,original_filename,mime_type,size_bytes,content_hash,text_source,extracted_text,uploaded_at' +
    '&order=uploaded_at.asc',
  { headers }
).then((r) => r.json())

console.log(`\n${claim.claim_number} — claimed ${claim.claimed_amount ?? '(none stated)'}`)
console.log(`${docs.length} document(s)\n`)

for (const d of docs) {
  console.log('─'.repeat(72))
  console.log(`${d.document_type}  ·  ${d.original_filename ?? '(no filename)'}  ·  ${d.mime_type ?? '?'}  ·  ${d.size_bytes ?? '?'} bytes`)
  console.log(`hash        : ${d.content_hash}`)
  console.log(`text_source : ${d.text_source ?? 'null'}`)
  if (!d.extracted_text) {
    // Said plainly rather than left blank: a document with no text is reported
    // to the adjudicator as not cross-checked, never silently omitted.
    console.log('extracted   : (nothing — this document was hashed but not read)')
  } else {
    console.log(`extracted   : ${d.extracted_text.length} chars`)
    console.log('─'.repeat(72))
    console.log(d.extracted_text)
  }
  console.log('')
}
