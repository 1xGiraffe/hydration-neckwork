import { createClickHouseClient } from '../db/client.js'
import type { PriceRow, BlockRow, AssetRow } from '../db/schema.js'

interface TestAsset {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  basePrice: number  // Base USDT price for synthetic generation
  volatility: number // Price variation factor
}

const TEST_ASSETS: TestAsset[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HydraDX', decimals: 12, basePrice: 0.015, volatility: 0.0002 },
  { asset_id: 1, symbol: 'LRNA', name: 'LRNA', decimals: 12, basePrice: 0.95, volatility: 0.001 },
  { asset_id: 2, symbol: 'DAI', name: 'DAI Stablecoin', decimals: 18, basePrice: 1.00, volatility: 0.001 },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, basePrice: 6.25, volatility: 0.01 },
  { asset_id: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, basePrice: 1.00, volatility: 0.0005 },
  { asset_id: 20, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, basePrice: 2340.50, volatility: 1.0 },
  { asset_id: 100, symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, basePrice: 42500.00, volatility: 10.0 },
]

const START_BLOCK = 7_000_000
const BLOCK_COUNT = 500
const BLOCK_TIME_SECONDS = 12
const START_TIMESTAMP = new Date('2024-12-01T00:00:00Z').getTime() / 1000
const SPEC_VERSION = 282  // Realistic Hydration spec version from Dec 2024

function generateSyntheticPrice(asset: TestAsset, blockOffset: number): string {
  // Generate price with small random walk using integer arithmetic for cleaner decimals
  const scale = 1000000  // Use 6 decimals of precision to avoid floating point issues

  const baseScaled = Math.round(asset.basePrice * scale)
  const randomWalk = Math.floor((Math.random() - 0.5) * asset.volatility * 2 * scale)
  const trendFactor = Math.floor(Math.sin(blockOffset / 50) * asset.volatility * 0.5 * scale)

  const priceScaled = Math.max(1, baseScaled + randomWalk + trendFactor)
  const price = priceScaled / scale

  // Format to 6 decimal places (cleaner than 12, still precise enough)
  return price.toFixed(6)
}

async function main() {
  const startTime = Date.now()
  console.log('🌱 Seeding ClickHouse with test data...\n')

  const client = createClickHouseClient()

  try {
    // Generate block data
    console.log(`📦 Generating ${BLOCK_COUNT} blocks...`)
    const blocks: BlockRow[] = []
    for (let i = 0; i < BLOCK_COUNT; i++) {
      blocks.push({
        block_height: START_BLOCK + i,
        block_timestamp: (START_TIMESTAMP + i * BLOCK_TIME_SECONDS).toString(),  // Unix timestamp as string
        spec_version: SPEC_VERSION,
      })
    }

    // Generate asset metadata
    console.log(`🏷️  Generating ${TEST_ASSETS.length} assets...`)
    const assets: AssetRow[] = TEST_ASSETS.map(a => ({
      asset_id: a.asset_id,
      symbol: a.symbol,
      name: a.name,
      decimals: a.decimals,
    }))

    // Generate price data with some duplicates for deduplication testing
    console.log(`💰 Generating price data...`)
    const prices: PriceRow[] = []
    const duplicates: PriceRow[] = []

    for (let i = 0; i < BLOCK_COUNT; i++) {
      for (const asset of TEST_ASSETS) {
        const priceStr = generateSyntheticPrice(asset, i)

        // Validate price format
        if (priceStr.includes('e') || priceStr.includes('E')) {
          console.error(`ERROR: Scientific notation in price at row ${prices.length}: ${priceStr}`)
          process.exit(1)
        }

        const price: PriceRow = {
          asset_id: asset.asset_id,
          block_height: START_BLOCK + i,
          usdt_price: priceStr,
        }
        prices.push(price)

        // Create some duplicates (10% of blocks) with different prices
        // This tests ReplacingMergeTree deduplication
        if (i % 10 === 0) {
          const dupPriceStr = generateSyntheticPrice(asset, i + 0.5)
          if (dupPriceStr.includes('e') || dupPriceStr.includes('E')) {
            console.error(`ERROR: Scientific notation in duplicate price: ${dupPriceStr}`)
            process.exit(1)
          }
          duplicates.push({
            asset_id: asset.asset_id,
            block_height: START_BLOCK + i,
            usdt_price: dupPriceStr,
          })
        }
      }
    }

    const totalPriceRows = prices.length + duplicates.length
    console.log(`   - ${prices.length} base price rows`)
    console.log(`   - ${duplicates.length} duplicate rows for dedup testing`)
    console.log(`   - ${totalPriceRows} total price inserts\n`)

    // Insert blocks
    console.log('📥 Inserting blocks...')
    await client.insert({
      table: 'blocks',
      values: blocks,
      format: 'JSONEachRow',
    })
    console.log(`   ✓ Inserted ${blocks.length} blocks`)

    // Insert assets
    console.log('📥 Inserting assets...')
    await client.insert({
      table: 'assets',
      values: assets,
      format: 'JSONEachRow',
    })
    console.log(`   ✓ Inserted ${assets.length} assets`)

    // Insert prices (base + duplicates)
    console.log('📥 Inserting prices...')

    // Use exec command instead of insert to have full control over value formatting
    const allPrices = [...prices, ...duplicates]

    // Build INSERT VALUES statement with explicit string formatting for decimals
    const valueStrings = allPrices.map(p => {
      return `(${p.asset_id}, ${p.block_height}, '${p.usdt_price}')`
    })

    // Insert in batches to avoid too large queries
    const batchSize = 1000
    for (let i = 0; i < valueStrings.length; i += batchSize) {
      const batchValues = valueStrings.slice(i, i + batchSize).join(',\n')
      const query = `INSERT INTO prices (asset_id, block_height, usdt_price) VALUES\n${batchValues}`

      await client.exec({ query })
    }

    console.log(`   ✓ Inserted ${totalPriceRows} price rows (including duplicates)`)

    const duration = Date.now() - startTime
    console.log(`\n✅ Seeding complete in ${duration}ms`)
    console.log('\nSummary:')
    console.log(`  Blocks:  ${blocks.length} rows`)
    console.log(`  Assets:  ${assets.length} rows`)
    console.log(`  Prices:  ${totalPriceRows} rows (${duplicates.length} are duplicates for testing)`)
    console.log(`  Range:   Block ${START_BLOCK} to ${START_BLOCK + BLOCK_COUNT - 1}`)

  } catch (error) {
    console.error('❌ Error seeding data:', error)
    process.exit(1)
  } finally {
    await client.close()
  }
}

main()
