import { describe,expect,it } from 'vitest'
import {
  buildMoneyMarketAccountValueClaims,
  mmReserveAddressForAsset,
  type LatestMoneyMarketAggregate,
  type MmReserveToken,
  type MoneyMarketScaledHolding,
} from '../src/services/explorerService.ts'

const RAY=10n**27n
const holder=`0x${'12'.repeat(20)}`
const pool=`0x${'34'.repeat(20)}`
const aToken=`0x${'56'.repeat(20)}`
const vDebt=`0x${'78'.repeat(20)}`

const token: MmReserveToken={
  asset:mmReserveAddressForAsset(5)[0],aToken,vDebt,poolProxy:pool,marketKey:'core',
}
const aggregate: LatestMoneyMarketAggregate={
  holder,poolAddress:pool,marketKey:'core',totalCollateralBase:1_500n,
  totalDebtBase:500n,availableBorrowsBase:250n,liquidationThreshold:8_000,
  ltv:7_000n,healthFactor:2n*RAY,blockHeight:123,blockTimestamp:'2026-01-01 00:00:00',
}

describe('buildMoneyMarketAccountValueClaims',()=>{
  it('keeps aggregate risk state and converts scaled supply/debt with exact integer indices',()=>{
    const holdings: MoneyMarketScaledHolding[]=[
      {holder,contract:aToken,scaled:1_000n},
      {holder,contract:vDebt,scaled:300n},
    ]
    const claims=buildMoneyMarketAccountValueClaims(
      holdings,[token],new Map([[`${pool}:${token.asset}`,{liq:2n*RAY,vbi:3n*RAY}]]),[aggregate],
    )

    expect(claims).toHaveLength(2)
    expect(claims[0]).toMatchObject({
      reservePresent:false,assetId:0,totalCollateralBase:1_500n,
      totalDebtBase:500n,availableBorrowsBase:250n,liquidationThreshold:8_000,
      ltv:7_000n,healthFactor:2n*RAY,blockHeight:123,
    })
    expect(claims[1]).toMatchObject({
      reservePresent:true,assetId:5,supplied:2_000n,debt:900n,
      totalCollateralBase:0n,totalDebtBase:0n,
    })
  })

  it('retains reserve-only positions and rejects incomplete index coverage',()=>{
    const holdings=[{holder,contract:aToken,scaled:1_000n}]
    expect(buildMoneyMarketAccountValueClaims(
      holdings,[token],new Map([[`${pool}:${token.asset}`,{liq:RAY,vbi:RAY}]]),[],
    )).toHaveLength(2)
    expect(()=>buildMoneyMarketAccountValueClaims(holdings,[token],new Map(),[]))
      .toThrow('missing money-market reserve index')
  })

  it('rejects duplicate logical scaled holdings before aggregation',()=>{
    const duplicate={holder,contract:aToken,scaled:1_000n}
    expect(()=>buildMoneyMarketAccountValueClaims(
      [duplicate,duplicate],[token],new Map([[`${pool}:${token.asset}`,{liq:RAY,vbi:RAY}]]),[],
    )).toThrow('duplicate money-market scaled holding')
  })
})
