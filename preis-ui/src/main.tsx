import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { subscribeHead } from './live'
import './styles/global.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
})

// A pushed main-indexer head means new prices exist: refresh the
// indexer-status chip immediately (its fallback interval, one nominal block,
// pauses while the stream is healthy). The chart subscribes separately for its own candle poll.
// Hidden-tab deferral lives in live.ts — a background tab does no work and
// catches up on the deferred head when it becomes visible again.
subscribeHead(() => {
  void queryClient.invalidateQueries({ queryKey: ['indexer-status'], refetchType: 'active' })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
