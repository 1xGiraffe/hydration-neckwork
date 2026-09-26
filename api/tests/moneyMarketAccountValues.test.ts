import { describe,expect,it } from 'vitest'
import {
  buildMoneyMarketAccountValueClaims,
  moneyMarketClaimReservePresent,
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

  // A holder's usage-as-collateral bit means a balance (Aave clears it at zero), so a
  // flagged reserve the fold holds no supply of — GDOT that reached the holder
  // Substrate-side, outside the aToken logs — is stored as reserve_present = 2 with
  // zero amounts: the directory then values that market by its aggregate, as the
  // account page does (mmUnstatedCollateralUsd), and nowhere else.
  it('stores a collateral reserve the fold holds nothing of as an unstated claim',()=>{
    const indices=new Map([[`${pool}:${token.asset}`,{liq:RAY,vbi:RAY}]])
    const on=new Map([[holder,new Map([[`${pool}:${token.asset.toLowerCase()}`,true]])]])
    const claims=buildMoneyMarketAccountValueClaims([],[token],indices,[aggregate],on)
    expect(claims).toHaveLength(2)
    expect(claims[1]).toMatchObject({reservePresent:true,unstated:true,assetId:5,supplied:0n,debt:0n,totalCollateralBase:0n})
    expect(claims.map(moneyMarketClaimReservePresent)).toEqual([0,2])
    // A debt-only reserve row leaves the supply just as unstated; the two rows differ
    // in reserve_present, so the generation's (account, pool, reserve_present, asset)
    // identity stays unique.
    const debtOnly=buildMoneyMarketAccountValueClaims([{holder,contract:vDebt,scaled:300n}],[token],indices,[aggregate],on)
    expect(debtOnly.map(moneyMarketClaimReservePresent)).toEqual([0,1,2])
    // A reconstructed supply satisfies the bit.
    const supplied=buildMoneyMarketAccountValueClaims([{holder,contract:aToken,scaled:1_000n}],[token],indices,[aggregate],on)
    expect(supplied.map(moneyMarketClaimReservePresent)).toEqual([0,1])
    // A cleared bit (the holder exited; the aggregate is a stale observation) and a
    // holder with neither aggregate nor holding name nothing.
    const off=new Map([[holder,new Map([[`${pool}:${token.asset.toLowerCase()}`,false]])]])
    expect(buildMoneyMarketAccountValueClaims([],[token],indices,[aggregate],off).map(moneyMarketClaimReservePresent)).toEqual([0])
    expect(buildMoneyMarketAccountValueClaims([],[token],indices,[],on)).toHaveLength(0)
  })

  it('rejects duplicate logical scaled holdings before aggregation',()=>{
    const duplicate={holder,contract:aToken,scaled:1_000n}
    expect(()=>buildMoneyMarketAccountValueClaims(
      [duplicate,duplicate],[token],new Map([[`${pool}:${token.asset}`,{liq:RAY,vbi:RAY}]]),[],
    )).toThrow('duplicate money-market scaled holding')
  })
})
