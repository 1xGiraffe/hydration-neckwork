import React, { useState, useMemo } from 'react'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { displayLabel } from '../utils/pairs'
import type { PairResult } from '../utils/pairs'
import { formatPrice, formatChange } from '../utils/format'
import { useWindowWidth } from '../hooks/useWindowWidth'
import Sparkline from './Sparkline'
import PairIcons from './PairIcons'

export interface MarketRow {
  assetId: number
  symbol: string
  name: string | null
  parachainId: number | null
  price: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  sparkline: number[]
  isCurrent: boolean
  pairResult: PairResult
  display: string
  nameHint: string | null
}

interface MarketTableProps {
  rows: MarketRow[]
  activeIndex: number
  onRowClick: (row: MarketRow) => void
  onRowMouseEnter: (index: number) => void
  listRef: React.RefObject<HTMLDivElement | null>
}

const columnHelper = createColumnHelper<MarketRow>()

function nullLastSortingFn(
  rowA: { getValue: (id: string) => unknown },
  rowB: { getValue: (id: string) => unknown },
  columnId: string
): number {
  const a = (rowA.getValue(columnId) as number | null) ?? Infinity
  const b = (rowB.getValue(columnId) as number | null) ?? Infinity
  return a < b ? -1 : a > b ? 1 : 0
}

