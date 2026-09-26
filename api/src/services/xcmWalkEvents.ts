// The event vocabulary of an XCM message's execution on Hydration — what closes a
// message, what it credits, and what the executor emits around those credits. One
// leaf module (no imports) because three readers walk the same shape and must agree
// on it: the activity feed's inbound decode (explorerService), the xcm_arrivals
// derivation that stores what the feed decodes, and the revenue model's XCM
// execution-fee stream (revenueStreams) together with the extrinsic page's fee
// resolver (extrinsicFeePayment). A SQL restatement of the walk drifted in four
// separate ways when it was measured against the feed's path — barrier set, credit
// set, reserved-account prefixes and the crossable events — which is why every
// consumer reads these lists rather than spelling its own.

// The barrier events every XCM decode pairs its legs with. MessageQueue.Processed
// closes every inbound message since the MessageQueue runtime migration (block
// 5,433,625); before it, DMP messages from the relay closed with
// DmpQueue.ExecutedDownward and HRMP messages from sibling parachains with
// XcmpQueue.Success/Fail — a decode that only knows the new barrier drops every
// pre-migration cross-chain transfer (~120k messages) on the floor. Nothing predates
// these four: before the first XcmpQueue/DmpQueue event (block 1,439,879) not one
// user-account hook deposit shares a block with a downward message — measured, all
// 24,800 of them are on-initialize reward/vesting credits, not XCM.
export const XCM_BARRIER_EVENTS = ['MessageQueue.Processed', 'DmpQueue.ExecutedDownward', 'XcmpQueue.Success', 'XcmpQueue.Fail']

// Inbound XCM credits. An incoming message executes outside any extrinsic and ends
// with a barrier event (XCM_BARRIER_EVENTS — MessageQueue.Processed names the origin
// chain; the pre-migration barriers name at most the relay). The beneficiary credit
// is the run of deposit events directly before that barrier: walk back while events
// stay in the deposit family, keep non-module/non-sovereign recipients, and fold the
// Currencies/Tokens/Balances mirror duplicates into one row per (who, currency,
// amount). A remote-execution message (Transact/swap) cuts the walk at its first
// non-deposit event, so only what the message actually credited to a user account
// surfaces.
export const XCM_IN_DEPOSIT_EVENTS = ['Currencies.Deposited', 'Tokens.Deposited', 'Balances.Deposit']
export const XCM_IN_WALK_EVENTS = [...XCM_IN_DEPOSIT_EVENTS, 'Balances.Issued', 'Balances.Endowed', 'Tokens.Endowed', 'Balances.Minted', 'System.NewAccount']

// Events the XCM executor emits WHILE running a message, between the deposits it
// credits and the MessageQueue.Processed that closes it. The credit run steps over
// these; anything else ends it.
//
// `AssetsTrapped` is the one that matters: it is emitted when part of a message's
// assets cannot be delivered — a Snowbridge transfer whose DOT fee remainder could
// not be deposited traps it here — and it lands directly before the barrier, which
// is precisely where a contiguity rule cannot survive it.
//
// `EVM.Log` is the second: an ERC20-backed asset keeps its balances in a contract, so
// the currency adapter mirrors every leg as an ERC20 Transfer log and emits no
// Tokens.Deposited at all. HOLLAR (222) arrives that way — EVM.Log, Currencies.Deposited,
// EVM.Log, Currencies.Deposited, barrier — so the mirror separates the beneficiary's
// credit from the treasury fee credit above it and the run ended one step short of the
// user: 149 of the first 151 HOLLAR arrivals decoded to nothing at all. The log is the
// bookkeeping half of a credit the run already walks, never a credit of its own, so
// crossing it can only reunite a run the mirror split.
//
// Deliberately NOT crossable: MessageQueue.*, DmpQueue.* and XcmpQueue.Success/Fail.
// Each of those closes or reports a DIFFERENT message, so crossing one would let a
// run reach into the message before it. Nor `EVM.Executed`/`EVM.ExecutedFailed`: those
// mark a program the message DISPATCHED rather than a balance it credited, and they are
// what cuts the walk on a Transact — a Moonbeam MRL message moves sub-cent WETH fee legs
// inside its own execution, which are not credits this message made.
export const XCM_WALK_CROSSABLE_EVENTS = [
  'PolkadotXcm.AssetsTrapped', 'PolkadotXcm.AssetsClaimed', 'PolkadotXcm.FeesPaid',
  'PolkadotXcm.Sent', 'PolkadotXcm.Attempted', 'PolkadotXcm.SupportedVersionChanged',
  'PolkadotXcm.VersionNotifyRequested', 'PolkadotXcm.VersionChangeNotified',
  'PolkadotXcm.VersionNotifyStarted', 'PolkadotXcm.VersionMigrationFinished',
  'XcmpQueue.XcmpMessageSent', 'EVM.Log',
]

// The event pallet_xcm emits when it EXECUTED a program locally — `execute`, and the
// in-credit local leg of its transfer extrinsics. For the fee readers it is the
// barrier of a local execution, exactly as MessageQueue.Processed is the barrier of
// an inbound one: the weight trader deposits its revenue when the executor drops,
// which is the last thing before this event. (The inbound walk crosses it instead,
// because a message that Transacts a local `execute` nests one execution's events
// inside another's credits.)
export const XCM_EXECUTE_BARRIER_EVENT = 'PolkadotXcm.Attempted'

// Every event the trader's deposit may be separated from its barrier by: the deposit
// family (the fee's own Currencies mirror, the HDX `Balances.Issued` twin, a
// beneficiary's endowment) and the executor's bookkeeping — with the local-execution
// barrier taken out, since for the fee readers it closes a run rather than sitting
// inside one. Anything else between a treasury deposit and the barrier means the
// deposit was not the trader's (a Transact's gas, a dust sweep, a pool fee leg).
export const XCM_FEE_RUN_EVENTS = [
  ...XCM_IN_WALK_EVENTS,
  ...XCM_WALK_CROSSABLE_EVENTS.filter(name => name !== XCM_EXECUTE_BARRIER_EVENT),
]
