# NBA LINEAGE

A daily NBA chain puzzle. Connect two players by typing teammates between them — same team, same season.

## Deploy to Netlify

1. Get your API key from https://app.balldontlie.io (you're on the **ALL-STAR** tier — 60 req/min)
2. Drag the **entire `nba-lineage` folder** into Netlify's drop zone at https://app.netlify.com/drop
3. After deploy, go to **Site settings → Environment variables**
4. Add: `BDL_API_KEY` = your balldontlie key (no quotes, no `Bearer` prefix, just the key)
5. Trigger a redeploy: **Deploys → Trigger deploy → Clear cache and deploy site**

Done.

## Folder structure

```
nba-lineage/
├── index.html              ← the game
├── netlify.toml            ← Netlify config
└── netlify/
    └── functions/
        └── bdl.js          ← API key proxy
```

## Performance

The proxy fans out season lookups in parallel (up to 12 concurrent calls) so a typical first-time teammate check on a star player completes in **2–4 seconds**, well within Netlify's free-tier 10-second function timeout. Subsequent checks involving the same players are instant via the in-memory cache.

The boot sequence pre-warms the cache for the start and end players in the background while you're typing your first guess, which hides most latency on the closing leg of the chain.

## How scoring works

- **Efficiency**: `1000 / steps^1.4` — fewer hops, higher score. The minimum chain (start → middle → end) maxes this out.
- **Rarity**: each non-superstar adds bonus points. Players with shorter NBA careers score as rarer.
- **Final**: `efficiency + rarity × 25`

## Daily puzzle

Same pair for everyone on the same calendar day. The pool has 14 hand-picked pairings that cycle by date. The front-end resolves player names → API IDs at load time via search, so even if balldontlie renumbers their database the game keeps working.

## Modern vs Full History

The "FULL HISTORY" toggle expands the season scan from 2000+ back to 1996 (the earliest season balldontlie supports cleanly for stats). Off by default to keep first-time lookups faster.

## Troubleshooting

- **"BDL_API_KEY not set"** → You skipped step 4. Add the env var and redeploy with cache cleared.
- **"FAILED TO LOAD PUZZLE"** → Check function logs in Netlify (Functions tab → bdl → Recent invocations). 401 = wrong key; 429 = rate limit hit (wait a minute and retry).
- **502 / function timeout** → Should be very rare with the parallel fetch design, but if it happens consistently for one player, lower `CONCURRENCY` in `bdl.js` from 12 to 8 (slightly slower but lighter on the rate limit).

## Costs

- **balldontlie ALL-STAR**: $9.99/mo
- **Netlify free tier**: handles this easily (125k function invocations/month included; this game uses maybe 50–200/day)
