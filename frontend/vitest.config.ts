import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * The frontend test runner.
 *
 * Kept apart from `vite.config.ts` rather than folded into it: the Tailwind
 * plugin has nothing to do here, and a test run should not be able to break
 * the production build by touching the config that produces it.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The env this suite asserts against is set per-test with `vi.stubEnv`.
    // Without this, a developer's own `.env.local` would decide whether the
    // production-build guard in `resolveBaseUrl` is exercised at all.
    //
    // The Supabase pair used to be blanked here too. It is gone because the
    // browser no longer talks to Supabase at all: the last direct read moved
    // behind the API, so the publishable key is not read, not imported, and no
    // longer shipped in the bundle.
    env: {
      VITE_API_URL: '',
      VITE_ELEVENLABS_AGENT_ID: '',
    },
  },
})
