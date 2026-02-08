# GlueLend

Lending without liquidity pools. Borrow directly from a token's backing using [Glue Protocol](https://wiki.glue.finance).

## How It Works

Traditional DeFi lending requires massive idle TVL, price oracles, and liquidation engines. GlueLend replaces all of that with Glue's burn-for-collateral mechanism.

Every GlueLend token is a [Sticky Asset](https://wiki.glue.finance) — an ERC20 backed by collateral locked in a Glue contract. The collateral is always claimable by burning tokens. GlueLend turns this into a lending primitive:

1. **Borrow** — Burn tokens via Glue, receive the underlying collateral (ETH, USDC, etc.). The protocol records your debt.
2. **Repay** — Return the collateral. The protocol mints your tokens back.
3. **Leverage** — Borrow repeatedly to accumulate a larger position.

The math is simple: `withdrawal = (tokens_burned / total_supply) * total_collateral`. No oracle needed — the price is derived directly from onchain state.

### Why This Works

- **No oracles** — Collateral ratio is onchain math, not a price feed
- **No liquidations** — The burn mechanism guarantees solvency
- **No idle capital** — The token's backing IS the lending pool
- **Fee recycling** — Origination fees go back into the Glue, increasing backing for all remaining holders

## Deep Dive

### The Core Idea: Burn = Borrow, Mint = Repay

In Glue Protocol, every Sticky Asset has a **Glue contract** holding collateral (ETH, USDC, anything). Any token holder can **burn** their tokens and receive a proportional share of that collateral. This is the "unglue" mechanism — it's how Glue creates a price floor.

GlueLend hijacks this mechanism to create lending:

- **Burning tokens extracts collateral.** Normally that's a one-way trip — tokens are gone, collateral is yours. But GlueLend's `GlueLendToken` has a special `mint` function restricted to the `GlueLend` contract. So the protocol can mint tokens back when you return the collateral.
- **The debt is the collateral itself.** When you borrow, the protocol records exactly how much collateral came out of the Glue. To repay, you send that same collateral back. No interest rate, no variable APY — just return what you took, get your tokens back.

This creates a full borrowing cycle with no pools, no oracles, and no liquidation risk.

### Step by Step: Creating a Token

1. **Deploy `GlueLendToken`** with a name, symbol, and initial supply. The constructor inherits `StickyAsset`, which automatically calls `applyTheGlue` on the GlueStick factory. This creates a dedicated Glue contract for your token.

2. **Deploy `GlueLend`** with an origination fee (e.g. `1e16` = 1%). This is the lending contract that will manage borrow/repay logic.

3. **Wire them together:**
   - `token.setCollateralManager(glueLendAddress)` — gives GlueLend permission to mint tokens
   - `token.lockCollateralManager()` — permanently locks this, so nobody (not even the owner) can change it
   - `glueLend.registerToken(tokenAddress)` — tells GlueLend about the token and its Glue contract

4. **Fund the Glue.** Send ETH (or any ERC20) directly to the token's Glue contract address. This is the collateral that backs the token. Anyone can fund it at any time.

Now the token has a collateral floor. If 1,000,000 tokens exist and the Glue holds 10 ETH, each token is backed by 0.00001 ETH.

### Step by Step: Borrowing

Say you hold 10,000 tokens and the Glue holds 10 ETH with 1,000,000 total supply.

1. You call `glueLend.borrow(token, 10000, [ETH_ADDRESS], [0])`.
2. GlueLend pulls 10,000 tokens from your wallet.
3. GlueLend approves the Glue contract and calls `unglue` — burning the tokens and receiving collateral.
4. The Glue calculates your share: `(10,000 / 1,000,000) * 10 ETH = 0.1 ETH` minus the 0.1% Glue protocol fee.
5. GlueLend takes its origination fee (1%) from what came out and sends the fee back into the Glue — increasing the backing for everyone else.
6. The remaining collateral is sent to your wallet.
7. Your loan position is recorded: 10,000 tokens burned, X collateral owed.

You now have ETH in your wallet. Your tokens are gone (burned). The protocol remembers your debt.

### Step by Step: Repaying

1. You call `glueLend.repay(token)` and send the recorded collateral amount as `msg.value` (for ETH).
2. GlueLend sends the collateral back into the Glue contract, restoring the backing.
3. GlueLend calls `token.mint(you, 10000)` — minting your tokens back.
4. Your loan position is cleared.

You have your tokens again. The Glue has its collateral again. The only thing that changed: the origination fee made the Glue slightly richer, meaning every remaining token is now backed by slightly more collateral.

You can also call `partialRepay` to return a portion of your debt — the protocol calculates the proportional collateral owed and mints back the corresponding fraction of tokens.

### The Fee Flywheel

This is the elegant part. The 1% origination fee doesn't go to a treasury or a team wallet. It goes back into the Glue contract. That means:

- Every borrow increases the collateral-per-token ratio for remaining holders
- More borrowing activity = higher floor price for the token
- This creates a natural incentive: holders want borrowing to happen because it makes their tokens worth more

### Leverage Loops

Because borrowing gives you collateral and you can sell tokens on the open market to get more tokens to borrow again, you can loop:

1. Borrow (burn tokens, get ETH)
2. Buy more tokens on a DEX with that ETH
3. Borrow again (burn those tokens, get more ETH)
4. Repeat

Each loop accumulates your position in the `GlueLend` contract. When you repay, you repay the total accumulated collateral debt and get all your tokens minted back. This is useful for leveraged exposure to the token's price.

### The Math

All numbers use 18 decimal precision (`PRECISION = 1e18`).

**Borrow output:**
```
raw_collateral = (tokens_burned / total_supply) * glue_balance
glue_fee = raw_collateral * 0.1%
after_glue = raw_collateral - glue_fee
origination_fee = after_glue * 1%
user_receives = after_glue - origination_fee
```

**Example with real numbers:**
- Supply: 1,000,000 tokens
- Glue balance: 10 ETH
- Burn: 100,000 tokens (10% of supply)

```
raw_collateral = (100,000 / 1,000,000) * 10 = 1 ETH
glue_fee = 1 * 0.001 = 0.001 ETH
after_glue = 0.999 ETH
origination_fee = 0.999 * 0.01 = 0.00999 ETH
user_receives = 0.999 - 0.00999 = 0.98901 ETH
```

The origination fee (0.00999 ETH) goes back into the Glue. After this borrow, 900,000 tokens are backed by ~9.00999 ETH instead of 9 ETH — each remaining token is worth slightly more.

## Contracts

| Contract | Description |
|---|---|
| `GlueLendToken` | ERC20 + StickyAsset. Minting is restricted to the collateral manager (the GlueLend contract). |
| `GlueLend` | Core lending logic. Handles borrow, repay, partial repay, and fee collection. |
| `IGlueLendToken` | Mint interface used by GlueLend to mint tokens on repayment. |

## Setup

```bash
npm install
```

## Test

Tests fork Base Sepolia to access the live GlueStick factory.

```bash
npx hardhat test
```

## Deploy

```bash
npx hardhat run scripts/deploy.ts --network <network>
```

## Flow

```
1. Deploy GlueLendToken (name, symbol, initial supply)
2. Deploy GlueLend (1% origination fee)
3. Wire them:
   - token.setCollateralManager(glueLend)
   - token.lockCollateralManager()
   - glueLend.registerToken(token)
4. Fund the Glue contract with ETH (or any ERC20)
5. Users can now borrow/repay
```

## Networks

GlueLend works on any chain where Glue Protocol is deployed. GlueStick addresses are the same on all chains:

- **GlueStick ERC20:** `0x5fEe29873DE41bb6bCAbC1E4FB0Fc4CB26a7Fd74`
- **GlueStick ERC721:** `0xe9B08D7dC8e44F1973269E7cE0fe98297668c257`

Supported: Ethereum, Base, Optimism, Sepolia, Base Sepolia, OP Sepolia.

## License

MIT
