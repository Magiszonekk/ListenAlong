function envNum(key, fallback) {
  const v = typeof process !== 'undefined' ? parseInt(process.env[key], 10) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

module.exports = {
  search: {
    // Ile wyników pobierać z YouTube search (ytsearch<N>:)
    ytSearchCount: envNum('YT_SEARCH_COUNT', 5),
    // Ms przewagi dla kandydata znalezionego przez Odesli (bezpośrednie mapowanie Spotify→YT)
    odesliBonus: envNum('ODESLI_BONUS_MS', 5_000),
    // Max ms przewagi za zgodność słów tytułu z track+artist (0..1 × titleBonus)
    titleBonus: envNum('TITLE_BONUS_MS', 15_000),
    // Ms przewagi gdy track/artysta ma znaki CJK i tytuł kandydata też je zawiera
    scriptBonus: envNum('SCRIPT_BONUS_MS', 10_000),
  },
  polling: {
    // Jak często serwer odpytuje Spotify (ms) i pushuje stan przez WebSocket
    spotifyMs: envNum('SPOTIFY_POLL_MS', 3_000),
    // Próg driftu progress_ms powyżej którego serwer wysyła broadcast (seek, buffering itp.)
    // Broadcast jest pomijany gdy |actual - expected| <= spotifyMs * driftFactor + driftBaseMs
    driftFactor: envNum('DRIFT_FACTOR_PCT', 15) / 100,
    driftBaseMs: envNum('DRIFT_BASE_MS', 1_000),
  },
};
