// Netlify Function: proxies BALLDONTLIE NBA API and hides the API key.
// Tier: ALL-STAR (60 req/min). Designed to fit within Netlify's 10s
// function timeout by fanning seasons out concurrently.
// Set BDL_API_KEY in Netlify → Site settings → Environment variables.
//
// Routes:
//   /api/players?search=...
//   /api/player?id=...
//   /api/seasons?id=...
//   /api/teammates?id1=...&id2=...

const BASE = "https://api.balldontlie.io/nba/v1";

const MODERN_START = 2000;
const HISTORY_START = 1996;
const CURRENT_SEASON = 2025; // 2025-26 season

// Concurrency limit. balldontlie ALL-STAR allows 60 req/min sliding window.
// We fan out up to 12 in parallel — for a 25-season walk that uses ~25 calls
// in roughly 1-2 seconds, well under the per-minute window.
const CONCURRENCY = 12;

// Per-instance cache. 24h TTL — teammate graphs barely change mid-season.
const cache = new Map();
const TTL = 1000 * 60 * 60 * 24;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > TTL) { cache.delete(key); return null; }
  return hit.v;
}
function cacheSet(key, v) { cache.set(key, { v, t: Date.now() }); }

async function bdl(path, key) {
  const ck = `bdl:${path}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const r = await fetch(BASE + path, { headers: { Authorization: key } });

  if (r.status === 429) {
    // Brief backoff + one retry
    await new Promise(res => setTimeout(res, 1500));
    const r2 = await fetch(BASE + path, { headers: { Authorization: key } });
    if (!r2.ok) throw new Error(`BDL ${r2.status}: rate limited`);
    const j = await r2.json();
    cacheSet(ck, j);
    return j;
  }
  if (!r.ok) throw new Error(`BDL ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  cacheSet(ck, j);
  return j;
}

// Run an array of async tasks with bounded concurrency.
async function runWithLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch (e) {
        results[idx] = { __error: e.message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Build a player's set of (season, team_id) pairs by fanning out across
// candidate seasons in parallel. ~25 seasons × concurrency 12 ≈ 2-3 seconds.
async function playerSeasons(id, key, { fullHistory = false } = {}) {
  const ck = `seasons:v4:${id}:${fullHistory ? "full" : "modern"}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  // Get draft year to narrow the search window
  let draftYear = null;
  try {
    const p = await bdl(`/players/${id}`, key);
    draftYear = p?.data?.draft_year ?? null;
  } catch { /* non-fatal */ }

  const startSeason = Math.max(
    fullHistory ? HISTORY_START : MODERN_START,
    draftYear ? draftYear - 1 : (fullHistory ? HISTORY_START : MODERN_START)
  );

  const seasons = [];
  for (let s = startSeason; s <= CURRENT_SEASON; s++) seasons.push(s);

  // One task per season — each fetches the first page of /stats for that
  // player+season. We only need to know which teams they appeared for.
  const tasks = seasons.map(season => async () => {
    const q = new URLSearchParams();
    q.append("player_ids[]", id);
    q.append("seasons[]", season);
    q.set("per_page", "100");
    const j = await bdl(`/stats?${q.toString()}`, key);
    const teams = new Set();
    for (const row of (j?.data || [])) {
      if (row?.team?.id != null) teams.add(row.team.id);
    }
    return { season, teams: [...teams] };
  });

  const results = await runWithLimit(tasks, CONCURRENCY);

  const pairs = [];
  for (const r of results) {
    if (!r || r.__error) continue;
    for (const tid of r.teams) {
      pairs.push({ season: r.season, team_id: tid });
    }
  }

  cacheSet(ck, pairs);
  return pairs;
}

const corsHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
  "Access-Control-Allow-Origin": "*"
};

exports.handler = async (event) => {
  const KEY = process.env.BDL_API_KEY;
  if (!KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "BDL_API_KEY not set in Netlify env vars" })
    };
  }

  const raw = event.path || "";
  const route = raw.split("/").filter(Boolean).pop() || "";
  const qs = event.queryStringParameters || {};
  const fullHistory = qs.full === "1" || qs.full === "true";

  try {
    if (route === "players") {
      const search = (qs.search || "").trim();
      if (!search) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "search required" }) };
      const j = await bdl(`/players?search=${encodeURIComponent(search)}&per_page=25`, KEY);
      const data = (j.data || []).map(p => ({
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        position: p.position,
        draft_year: p.draft_year,
        team: p.team ? { id: p.team.id, full_name: p.team.full_name, abbreviation: p.team.abbreviation } : null
      }));
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ data }) };
    }

    if (route === "player") {
      const id = qs.id;
      if (!id) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "id required" }) };
      const j = await bdl(`/players/${encodeURIComponent(id)}`, KEY);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(j) };
    }

    if (route === "seasons") {
      const id = qs.id;
      if (!id) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "id required" }) };
      const seasons = await playerSeasons(id, KEY, { fullHistory });
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ data: seasons }) };
    }

    if (route === "teammates") {
      const { id1, id2 } = qs;
      if (!id1 || !id2) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "id1 & id2 required" }) };

      // Fetch both players' season data IN PARALLEL to fit in 10s timeout.
      // Each player walk uses internal concurrency=12. Two players in parallel
      // bursts up to 24 concurrent requests, which is tight but safe under
      // 60/min for a one-shot lookup.
      const [a, b] = await Promise.all([
        playerSeasons(id1, KEY, { fullHistory }),
        playerSeasons(id2, KEY, { fullHistory })
      ]);
      const setB = new Set(b.map(p => `${p.season}:${p.team_id}`));
      const overlap = a.filter(p => setB.has(`${p.season}:${p.team_id}`));

      // Distinct seasons count for rarity scoring (used by client)
      const aSeasonCount = new Set(a.map(p => p.season)).size;
      const bSeasonCount = new Set(b.map(p => p.season)).size;

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          teammates: overlap.length > 0,
          overlap,
          a_seasons: aSeasonCount,
          b_seasons: bSeasonCount
        })
      };
    }

    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: `unknown route: ${route}` }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
