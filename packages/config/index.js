function envNum(key, fallback) {
  const v = typeof process !== 'undefined' ? parseInt(process.env[key], 10) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

module.exports = {
  search: {
    // Ms przewagi dla kandydata znalezionego przez Odesli (bezpośrednie mapowanie Spotify→YT)
    odesliBonus: envNum('ODESLI_BONUS_MS', 20_000),
    // Max ms przewagi za zgodność słów tytułu z track+artist (0..1 × titleBonus)
    titleBonus: envNum('TITLE_BONUS_MS', 15_000),
    // Ms przewagi gdy track/artysta ma znaki CJK i tytuł kandydata też je zawiera
    scriptBonus: envNum('SCRIPT_BONUS_MS', 10_000),
  },
  polling: {
    // Jak często odpytywać /spotify/now-playing (ms)
    spotifyMs: envNum('SPOTIFY_POLL_MS', 3_000),
    // Jak często odpytywać /clients dla liczby słuchaczy (ms)
    listenersMs: envNum('LISTENERS_POLL_MS', 20_000),
  },
};
