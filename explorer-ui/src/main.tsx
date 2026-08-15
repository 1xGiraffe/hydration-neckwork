import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { shouldRetryQuery } from './queryRetry'
import { LIVE_PUSH_KEYS, POOL_PUSH_KEYS, subscribeHead } from './live'
import './styles/global.css'
import { initTabsInk } from './tabsInk'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
  },
})

// A pushed head means a block is fully ingested: refetch the live feeds NOW
// instead of on the next poll tick. Only active (mounted) queries refetch.
// Hidden-tab deferral lives in live.ts — a background tab does no work and
// catches up on the deferred head when it becomes visible again.
// A pool-only push means no new block — only the feeds that merge
// transaction-pool rows have anything to fetch, and those pushes arrive far
// more often than blocks do.
subscribeHead(({ poolOnly }) => {
  for (const key of poolOnly ? POOL_PUSH_KEYS : LIVE_PUSH_KEYS) {
    void queryClient.invalidateQueries({ queryKey: [key], refetchType: 'active' })
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

initTabsInk()
