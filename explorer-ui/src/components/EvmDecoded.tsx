import { Link, paths } from '../router'
import { F, ParamsTable } from './ui'
import { decodedParamsRecord } from '../utils/evmDecoded'
import type { DecodedEvmCall, EvmLogDecode } from '../types'

// Verified-ABI decodes on detail surfaces (§9): a decoded EVM call (extrinsic
// detail) and a decoded EVM log (event detail / expanded event rows). Values
// come typed from the api — addresses as bare H160 strings, integers as decimal
// strings — so the existing ParamsTable renders them with its address
// auto-linking; the declared parameter types live in the signature chip.

const chipStyle = { color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' } as const

export function EvmCallCard({ decoded }: { decoded: DecodedEvmCall }) {
  const { target, contractName, call } = decoded
  return (
    <div className="evm-decoded">
      <div className="row gap6" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="pill-badge" style={chipStyle} title={call.decoded ? `selector ${call.selector}` : undefined}>
          {call.decoded ? call.signature : call.selector ?? 'no calldata'}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>on</span>
        <Link to={paths.account(target)} className="hash mono" title={target}>{contractName || F.shortAddr(target)}</Link>
        {call.decoded && <span className="muted mono" style={{ fontSize: 11 }} title="Decoded against this contract's verified ABI">verified ABI</span>}
      </div>
      {call.decoded
        ? call.params.length > 0 && <ParamsTable args={decodedParamsRecord(call.params)} />
        : <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>selector not in the verified ABI — arguments shown raw below</div>}
    </div>
  )
}

export function EvmLogView({ decoded }: { decoded: EvmLogDecode }) {
  return (
    <div className="evm-decoded">
      <div className="row gap6" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="pill-badge" style={chipStyle}>{decoded.signature}</span>
        <span className="muted mono" style={{ fontSize: 11 }} title="Named at request time from the contract's verified ABI">verified ABI</span>
      </div>
      {decoded.params.length > 0
        ? <ParamsTable args={decodedParamsRecord(decoded.params)} />
        : <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12 }}>no parameters</div>}
    </div>
  )
}
