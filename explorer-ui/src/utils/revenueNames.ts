// The two revenue names, once. Long forms are exactly "Protocol Revenue" and
// "User Revenue"; where space is short they read "P. Revenue" / "U. Revenue",
// and the short form always carries a hover giving the long form plus its
// one-line meaning. The two are NOT additive (see AGENTS.md, USER REVENUE), so
// neither hint may read as a share of the other.
export const PROTOCOL_REVENUE = 'Protocol Revenue'
export const USER_REVENUE = 'User Revenue'
export const PROTOCOL_REVENUE_SHORT = 'P. Revenue'
export const USER_REVENUE_SHORT = 'U. Revenue'
export const PROTOCOL_REVENUE_HINT = "Protocol Revenue — what the account's activity paid to the protocol: fees, liquidation penalties and the reserve factor's share of borrow interest (all of HOLLAR's)"
export const USER_REVENUE_HINT = 'User Revenue — what the account earned on Hydration, net of borrow interest and other costs, all time'
