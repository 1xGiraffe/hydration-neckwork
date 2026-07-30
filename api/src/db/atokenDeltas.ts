// Aave scaled-balance event math shared by the replay-safe ClickHouse read
// model and the raw fallback queries. Keeping the formula in one module avoids
// migration/read-path drift that would change supplied or borrowed amounts.
export const ATOKEN_RAY_SQL = `toInt256(toUInt256('1000000000000000000000000000'))`

// `ar` is a decoded_args_json alias. Mint.value includes balanceIncrease while
// Burn.value excludes it; BalanceTransfer.value is already scaled.
export const ATOKEN_DELTA_ARRAYJOIN = `
  ARRAY JOIN
    [ if(event_name='Mint', JSONExtractString(ar,'onBehalfOf'), if(event_name='Burn', JSONExtractString(ar,'from'), JSONExtractString(ar,'to'))),
      if(event_name='BalanceTransfer', JSONExtractString(ar,'from'), '') ] AS holder,
    [ multiIf(
        event_name='Mint',  intDiv((toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))) - toInt256(toUInt256OrZero(JSONExtractString(ar,'balanceIncrease')))) * ${ATOKEN_RAY_SQL}, greatest(toInt256(toUInt256OrZero(JSONExtractString(ar,'index'))), toInt256(1))),
        event_name='Burn', -intDiv((toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))) + toInt256(toUInt256OrZero(JSONExtractString(ar,'balanceIncrease')))) * ${ATOKEN_RAY_SQL}, greatest(toInt256(toUInt256OrZero(JSONExtractString(ar,'index'))), toInt256(1))),
        toInt256(toUInt256OrZero(JSONExtractString(ar,'value')))),
      if(event_name='BalanceTransfer', -toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))), toInt256(0)) ] AS sdelta`

export const ATOKEN_DELTA_SELECT_SQL = `
  WITH decoded_args_json AS ar,
    [ if(event_name='Mint', JSONExtractString(ar,'onBehalfOf'), if(event_name='Burn', JSONExtractString(ar,'from'), JSONExtractString(ar,'to'))),
      if(event_name='BalanceTransfer', JSONExtractString(ar,'from'), '') ] AS holders,
    [ multiIf(
        event_name='Mint',  intDiv((toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))) - toInt256(toUInt256OrZero(JSONExtractString(ar,'balanceIncrease')))) * ${ATOKEN_RAY_SQL}, greatest(toInt256(toUInt256OrZero(JSONExtractString(ar,'index'))), toInt256(1))),
        event_name='Burn', -intDiv((toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))) + toInt256(toUInt256OrZero(JSONExtractString(ar,'balanceIncrease')))) * ${ATOKEN_RAY_SQL}, greatest(toInt256(toUInt256OrZero(JSONExtractString(ar,'index'))), toInt256(1))),
        toInt256(toUInt256OrZero(JSONExtractString(ar,'value')))),
      if(event_name='BalanceTransfer', -toInt256(toUInt256OrZero(JSONExtractString(ar,'value'))), toInt256(0)) ] AS deltas,
    arrayJoin(arrayZip(holders, deltas, arrayEnumerate(holders))) AS leg
  SELECT lower(contract_address) AS contract_address,
    lower(tupleElement(leg, 1)) AS holder,
    block_height, event_index, block_timestamp,
    ifNull(event_name, '') AS event_name,
    toUInt8(tupleElement(leg, 3)) AS leg_index,
    tupleElement(leg, 2) AS scaled_delta,
    ingested_at
  FROM price_data.raw_evm_logs
  WHERE event_name IN ('Mint','Burn','BalanceTransfer')
    AND tupleElement(leg, 1) != ''`
