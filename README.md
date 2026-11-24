[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/Iqblhkim/token-launch-radar-01-radar3/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/Iqblhkim/token-launch-radar-01-radar3/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — radar-3

An entry for [make.fun's "Build the best token launch radar" bounty](https://make.fun/bounty/token-radar-01) ($1,325 USDC). It reads the sealed DefiLlama snapshot, ranks the 198 pre-token protocols by a fitted implied launch value, and shows how to farm each one.

## What it does

- **Value model, fitted not hardcoded.** ln(market cap) is regressed on ln(TVL) over the 95 traded protocols (intercept 8.1261, ln(TVL) 0.4567). Every extra term (growth, age, chains, category) was tested and kept only if it lowered BOTH leave-one-out and walk-forward miss — none did, so only ln(TVL) survived. Held-out miss: LOO ×3.228, walk-forward ×2.59, against a one-fixed-multiple baseline of ×4.998 / ×5.296.
- **Token odds from the peers' record.** A logistic model on 384 peers (base rate 0.216) picks the age model (Brier 0.1564 vs 0.1703 for the base rate). Protocols with no listing date get the base rate.
- **Farm plans with costed verdicts.** The airdrop pool (odds × implied × share) is split among active farmers; the farmer count grows with the square root of TVL (2500 farmers per sqrt of TVL in $M). At the stated assumptions (deposit $1,000, horizon 12 weeks, share 0.3, APY 4.5%): FARM 63, MARGINAL 80, SKIP 55. The dashboard lets a reader change the assumptions and the verdicts move.
- **Full accounting.** All 758 snapshot protocols sit in exactly one group: 198 ranked, 128 already trade, 288 token with no usable market cap, 144 set aside with a stated reason. Checksum 3c5c96d9.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only. Deterministic: two runs produce byte-identical `board.json` and `dossier.json`.

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the radar, writes `board.json`, `data.js`, and `dossier.json`.
- `lib/model.ts` — the radar: snapshot parsing, fitted value model, token odds, farm economics, board gate.
- `vendor/makefun-board.ts` — dossier builder (from the kit).
- `dashboard/` — the page: `index.html`, `app.css`, `app.js` (static, no network).
- `screenshots/` — three renders of the dashboard.
