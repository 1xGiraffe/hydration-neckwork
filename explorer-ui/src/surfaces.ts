// The sibling surfaces this deployment runs, named once.
//
// A page module is the wrong home for an origin another route also needs:
// importing it from one would pull that page's whole module — its dialogs, its
// session hooks — into the other's lazily-loaded chunk for the sake of one
// string. This file imports nothing, so it costs nothing to share.

// REST access to the same dataset, for programs that post-process it.
export const DATA_API_URL = 'https://hydration-data.neckwork.net'

// The price-chart app for the same pairs. Baked in at BUILD time like every
// other VITE_ value (see explorer-ui/Dockerfile); the fallback is this
// deployment's own host rather than a dev port, so an unset variable links
// somewhere real.
export const PREIS_URL = (import.meta.env.VITE_PREIS_URL as string | undefined) || 'https://hydration-preis.neckwork.net'
