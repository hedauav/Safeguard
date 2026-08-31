import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * `globals` is off, so React Testing Library's own auto-cleanup never runs —
 * it hooks a global `afterEach` that does not exist here. Unmounting between
 * tests is not optional for this suite: `CallWidget` registers a `window`
 * listener, and a widget left mounted from a previous test would answer the
 * next test's event as well.
 */
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  localStorage.clear()
})
