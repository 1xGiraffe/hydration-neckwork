import { z } from 'zod'

// Chart-zoom refinement windows, shared by every windowed history route: with a
// window the history is rebuilt on the finest ladder grain that fits the point
// budget (never below an hour) instead of the route's coarse default, so zooming
// reveals detail the coarse series cannot express. `fromTs`/`toTs` (unix
// seconds), not `from`/`to`: the plugin-wide filter guard reserves those as
// calendar-day params.
export const windowSchema = z.object({
  fromTs: z.coerce.number().int().min(0).max(0xffff_ffff),
  toTs: z.coerce.number().int().min(0).max(0xffff_ffff),
  points: z.coerce.number().int().min(10).max(400).optional(),
})

/** The default point budget, the charts' own (chartZoom's 180). */
export const DEFAULT_WINDOW_POINTS = 180
