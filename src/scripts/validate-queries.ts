import { createClickHouseClient } from '../db/client.js'

interface QueryTest {
  name: string
  query: string
  expectedMinRows?: number
  expectedMaxRows?: number
  expectation: string
}

interface TestResult {
  name: string
  duration: number  // milliseconds
  rowCount: number
  passed: boolean
  error?: string
}

const SUB_SECOND_MS = 1000

// Test data constants (from seed-test-data.ts)
const START_BLOCK = 7_000_000
const END_BLOCK = 7_000_499
const MID_BLOCK = 7_000_250
const RANGE_START = 7_000_100
const RANGE_END = 7_000_200
const ASSET_HDX = 0
const ASSET_DOT = 5
const ASSET_WBTC = 100

async function runQuery(client: ReturnType<typeof createClickHouseClient>, query: string): Promise<{ duration: number; rowCount: number; rows: any[] }> {
  const startTime = Date.now()

  const result = await client.query({
    query,
    format: 'JSONEachRow',
  })

  const rows = await result.json()
  const duration = Date.now() - startTime

  return {
    duration,
    rowCount: Array.isArray(rows) ? rows.length : 1,
    rows,
  }
}

async function main() {
  console.log('🔍 Validating ClickHouse Query Patterns\n')
  console.log('=' .repeat(60))

  const client = createClickHouseClient()
  const results: TestResult[] = []

  try {
    // ===========================================
    // Test 1: Point Query
    // ===========================================
    console.log('\n📍 Test 1: Point query (specific asset at specific block)')
    const pointQuery = `
      SELECT usdt_price
      FROM prices FINAL
      WHERE asset_id = ${ASSET_HDX} AND block_height = ${MID_BLOCK}
    `
    console.log(`   Query: SELECT price WHERE asset_id=${ASSET_HDX} AND block_height=${MID_BLOCK}`)

    try {
      const { duration, rowCount, rows } = await runQuery(client, pointQuery)
      console.log(`   Duration: ${duration}ms`)
      console.log(`   Rows: ${rowCount}`)
      if (rowCount > 0) {
        console.log(`   Sample: ${JSON.stringify(rows[0])}`)
      }

      const passed = duration < SUB_SECOND_MS && rowCount === 1
      results.push({
        name: 'Point query',
        duration,
        rowCount,
        passed,
        error: passed ? undefined : `Expected exactly 1 row in <${SUB_SECOND_MS}ms`,
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Point query',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Test 2: Range Query
    // ===========================================
    console.log('\n📊 Test 2: Range query (asset price history over range)')
    const rangeQuery = `
      SELECT block_height, usdt_price
      FROM prices FINAL
      WHERE asset_id = ${ASSET_DOT}
        AND block_height BETWEEN ${RANGE_START} AND ${RANGE_END}
      ORDER BY block_height
    `
    console.log(`   Query: SELECT price WHERE asset_id=${ASSET_DOT} AND block_height BETWEEN ${RANGE_START} AND ${RANGE_END}`)

    try {
      const { duration, rowCount, rows } = await runQuery(client, rangeQuery)
      console.log(`   Duration: ${duration}ms`)
      console.log(`   Rows: ${rowCount}`)
      if (rowCount > 0) {
        console.log(`   Sample: ${JSON.stringify(rows[0])}`)
      }

      const expectedRows = RANGE_END - RANGE_START + 1
      const passed = duration < SUB_SECOND_MS && rowCount === expectedRows
      results.push({
        name: 'Range query',
        duration,
        rowCount,
        passed,
        error: passed ? undefined : `Expected ${expectedRows} rows in <${SUB_SECOND_MS}ms, got ${rowCount}`,
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Range query',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Test 3: Cross-Asset Query
    // ===========================================
    console.log('\n🔀 Test 3: Cross-asset query (compare two assets over range)')
    const crossAssetQuery = `
      SELECT asset_id, block_height, usdt_price
      FROM prices FINAL
      WHERE asset_id IN (${ASSET_HDX}, ${ASSET_WBTC})
        AND block_height BETWEEN ${RANGE_START} AND ${RANGE_END}
      ORDER BY block_height, asset_id
    `
    console.log(`   Query: SELECT price WHERE asset_id IN (${ASSET_HDX}, ${ASSET_WBTC}) AND block_height BETWEEN ${RANGE_START} AND ${RANGE_END}`)

    try {
      const { duration, rowCount, rows } = await runQuery(client, crossAssetQuery)
      console.log(`   Duration: ${duration}ms`)
      console.log(`   Rows: ${rowCount}`)
      if (rowCount > 0) {
        console.log(`   Sample: ${JSON.stringify(rows.slice(0, 2))}`)
      }

      const expectedRows = (RANGE_END - RANGE_START + 1) * 2  // Two assets
      const passed = duration < SUB_SECOND_MS && rowCount === expectedRows
      results.push({
        name: 'Cross-asset query',
        duration,
        rowCount,
        passed,
        error: passed ? undefined : `Expected ${expectedRows} rows in <${SUB_SECOND_MS}ms, got ${rowCount}`,
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Cross-asset query',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Test 4: Timestamp Join Query
    // ===========================================
    console.log('\n⏰ Test 4: Timestamp join (prices with block timestamps)')
    const joinQuery = `
      SELECT p.asset_id, p.block_height, p.usdt_price, b.block_timestamp
      FROM (SELECT * FROM prices FINAL WHERE asset_id = ${ASSET_DOT} AND block_height BETWEEN ${RANGE_START} AND ${RANGE_END}) p
      INNER JOIN blocks b ON p.block_height = b.block_height
      ORDER BY p.block_height
      LIMIT 5
    `
    console.log(`   Query: JOIN prices with blocks on block_height`)

    try {
      const { duration, rowCount, rows } = await runQuery(client, joinQuery)
      console.log(`   Duration: ${duration}ms`)
      console.log(`   Rows: ${rowCount}`)
      if (rowCount > 0) {
        console.log(`   Sample: ${JSON.stringify(rows[0])}`)
      }

      const passed = duration < SUB_SECOND_MS && rowCount === 5
      results.push({
        name: 'Timestamp join',
        duration,
        rowCount,
        passed,
        error: passed ? undefined : `Expected 5 rows with timestamps in <${SUB_SECOND_MS}ms`,
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Timestamp join',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Test 5: Deduplication Verification
    // ===========================================
    console.log('\n🔄 Test 5: Deduplication verification (FINAL eliminates duplicates)')
    console.log('   First, force merge to ensure deduplication has occurred...')

    try {
      await client.exec({ query: 'OPTIMIZE TABLE prices FINAL' })
      console.log('   ✓ Merge complete')

      // Count without FINAL
      const countWithoutFinalQuery = `SELECT count() as cnt FROM prices WHERE asset_id = ${ASSET_HDX}`
      const withoutFinal = await runQuery(client, countWithoutFinalQuery)

      // Count with FINAL
      const countWithFinalQuery = `SELECT count() as cnt FROM prices FINAL WHERE asset_id = ${ASSET_HDX}`
      const withFinal = await runQuery(client, countWithFinalQuery)

      const countWithoutFinal = withoutFinal.rows[0].cnt
      const countWithFinal = withFinal.rows[0].cnt

      console.log(`   Without FINAL: ${countWithoutFinal} rows`)
      console.log(`   With FINAL: ${countWithFinal} rows`)

      // After OPTIMIZE FINAL, counts should match (all duplicates merged)
      const passed = countWithoutFinal === countWithFinal
      results.push({
        name: 'Dedup verification',
        duration: withoutFinal.duration + withFinal.duration,
        rowCount: countWithFinal,
        passed,
        error: passed ? undefined : 'Deduplication not working (counts should match after OPTIMIZE)',
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Dedup verification',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Test 6: Asset Metadata Query
    // ===========================================
    console.log('\n🏷️  Test 6: Asset metadata query')
    const assetsQuery = `SELECT * FROM assets FINAL ORDER BY asset_id`
    console.log('   Query: SELECT * FROM assets FINAL')

    try {
      const { duration, rowCount, rows } = await runQuery(client, assetsQuery)
      console.log(`   Duration: ${duration}ms`)
      console.log(`   Rows: ${rowCount}`)
      if (rowCount > 0) {
        console.log(`   Sample: ${JSON.stringify(rows[0])}`)
      }

      const passed = duration < SUB_SECOND_MS && rowCount === 7
      results.push({
        name: 'Asset metadata',
        duration,
        rowCount,
        passed,
        error: passed ? undefined : `Expected 7 asset rows in <${SUB_SECOND_MS}ms`,
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Asset metadata',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Test 7: Partition Check
    // ===========================================
    console.log('\n📦 Test 7: Partition verification (monthly partitioning active)')
    const partitionQuery = `
      SELECT partition, count() as part_count
      FROM system.parts
      WHERE database = 'price_data'
        AND table = 'prices'
        AND active
      GROUP BY partition
      ORDER BY partition
    `
    console.log('   Query: Check active partitions in system.parts')

    try {
      const { duration, rowCount, rows } = await runQuery(client, partitionQuery)
      console.log(`   Duration: ${duration}ms`)
      console.log(`   Active partitions: ${rowCount}`)
      rows.forEach((row: any) => {
        console.log(`     - Partition ${row.partition}: ${row.part_count} parts`)
      })

      const passed = rowCount >= 1  // At least one partition should exist
      results.push({
        name: 'Partition check',
        duration,
        rowCount,
        passed,
        error: passed ? undefined : 'No active partitions found',
      })
      console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}`)
    } catch (error) {
      results.push({
        name: 'Partition check',
        duration: 0,
        rowCount: 0,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      })
      console.log(`   ❌ FAIL: ${error}`)
    }

    // ===========================================
    // Summary
    // ===========================================
    console.log('\n' + '='.repeat(60))
    console.log('Query Validation Results:')
    console.log('='.repeat(60))

    results.forEach(result => {
      const status = result.passed ? 'PASS' : 'FAIL'
      const symbol = result.passed ? '✅' : '❌'
      console.log(`${symbol} ${result.name.padEnd(25)} ${result.duration.toString().padStart(5)}ms  ${status}`)
      if (result.error) {
        console.log(`   Error: ${result.error}`)
      }
    })

    console.log('='.repeat(60))

    const passCount = results.filter(r => r.passed).length
    const totalCount = results.length

    if (passCount === totalCount) {
      console.log(`\n✅ All ${totalCount} checks passed!`)
      console.log('\nSchema validation successful:')
      console.log('  - Point queries: sub-second ✓')
      console.log('  - Range queries: sub-second ✓')
      console.log('  - Cross-asset queries: sub-second ✓')
      console.log('  - JOIN queries: sub-second ✓')
      console.log('  - Deduplication: working ✓')
      console.log('  - Partitioning: active ✓')
      console.log('\n🎯 Schema is ready for Phase 2 bulk ingestion!')
    } else {
      console.log(`\n❌ ${totalCount - passCount} check(s) failed.`)
      process.exit(1)
    }

  } catch (error) {
    console.error('\n❌ Fatal error during validation:', error)
    process.exit(1)
  } finally {
    await client.close()
  }
}

main()