export default function MarketTable({
  rows,
  activeIndex,
  onRowClick,
  onRowMouseEnter,
  listRef,
}: MarketTableProps) {
  const isMobile = useWindowWidth() <= 768
  const [sorting, setSorting] = useState<SortingState>([{ id: 'symbol', desc: false }])

  const columns = useMemo(() => [
    columnHelper.accessor('symbol', {
      header: 'Asset',
      sortingFn: 'alphanumeric',
      cell: (info) => {
        const row = info.row.original
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <PairIcons
              base={row.pairResult.base}
              quote={row.pairResult.quote}
              isUsdPair={row.pairResult.quote.isStablecoin}
              size={24}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <span style={{
                fontWeight: 600,
                fontSize: '14px',
                color: row.isCurrent ? '#4FFFDF' : '#e2e8f0',
              }}>
                {displayLabel(row.display)}
              </span>
              {row.nameHint && (
                <span style={{ fontSize: '11px', color: '#576B80', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.nameHint}
                </span>
              )}
            </div>
          </div>
        )
      },
    }),
    columnHelper.accessor('price', {
      header: 'Price',
      sortingFn: nullLastSortingFn,
      cell: (info) => {
        const price = info.getValue()
        return price !== null ? formatPrice(price) : '\u2014'
      },
    }),
    columnHelper.accessor('change1h', {
      header: '1h',
      sortingFn: nullLastSortingFn,
      cell: (info) => {
        const change = info.getValue()
        return (
          <span style={{
            color: change !== null && change > 0 ? '#4FFFDF' : '#576B80',
          }}>
            {formatChange(change)}
          </span>
        )
      },
    }),
    columnHelper.accessor('change24h', {
      header: '24h',
      sortingFn: nullLastSortingFn,
      cell: (info) => {
        const change = info.getValue()
        return (
          <span style={{
            color: change !== null && change > 0 ? '#4FFFDF' : '#576B80',
          }}>
            {formatChange(change)}
          </span>
        )
      },
    }),
    columnHelper.accessor('change7d', {
      header: '7d',
      sortingFn: nullLastSortingFn,
      cell: (info) => {
        const change = info.getValue()
        return (
          <span style={{
            color: change !== null && change > 0 ? '#4FFFDF' : '#576B80',
          }}>
            {formatChange(change)}
          </span>
        )
      },
    }),
    columnHelper.accessor('sparkline', {
      header: 'Last 7 Days',
      enableSorting: false,
      cell: (info) => {
        const row = info.row.original
        return <Sparkline data={info.getValue()} change7d={row.change7d} />
      },
    }),
  ], [isMobile])

  const table = useReactTable({
    data: rows,
    columns,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div ref={listRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', background: '#030816' }}>
      <table style={{ tableLayout: 'fixed', width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: '#1e293b' }}>
          {table.getHeaderGroups().map(headerGroup => (
            <tr key={headerGroup.id} style={{ height: '36px' }}>
              {headerGroup.headers.map(header => {
                const isSortable = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                const isChange1h = header.column.id === 'change1h'
                const isChange7d = header.column.id === 'change7d'
                const hideOnMobile = (isChange1h || isChange7d) && isMobile

                let sortIndicator = ''
                let sortIndicatorColor = '#576B80'
                if (isSortable) {
                  if (sorted === 'asc') {
                    sortIndicator = ' \u25B2'
                    sortIndicatorColor = '#4FFFDF'
                  } else if (sorted === 'desc') {
                    sortIndicator = ' \u25BC'
                    sortIndicatorColor = '#4FFFDF'
                  } else {
                    sortIndicator = ' \u2195'
                    sortIndicatorColor = '#576B80'
                  }
                }

                const isSymbol = header.column.id === 'symbol'
                const isPrice = header.column.id === 'price'
                const isSparkline = header.column.id === 'sparkline'

                let thStyle: React.CSSProperties = {
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#e2e8f0',
                  padding: '0 16px',
                  cursor: isSortable ? 'pointer' : 'default',
                  userSelect: 'none',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  display: hideOnMobile ? 'none' : 'table-cell',
                }

                if (isSymbol) {
                  thStyle = { ...thStyle, minWidth: isMobile ? '80px' : '120px' }
                } else if (isPrice) {
                  thStyle = { ...thStyle, width: '100px', textAlign: 'right' }
                } else if (isChange1h) {
                  thStyle = { ...thStyle, width: '64px', textAlign: 'right' }
                } else if (header.column.id === 'change24h' || header.column.id === 'change7d') {
                  thStyle = { ...thStyle, width: '64px', textAlign: 'right' }
                } else if (isSparkline) {
                  thStyle = { ...thStyle, width: '112px', textAlign: 'center' }
                }

                return (
                  <th
                    key={header.id}
                    style={thStyle}
                    aria-sort={
                      isSortable
                        ? sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                          ? 'descending'
                          : 'none'
                        : undefined
                    }
                    onClick={isSortable ? header.column.getToggleSortingHandler() : undefined}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {isSortable && (
                      <span style={{ color: sortIndicatorColor, fontSize: '10px', position: 'relative', top: sorted ? '-1px' : '-2px' }}>{sortIndicator}</span>
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, rowIndex) => {
            const isActive = rowIndex === activeIndex
            const change24h = row.original.change24h
            const accentColor = change24h !== null && change24h > 0 ? '#4FFFDF' : '#576B80'
            return (
              <tr
                key={row.id}
                role="option"
                aria-selected={row.original.isCurrent}
                onClick={() => onRowClick(row.original)}
                onMouseEnter={() => onRowMouseEnter(rowIndex)}
                style={{
                  minHeight: '56px',
                  background: isActive ? '#1e293b' : 'transparent',
                  borderBottom: '1px solid #0d1b2a',
                  cursor: 'pointer',
                  transition: 'background 0.1s ease',
                  borderLeft: isActive ? `3px solid ${accentColor}` : '3px solid transparent',
                }}
              >
                {row.getVisibleCells().map(cell => {
                  const isChange1hCell = cell.column.id === 'change1h'
                  const isChange7dCell = cell.column.id === 'change7d'
                  const hideCellOnMobile = (isChange1hCell || isChange7dCell) && isMobile
                  const isSymbolCell = cell.column.id === 'symbol'
                  const isPriceCell = cell.column.id === 'price'
                  const isSparklineCell = cell.column.id === 'sparkline'

                  let tdStyle: React.CSSProperties = {
                    padding: '8px 16px',
                    fontSize: '14px',
                    color: '#e2e8f0',
                    display: hideCellOnMobile ? 'none' : 'table-cell',
                    verticalAlign: 'middle',
                  }

                  if (isSymbolCell) {
                    tdStyle = { ...tdStyle, minWidth: isMobile ? '80px' : '120px' }
                  } else if (isPriceCell) {
                    tdStyle = { ...tdStyle, width: '100px', textAlign: 'right' }
                  } else if (isChange1hCell) {
                    tdStyle = { ...tdStyle, width: '64px', textAlign: 'right' }
                  } else if (cell.column.id === 'change24h' || cell.column.id === 'change7d') {
                    tdStyle = { ...tdStyle, width: '64px', textAlign: 'right' }
                  } else if (isSparklineCell) {
                    tdStyle = { ...tdStyle, width: '112px', textAlign: 'center' }
                  }

                  return (
                    <td key={cell.id} style={tdStyle}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
