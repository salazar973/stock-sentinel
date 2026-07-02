# Stock Sentinel — cloud (self-learning paper trader)

An always-on **paper-trading** bot that runs on GitHub Actions with your computer off.
It scans ~20 large-cap US stocks on live Finnhub quotes, breeds a population of
EMA-crossover strategies, keeps the winners each generation, and trades the **champion**
with pretend money. A read-only dashboard (`index.html`) shows it live.

> **Simulated money only.** Nothing real is ever bought or sold. This is for learning
> what an unattended strategy actually does over weeks — not a green light to trade real money.

## What's in here
| File | Role |
|------|------|
| `bot.js` | The engine. One tick per run: fetch quotes → learn → trade champion → write `state.json`. Dependency-free (Node 18+). |
| `.github/workflows/bot.yml` | Runs `bot.js` every 5 minutes and commits `state.json` back. |
| `state.json` | The bot's memory (portfolio, trades, strategy population, champion, price history). |
| `index.html` | Read-only dashboard. Reads `state.json`. Does **not** need to be open for the bot to run. |

## One-time setup

**1. Get a free Finnhub key** — https://finnhub.io/register (email only, no card). Copy the key.

**2. Make a new GitHub repo** and push these four files (keep the folder layout, incl. `.github/workflows/bot.yml`).
```bash
git init && git add . && git commit -m "stock sentinel cloud"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

**3. Add the key as a repo secret** — repo **Settings → Secrets and variables → Actions → New repository secret**:
- Name: `FINNHUB_KEY`
- Value: your Finnhub key

**4. Enable + start Actions** — open the **Actions** tab, enable workflows if prompted, pick
**stock-sentinel → Run workflow** to fire the first run now (don't wait for the cron).

**5. See it live** — turn on **Settings → Pages → Source: Deploy from branch → `main` / root**.
Your dashboard is then at `https://<you>.github.io/<repo>/` and reads `state.json` automatically.
(Or open `index.html` locally and paste the raw `state.json` URL into the box at the top.)

## What to expect
- **Learns slowly, on purpose.** A 5-minute cron gives ~78 price samples per trading day, so the
  swarm evolves over **days and weeks**, not minutes. The honest verdict is the win rate after it's
  run unattended for a while.
- **Trades only during market hours** (9:30–4 ET, weekdays). Outside that it logs "waiting" and does nothing.
- **One position at a time**, all cash in/out, champion signals only.
- Watch a run: **Actions tab → latest run** prints `tick / gen / champion / equity / holding`.

## Tuning (top of `bot.js`)
`WATCH` (tickers), `POP`/`ELITE` (population), `GEN_TICKS` (how often it evolves),
`F_MIN..S_MAX` (EMA gene ranges). Shorter EMAs = more trades = more churn.

## Guardrails
- **Paper only by design.** Do not wire this to a real brokerage without a separate, deliberate decision — a bug in a real bot spends real money silently.
- The sim under-weights real frictions: spread, slippage, API downtime, and (for real accounts under $25k) the pattern-day-trader rule.
- GitHub notes: scheduled runs can be delayed a few minutes under load, and schedules pause after 60 days of repo inactivity (the bot's own commits keep it active).
