// The probe is the protocol's own liveness call: a JSON-RPC `ping` POSTed to
// /mcp, which a stateless server answers 200 `{"result":{}}` without a session.
// It goes through the same edge, CORS preflight, access-key gate and transport
// as a real client, and a healthy answer is a 2xx, so a working endpoint leaves
// no failed request in the console (a bare GET would, as a 405 by design). Only
// that exact answer is Ready; every other status is a finding — a 404 from a
// misrouted vhost, a 200 HTML placeholder and a 403 from the edge all mean no
// agent can connect. 401 is the gated deployment: MCP_ACCESS_KEYS is set, so
// the open snippets below would be rejected and each switches to its
// authorized form.
export const PROBE_ID = 'explorer-probe'
export const PROBE_BODY = JSON.stringify({ jsonrpc: '2.0', id: PROBE_ID, method: 'ping' })

export type ProbeState = 'ready' | 'key' | 'unexpected' | 'down'
export interface Probe { state: ProbeState; status: number; ms: number }

export function classifyProbe(status: number, body: unknown): ProbeState {
  if (status === 401) return 'key'
  if (status >= 500) return 'down'
  if (status !== 200 || typeof body !== 'object' || body === null) return 'unexpected'
  const { jsonrpc, id, result } = body as Record<string, unknown>
  return jsonrpc === '2.0' && id === PROBE_ID && typeof result === 'object' && result !== null ? 'ready' : 'unexpected'
}
