function envNum(key, fallback) {
  const v = typeof process !== 'undefined' ? parseInt(process.env[key], 10) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

module.exports = {
  search: {
    // Ile wyników pobierać z YouTube search (ytsearch<N>:)
    ytSearchCount: envNum('YT_SEARCH_COUNT', 5),
    // Max ms przewagi za zgodność słów tytułu z track+artist (0..1 × titleBonus)
    titleBonus: envNum('TITLE_BONUS_MS', 15_000),
    // Ms przewagi gdy track/artysta ma znaki CJK i tytuł kandydata też je zawiera
    scriptBonus: envNum('SCRIPT_BONUS_MS', 10_000),
  },
  polling: {
    // Jak często serwer odpytuje Spotify (ms) i pushuje stan przez WebSocket
    spotifyMs: envNum('SPOTIFY_POLL_MS', 1_000),
    // Próg driftu progress_ms powyżej którego serwer wysyła broadcast (seek, buffering itp.)
    // Broadcast jest pomijany gdy |actual - expected| <= spotifyMs * driftFactor + driftBaseMs
    driftFactor: envNum('DRIFT_FACTOR_PCT', 15) / 100,
    driftBaseMs: envNum('DRIFT_BASE_MS', 1_000),
  },
  cache: {
    // Ustaw WARM_CACHE_ENABLED=0 aby wyłączyć warmer (domyślnie wyłączony)
    warmEnabled: process.env.WARM_CACHE_ENABLED !== '1',
    // Ile najczęściej granych tracków trzymać ciepłych w URL cache
    warmTopN: envNum('WARM_CACHE_TOP_N', 50),
    // Odświeżaj URL gdy pozostały TTL < N minut
    warmMinTtlM: envNum('WARM_CACHE_MIN_TTL_M', 15),
    // Ile kolejnych tracków z queues prefetchować (N+1 = pełny audio buffer, N+2..N+prefetchAhead = tylko URL)
    prefetchAhead: envNum('PREFETCH_AHEAD', 5),
  },
};
