# OpenGate LaunchLab

Token launchpad and trading pools on BNB Chain, served at launchlab.opengate.bond.

Two modes:

- **New token** — create a token on a bonding curve. The price is set by a formula,
  not by a person: buying pushes it up, selling pulls it down. Once enough BNB is
  collected the token moves to PancakeSwap and its liquidity is locked forever.
- **Trading** — open a trading pool for a token you already hold, paired with BNB,
  USDT or USDC. The creator chooses whether the liquidity can be withdrawn again.

Companion repository: **OpenGate** (the social platform) — `Token1-ai/opengate-app`,
served at opengate.bond.

---

## How the project is laid out

No build step. Plain HTML, CSS and JavaScript plus serverless functions. Edit, push,
Vercel deploys.

```
index.html   the whole site (~280 KB, one file)
logo.png     logo
api/         serverless functions (Vercel)
```

### `api/`

| File | What it does |
| --- | --- |
| `launchpad.js` | reads and records bonding-curve trades, keeps the price chart |
| `pools.js` | the same for trading pools |
| `ads.js` | advertising: pricing, payment checks, moderation, the owner's wallet |

### Inside `index.html`

- `LAUNCHPAD_V3`, `POOLS_ADDRESS` — contract addresses
- `OWNER_WALLET_ADDR` and `loadOwnerAddr()` — the owner's wallet, fetched from the
  server rather than hard-coded, so advertising income follows the setting
- `function switchMode(` — switches between the two modes
- `drawTradeNow(` — draws a candle the moment a trade confirms, without waiting for
  the server

---

## Contracts (BNB Chain)

| Contract | Address |
| --- | --- |
| Launchpad V3 | `0x9740e2C9214965d68A731b1af49Ed1b5814664ff` |
| Trading pools V2 | `0x8923bF72154A10af579030162C6F945Df2F1b351` |
| Gold Pass (V2, current) | `0xCF2B61D76F2140D8270e612918DEE1501EcC637C` |
| Silver Pass (V2, current) | `0x543a0Bd90387768BE17E038ff685be7DD8d9791A` |
| Gold Pass (V1, retired) | `0x4D26Ec2f8edbb3F567953CC7573FF60cA009258c` |
| Silver Pass (V1, retired) | `0xeaDF62931f8ef2Ec546E77fBC5E56F1B3157Af89` |

Older versions (V1, V2) are still read so that tokens launched on them keep working.

**Ownership transfer** is two-step: `transferOwnership(newWallet)`, then
`acceptOwnership()` from the new wallet. **Never call `renounceOwnership`** — it
destroys ownership rather than transferring it.

---

## Fees

Read from the live contracts on 17 November 2026:

| Where | Total | Creator | Platform |
| --- | --- | --- | --- |
| Launchpad trades | 11% | 10% | 1% |
| Pool trades | 1% | 0.5% | 0.5% |

The split is adjustable through `setFees`, up to a ceiling fixed in the contract
(`MAX_FEE`). The creator's share is deliberately large: it is what attracts people to
launch tokens here.

Advertising is paid as a direct transfer to the owner's wallet — no contract in
between, the money arrives the same second. Prices are set in the owner's admin
panel.

---

## Settings (Vercel → Settings → Environment Variables)

| Name | What it is for |
| --- | --- |
| `PLATFORM_OWNER` | the owner's wallet: advertising income and admin rights |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | database access |
| `GOLD_PASS_CONTRACT`, `SILVER_PASS_CONTRACT` | the current pass contracts; `..._V1` for the retired ones |

After changing any of these press **Redeploy**.

To point advertising income at a different wallet, change `PLATFORM_OWNER` and
redeploy. Nothing in the code needs editing: the page asks the server for the
address and asks again immediately before every payment, so nobody can pay to a
stale one.

---

## Database

Supabase (PostgreSQL), the same project as OpenGate. Tables used here:

`launchpad_tokens`, `launchpad_trades`, `pool_tokens`, `pool_trades`,
`featured_tokens`, `ad_boards`, `ad_pricing`, `ad_promos`, `ad_promo_claims`,
`ad_blocked`, `ad_tx_used`.

A nightly job (`trim_old_trades`, 03:17 UTC) keeps 90 days of trade history in full
and thins anything older down to one record per hour.

---

## Running it

```bash
npx serve .        # pages only, no serverless functions
npm i -g vercel && vercel dev   # the real thing
```

Push to `main` and Vercel deploys. Nothing to compile.

---

## Known limitations

- **No security audit.** No outside firm has reviewed the contracts.
- **The Alchemy key in `index.html` is visible to anyone** who opens the site.
  Replace it with your own.
