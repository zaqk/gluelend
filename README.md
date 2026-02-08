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
