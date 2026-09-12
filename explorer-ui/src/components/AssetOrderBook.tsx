import { F, AssetIcon, AssetAmount, AddrPill, Dash, EmptyRow, rowNav } from './ui'
import { paths } from '../router'
import { bookSpread, depthShare, maxSideSizeUsd } from '../utils/orderBook'
import type { AssetBookEntry, AssetLimitOrderBook, AssetListItem } from '../types'

// The asset page's resting limit orders, read as a book: bids buy this asset,
// asks sell it, each side ranked by the price it offers the asset at.
//
// The orders are NOT all quoted in the same asset — one bid may pay HOLLAR, the
// next H2O — so a raw pair price cannot rank them against each other. `priceUsd`
// (the pair price at the counter asset's current price) is the common axis, and
// it is what each side sorts on; the pair price stays on the row because that is
// the number the order actually holds out for. An order whose counter asset has
// no price feed cannot be placed in the ladder at all and sits at the bottom of
// its side, marked, rather than posing as the best or worst price in the book.

function BookSide({ side, entries, asset }: { side: 'bids' | 'asks'; entries: AssetBookEntry[]; asset: AssetListItem }) {
  const bids = side === 'bids'
  const max = maxSideSizeUsd(entries)
  return (
    <div className="book-side">
      <div className="sec-title">
        {bids ? 'Bids' : 'Asks'} · {entries.length}
        <span className="book-side-note">· {bids ? `orders buying ${asset.symbol}` : `orders selling ${asset.symbol}`}</span>
      </div>
      <div className="panel book-panel"><table className={'tbl book-tbl' + (bids ? ' book-bids' : ' book-asks')}>
        <thead><tr>
          <th className="r">Price</th><th className="r">Size</th><th className="r">Total</th><th>Owner</th>
        </tr></thead>
        <tbody>
          {!entries.length
            ? <EmptyRow cols={4}>No open orders {bids ? 'buying' : 'selling'} {asset.symbol}</EmptyRow>
            : entries.map(e => (
              <tr key={e.intentId} {...rowNav(paths.intent(e.intentId))} data-intent-order={e.intentId}
                style={{ '--depth': `${depthShare(e, max) * 100}%` } as React.CSSProperties}>
                <td data-label="Price" className="r">
                  {e.price != null
                    ? <>
                      <span className="mono book-price">{F.amount(String(e.price), 0)}</span>
                      {' '}<span className="mono muted">{e.counter.symbol}</span>
                      <span className="dca-sub mono muted">
                        {e.priceUsd != null
                          ? F.priceUsd(e.priceUsd)
                          : <span title={`No price feed for ${e.counter.symbol}, so this order cannot be ranked against the rest of the book`}>unranked</span>}
                      </span>
                    </>
                    : <Dash />}
                </td>
                {/* Size is what is still resting in THIS asset; total is what the
                    counter side of that remainder is worth to the owner. */}
                <td data-label="Size" className="r">
                  <AssetAmount asset={asset} raw={e.size} />
                  {e.sizeUsd != null && <span className="dca-sub mono muted">{F.usd(e.sizeUsd)}</span>}
                </td>
                <td data-label="Total" className="r">
                  <span className="trade-leg">
                    <AssetIcon assetId={e.counter.assetId} iconAssetId={e.counter.iconAssetId} symbol={e.counter.symbol} size={16} parachainId={e.counter.parachainId} origin={e.counter.origin} />
                    {' '}<span className="mono">{F.amount(e.total, e.counter.decimals)}</span>
                  </span>
                  {e.fills > 0 && <span className="dca-sub mono muted" title={`${e.fills} partial ${e.fills === 1 ? 'fill' : 'fills'} already taken off this order`}>
                    {F.int(e.fills)} filled
                  </span>}
                </td>
                <td data-label="Owner"><AddrPill account={e.who} noCopy /></td>
              </tr>
            ))}
        </tbody>
      </table></div>
    </div>
  )
}

export function AssetOrderBook({ book, asset }: { book: AssetLimitOrderBook; asset: AssetListItem }) {
  const spread = bookSpread(book)
  return (
    <>
      {spread && (
        <div className="book-spread">
          <span className="muted">Spread</span>
          {/* A crossed book (ask under bid) is possible here and is not an error:
              the two orders may be quoted in different assets, and the solver
              fills against the AMM as well, so a crossing pair simply has not
              been matched yet. Say the number either way. */}
          <span className="mono">{F.priceUsd(Math.abs(spread.absUsd))}</span>
          <span className="mono muted">{spread.absUsd < 0 ? 'crossed · ' : ''}{Math.abs(spread.pct).toFixed(2)}%</span>
          <span className="muted">mid</span>
          <span className="mono">{F.priceUsd(spread.midUsd)}</span>
        </div>
      )}
      <div className="book-grid">
        <BookSide side="bids" entries={book.bids} asset={asset} />
        <BookSide side="asks" entries={book.asks} asset={asset} />
      </div>
    </>
  )
}
