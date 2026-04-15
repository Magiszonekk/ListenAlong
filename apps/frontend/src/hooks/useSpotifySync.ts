import { useCallback, useEffect, useRef, useState } from 'react';

// Client ID persisted in localStorage — same ID across tabs and sessions
function getClientId(): string {
  let id = localStorage.getItem('clientId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('clientId', id);
  }
  return id;
}

export const clientId = getClientId();
export const clientShort = clientId.slice(0, 6);

function applyStoredVolume(el: HTMLAudioElement) {
  const v = parseFloat(localStorage.getItem('audioVolume') ?? '1');
  el.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  el.muted = localStorage.getItem('audioMuted') === 'true';
}

// Wrap fetch to always send X-Client-Id for same-origin requests
const _fetch = window.fetch.bind(window);
window.fetch = (url: RequestInfo | URL, opts: RequestInit = {}) => {
  if (typeof url === 'string' && url.startsWith('/')) {
    opts = { ...opts, headers: { 'X-Client-Id': clientId, ...(opts.headers ?? {}) } };
  }
  return _fetch(url, opts);
};

export function log(msg: string) {
  const tagged = `[${clientShort}] ${msg}`;
  console.log(tagged);
  fetch('/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg: tagged }),
  }).catch(() => {});
}

function logEvent(action: string, trackId?: string | null) {
  fetch('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, trackId: trackId ?? null }),
  }).catch(() => {});
}

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

interface NowPlaying {
  track: string;
  artist: string;
  track_id: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  auth_error?: boolean;
  serverAge?: number;
}

interface QueueTrack {
  track: string;
  artist: string;
  track_id: string;
  duration_ms: number;
}

export function useSpotifySync() {
  const isDev = localStorage.getItem('dev') === 'true';

  const [started, setStarted] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const [trackName, setTrackName] = useState('—');
  const [artistName, setArtistName] = useState('—');
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('Kliknij Start aby zsynchronizować.');
  const [isListeningPaused, setIsListeningPaused] = useState(false);
  const listeningPausedRef = useRef(false);
  const programmaticPauseRef = useRef(false);
  const spotifyPausedRef = useRef(false);
  const wasSpotifyPlayingRef = useRef<boolean | null>(null);

  function pauseProgrammatic(audio: HTMLAudioElement | null | undefined) {
    if (!audio) return;
    programmaticPauseRef.current = true;
    audio.pause();
  }

  function attachAudioListeners(el: HTMLAudioElement) {
    el.addEventListener('pause', () => {
      if (programmaticPauseRef.current) { programmaticPauseRef.current = false; return; }
      if (el.ended) return; // natural end, not user action
      listeningPausedRef.current = true;
      setIsListeningPaused(true);
      setStatus('Słuchanie wstrzymane.');
      logEvent('pause', currentTrackIdRef.current);
    });
    el.addEventListener('play', () => {
      if (listeningPausedRef.current) {
        listeningPausedRef.current = false;
        setIsListeningPaused(false);
        setStatus('In sync.');
        logEvent('resume', currentTrackIdRef.current);
      }
    });
    el.addEventListener('volumechange', () => {
      localStorage.setItem('audioVolume', String(el.volume));
      localStorage.setItem('audioMuted', String(el.muted));
    });
    el.addEventListener('error', () => {
      const videoId = currentVideoIdRef.current;
      if (!videoId) return;
      if (el.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        // 500 JSON from backend — ?fresh=1 won't help, would create an infinite retry loop
        log(`[error] audio format error (code=4) for ${videoId} — cannot recover with fresh URL`);
        setStatus('Stream error.');
        return;
      }
      log(`[error] audio stream error (code=${el.error?.code}) — refreshing URL for ${videoId}`);
      setStatus('Stream error — refreshing...');
      el.src = `/youtube/audio/${videoId}?fresh=1`;
      el.load();
      if (!listeningPausedRef.current) el.play().catch(() => {});
    });
  }
  const [listenerCount, setListenerCount] = useState<number | null>(null);
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [trackNotIdeal, setTrackNotIdeal] = useState(false);
  const [trackBugged, setTrackBugged] = useState(false);
  const [trackAllSourcesTried, setTrackAllSourcesTried] = useState(false);
  const [trackSource, setTrackSource] = useState('');
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Audio element is managed as a mutable ref — we swap it in the DOM directly
  const audioRef = useRef<HTMLAudioElement>(null);

  const currentTrackIdRef = useRef<string | null>(null);
  const currentVideoIdRef = useRef<string | null>(null);

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(1000);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Last WS now_playing state — used for fresh position on canplay
  const lastNowPlayingRef = useRef<NowPlaying | null>(null);
  const lastWsTimestampRef = useRef<number>(0);

  // Measured round-trip time to server in ms (EWMA-smoothed)
  const pingMsRef = useRef<number>(0);

  // User-defined sync compensation in ms (persisted in localStorage)
  const compensationMsRef = useRef<number>(parseFloat(localStorage.getItem('syncCompensation') ?? '0') || 0);

  // Prefetch state
  const prefetchTrackIdRef = useRef<string | null>(null);
  const prefetchVideoIdRef = useRef<string | null>(null);
  const prefetchAudioRef = useRef<HTMLAudioElement>(new Audio());
  const prefetchReadyRef = useRef(false);
  prefetchAudioRef.current.preload = 'auto';

  // --- DOM swap helpers ---

  function swapIntoPlayer(el: HTMLAudioElement) {
    const audio = audioRef.current!;
    pauseProgrammatic(audio);
    el.id = 'audio-player';
    el.controls = true;
    el.className = audio.className;
    audio.parentNode!.replaceChild(el, audio);
    // Update ref — replaceChild swapped the node in DOM; update our ref manually
    (audioRef as React.RefObject<HTMLAudioElement>).current = el;
    attachAudioListeners(el);
    applyStoredVolume(el);
    if (!listeningPausedRef.current) {
      el.play().catch((err: Error) => {
        log(`[error] play() rejected: ${err.message}`);
        setStatus('Playback error: ' + err.message);
      });
    }
    setStatus('In sync.');
  }

  function seekThenSwap(el: HTMLAudioElement, t: number) {
    el.currentTime = t;
    const doSwap = () => swapIntoPlayer(el);
    el.addEventListener('seeked', doSwap, { once: true });
    setTimeout(() => {
      el.removeEventListener('seeked', doSwap);
      swapIntoPlayer(el); // fallback — drift correction will re-sync
    }, 2000);
  }

  // --- Prefetch ---

  const prefetchNext = useCallback(async (next: QueueTrack | null) => {
    if (!next || prefetchTrackIdRef.current === next.track_id) return;
    log(`[debug] prefetchNext: ${next.track} (${next.track_id})`);
    prefetchTrackIdRef.current = next.track_id;
    prefetchVideoIdRef.current = null;
    prefetchReadyRef.current = false;

    try {
      const res = await fetch(
        `/youtube/search?track=${encodeURIComponent(next.track)}&artist=${encodeURIComponent(next.artist)}&duration_ms=${next.duration_ms}&track_id=${encodeURIComponent(next.track_id)}`
      );
      const data = await res.json();
      if (!data.videoId) {
        log(`[debug] prefetchNext: no match for ${next.track}`);
        return;
      }
      prefetchVideoIdRef.current = data.videoId;
      fetch(`/youtube/prefetch/${data.videoId}`);
      const pa = prefetchAudioRef.current;
      pa.addEventListener('canplay', () => { prefetchReadyRef.current = true; }, { once: true });
      pa.src = `/youtube/audio/${data.videoId}`;
      pa.load();
      log(`[prefetch] buffering next: ${next.track} → ${data.videoId}`);
    } catch (_) {}
  }, []);

  // --- Load track ---

  const loadTrack = useCallback(async (data: NowPlaying, spotifySec: number) => {
    log(`[debug] loadTrack called for: ${data.track} (${data.track_id}), prefetchTrackId=${prefetchTrackIdRef.current}, prefetchVideoId=${prefetchVideoIdRef.current}`);

    if (prefetchVideoIdRef.current && prefetchTrackIdRef.current === data.track_id) {
      log(`[debug] prefetch hit, prefetchReady=${prefetchReadyRef.current}`);
      currentVideoIdRef.current = prefetchVideoIdRef.current;
      const pa = prefetchAudioRef.current;

      if (prefetchReadyRef.current) {
        seekThenSwap(pa, spotifySec);
        const newPa = new Audio();
        newPa.preload = 'auto';
        prefetchAudioRef.current = newPa;
      } else {
        const expectedTrackId = data.track_id;
        const expectedVideoId = prefetchVideoIdRef.current;
        setStatus('Buffering...');
        pa.addEventListener('canplay', () => {
          if (currentTrackIdRef.current !== expectedTrackId || prefetchVideoIdRef.current !== expectedVideoId) {
            log(`[debug] prefetchAudio canplay stale — skipping (expected ${expectedVideoId}/${expectedTrackId}, now ${prefetchVideoIdRef.current}/${currentTrackIdRef.current})`);
            return;
          }
          log(`[debug] prefetchAudio canplay fired, computing fresh position for ${expectedVideoId}...`);
          let sec = spotifySec;
          const lastWs = lastNowPlayingRef.current;
          const wsAgeMs = Date.now() - lastWsTimestampRef.current;
          if (lastWs?.track_id === expectedTrackId && lastWs.is_playing) {
            const halfRttSec = pingMsRef.current / 2 / 1000;
            sec = lastWs.progress_ms / 1000 + wsAgeMs / 1000 + halfRttSec + compensationMsRef.current / 1000;
            log(`[debug] fresh sync: ${sec.toFixed(2)}s (ws age ${wsAgeMs}ms + rtt/2 ${(halfRttSec * 1000).toFixed(1)}ms, fallback was ${spotifySec.toFixed(2)}s)`);
          }
          seekThenSwap(pa, sec);
          const newPa = new Audio();
          newPa.preload = 'auto';
          prefetchAudioRef.current = newPa;
        }, { once: true });
      }
      return;
    }

    log(`[debug] no prefetch, searching YouTube for: ${data.track} – ${data.artist}`);
    setStatus(`Searching for: ${data.track} – ${data.artist}...`);

    let ytData: { videoId: string | null };
    try {
      const res = await fetch(
        `/youtube/search?track=${encodeURIComponent(data.track)}&artist=${encodeURIComponent(data.artist)}&duration_ms=${data.duration_ms}&track_id=${encodeURIComponent(data.track_id)}`
      );
      ytData = await res.json();
    } catch (err) {
      setStatus('Search error: ' + (err as Error).message);
      return;
    }

    if (!ytData.videoId) {
      log(`[debug] no YouTube match for: ${data.track} – ${data.artist}`);
      setStatus('No matching track found on YouTube.');
      currentVideoIdRef.current = null;
      const audio = audioRef.current;
      if (audio) { pauseProgrammatic(audio); audio.src = ''; }
      return;
    }

    currentVideoIdRef.current = ytData.videoId;
    log(`[debug] found videoId=${ytData.videoId}, loading audio...`);
    setStatus('Loading audio...');

    const expectedTrackId = data.track_id;
    const newAudio = new Audio(`/youtube/audio/${ytData.videoId}`);
    newAudio.preload = 'auto';
    newAudio.addEventListener('canplay', () => {
      if (currentTrackIdRef.current !== expectedTrackId) {
        log(`[debug] canplay stale for ${ytData.videoId} — skipping (expected ${expectedTrackId}, now ${currentTrackIdRef.current})`);
        return;
      }
      log(`[debug] canplay fired for ${ytData.videoId}, computing fresh position...`);
      let sec = spotifySec;
      const lastWs = lastNowPlayingRef.current;
      const wsAgeMs = Date.now() - lastWsTimestampRef.current;
      if (lastWs?.track_id === expectedTrackId && lastWs.is_playing) {
        const halfRttSec = pingMsRef.current / 2 / 1000;
        sec = lastWs.progress_ms / 1000 + wsAgeMs / 1000 + halfRttSec + compensationMsRef.current / 1000;
        log(`[debug] fresh sync: ${sec.toFixed(2)}s (ws age ${wsAgeMs}ms + rtt/2 ${(halfRttSec * 1000).toFixed(1)}ms, fallback was ${spotifySec.toFixed(2)}s)`);
      }
      seekThenSwap(newAudio, sec);
    }, { once: true });
    let networkRetried = false;
    let altSearchCount = 0;
    const MAX_ALT_SEARCHES = 5;
    let currentFailedVideoId = ytData.videoId!;
    const failedVideoIds = new Set<string>([ytData.videoId!]);
    newAudio.addEventListener('error', async () => {
      const e = newAudio.error;
      log(`[error] newAudio failed for ${currentFailedVideoId}: code=${e?.code ?? '?'} message=${e?.message ?? '?'}`);

      if (currentTrackIdRef.current !== expectedTrackId) {
        setStatus('Audio load error.');
        currentVideoIdRef.current = null;
        currentTrackIdRef.current = null;
        return;
      }

      if (e?.code === MediaError.MEDIA_ERR_NETWORK && !networkRetried) {
        networkRetried = true;
        log(`[error] MEDIA_ERR_NETWORK — retrying with fresh URL for ${currentFailedVideoId}`);
        setStatus('Stream error — retrying...');
        newAudio.src = `/youtube/audio/${currentFailedVideoId}?fresh=1`;
        newAudio.load();
        return;
      }

      if (e?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && altSearchCount < MAX_ALT_SEARCHES) {
        altSearchCount++;
        const failedId = currentFailedVideoId;
        failedVideoIds.add(failedId);
        const blacklistParam = [...failedVideoIds].map(encodeURIComponent).join(',');
        log(`[error] MEDIA_ERR_SRC_NOT_SUPPORTED for ${failedId} — searching for alternative (attempt ${altSearchCount})`);
        setStatus('Finding alternative...');
        try {
          const res = await fetch(
            `/youtube/search?track=${encodeURIComponent(data.track)}&artist=${encodeURIComponent(data.artist)}&duration_ms=${data.duration_ms}&track_id=${encodeURIComponent(data.track_id)}&blacklist=${blacklistParam}`,
            { signal: AbortSignal.timeout(20000) }
          );
          const newYt: { videoId: string | null; allSourcesTried?: boolean } = await res.json();
          if (currentTrackIdRef.current !== expectedTrackId) return; // stale — track changed
          if (!newYt.allSourcesTried && newYt.videoId && !failedVideoIds.has(newYt.videoId)) {
            log(`[error] alternative found: ${newYt.videoId} — loading (attempt ${altSearchCount})`);
            currentVideoIdRef.current = newYt.videoId;
            currentFailedVideoId = newYt.videoId;
            networkRetried = false;
            newAudio.src = `/youtube/audio/${newYt.videoId}`;
            newAudio.load();
            return;
          }
        } catch (_) {}
        log(`[error] no alternative found for ${data.track_id} after ${altSearchCount} attempt(s)`);
        setStatus('No alternative available.');
        currentVideoIdRef.current = null;
        // Keep currentTrackIdRef as expectedTrackId to prevent re-trigger loop on next poll
        return;
      }

      setStatus('Audio load error.');
      currentVideoIdRef.current = null;
      currentTrackIdRef.current = null;
    });
    newAudio.load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Handle now_playing from WebSocket ---

  const handleNowPlaying = useCallback(async (data: NowPlaying) => {
    lastNowPlayingRef.current = data;
    lastWsTimestampRef.current = Date.now() - (data.serverAge ?? 0);
    if (data.auth_error) {
      setIsAuthenticated(false);
      setStatus('Not authenticated — please log in.');
      return;
    }

    setIsAuthenticated(true);

    if (!data.is_playing) {
      if (wasSpotifyPlayingRef.current === true) logEvent('spotify_pause', currentTrackIdRef.current);
      wasSpotifyPlayingRef.current = false;
      setStatus('Spotify is paused or nothing is playing.');
      pauseProgrammatic(audioRef.current);
      spotifyPausedRef.current = true;
      setIsPlaying(false);
      return;
    }

    if (wasSpotifyPlayingRef.current === false) {
      logEvent('spotify_play', currentTrackIdRef.current);
      if (spotifyPausedRef.current) {
        spotifyPausedRef.current = false;
        listeningPausedRef.current = false;
        setIsListeningPaused(false);
      }
    }
    wasSpotifyPlayingRef.current = true;
    setTrackName(data.track);
    setArtistName(data.artist);
    setIsPlaying(data.is_playing);
    const spotifySec = data.progress_ms / 1000 + compensationMsRef.current / 1000;

    if (data.track_id !== currentTrackIdRef.current) {
      log(`\n--- ${data.track} – ${data.artist} ---`);
      log(`[debug] track changed: ${currentTrackIdRef.current} → ${data.track_id} (${data.track})`);
      currentTrackIdRef.current = data.track_id;
      setTrackNotIdeal(false);
      setTrackBugged(false);
      setTrackAllSourcesTried(false);
      setTrackSource('');
      await loadTrack(data, spotifySec);
      // queue arrives separately via 'queue' WS message → prefetchNext
      fetch(`/youtube/track/${data.track_id}`)
        .then((r) => r.ok ? r.json() : null)
        .then((t) => {
          if (t) {
            setTrackNotIdeal(t.not_ideal);
            setTrackBugged(t.bugged);
            setTrackAllSourcesTried(t.allSourcesTried);
            setTrackSource(t.source ?? '');
          }
        })
        .catch(() => {});
    } else {
      if (currentVideoIdRef.current) {
        const audio = audioRef.current;
        if (audio) {
          if (audio.ended) {
            setStatus('Czekam na następny utwór...');
          } else {
            const adjustedSec = spotifySec + pingMsRef.current / 2 / 1000;
            const drift = Math.abs(audio.currentTime - adjustedSec);
            if (drift > 2) {
              setStatus(`Correcting drift (${drift.toFixed(1)}s)...`);
              audio.currentTime = adjustedSec;
            } else {
              setStatus('In sync.');
            }
            if (audio.paused && !listeningPausedRef.current) audio.play().catch(() => {});
          }
        }
      }
    }
  }, [loadTrack]);

  // --- WebSocket connection ---

  const connectWebSocket = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = 1000;
      ws.send(JSON.stringify({ type: 'identify', clientId }));
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }, 25000);
      log('[ws] connected');
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data as string); } catch { return; }
      if (msg.type === 'now_playing') handleNowPlaying(msg as unknown as NowPlaying);
      else if (msg.type === 'pong' && typeof msg.ts === 'number') {
        const rtt = Date.now() - (msg.ts as number);
        pingMsRef.current = pingMsRef.current === 0 ? rtt : 0.7 * pingMsRef.current + 0.3 * rtt;
        log(`[ping] rtt=${rtt}ms smoothed=${pingMsRef.current.toFixed(1)}ms`);
      }
      else if (msg.type === 'queue') prefetchNext((msg.next as QueueTrack | null));
      else if (msg.type === 'listeners') {
        setListenerCount(msg.count as number);
        setClientIds((msg.clientIds as string[]) ?? []);
      }
    };

    ws.onclose = () => {
      log(`[ws] disconnected — retry in ${reconnectDelayRef.current}ms`);
      setStatus('Reconnecting...');
      if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
        connectWebSocket();
      }, reconnectDelayRef.current);
    };

    ws.onerror = (err) => {
      log(`[ws] error: ${(err as ErrorEvent).message}`);
      ws.close();
    };
  }, [handleNowPlaying, prefetchNext]);

  const start = useCallback(() => {
    setStarted(true);
    logEvent('start');
  }, []);

  const showFeedback = useCallback(() => {
    setFeedbackMsg('Dziękujemy za feedback! Przy następnym razie wyszukamy innej wersji.');
    setTimeout(() => setFeedbackMsg(null), 5000);
  }, []);

  const markNotIdeal = useCallback(() => {
    const id = currentTrackIdRef.current;
    if (!id) return;
    setTrackNotIdeal(true);
    setTrackBugged(false);
    logEvent('not_ideal', id);
    fetch(`/youtube/track/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not_ideal: true }),
    }).catch(() => {});
    showFeedback();
  }, [showFeedback]);

  const markBugged = useCallback(() => {
    const id = currentTrackIdRef.current;
    if (!id) return;
    setTrackBugged(true);
    setTrackNotIdeal(false);
    logEvent('bug', id);
    fetch(`/youtube/track/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bugged: true }),
    }).catch(() => {});
    showFeedback();
  }, [showFeedback]);

  const forceSync = useCallback(() => {
    const audio = audioRef.current;
    const lastWs = lastNowPlayingRef.current;
    if (!audio || !lastWs) return;
    const elapsedMs = Date.now() - lastWsTimestampRef.current;
    const adjustedSec = lastWs.progress_ms / 1000 + elapsedMs / 1000 + pingMsRef.current / 2 / 1000 + compensationMsRef.current / 1000;
    audio.currentTime = adjustedSec;
  }, []);

  const setCompensationMs = useCallback((ms: number) => {
    compensationMsRef.current = ms;
    localStorage.setItem('syncCompensation', String(ms));
  }, []);

  const getPlayerProgress = useCallback(() => {
    return audioRef.current?.currentTime ?? 0;
  }, []);

  const getSpotifyProgress = useCallback(() => {
    const lastWs = lastNowPlayingRef.current;
    if (!lastWs) return 0;
    const elapsedMs = Date.now() - lastWsTimestampRef.current;
    return lastWs.progress_ms / 1000 + elapsedMs / 1000;
  }, []);

  useEffect(() => {
    const handleUnload = () => {
      navigator.sendBeacon(
        '/events',
        new Blob(
          [JSON.stringify({ action: 'exit', trackId: currentTrackIdRef.current, clientId })],
          { type: 'application/json' }
        )
      );
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  useEffect(() => {
    if (!started) return;
    if (audioRef.current) {
      attachAudioListeners(audioRef.current);
      applyStoredVolume(audioRef.current);
    }
    connectWebSocket();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [started, connectWebSocket]);

  return {
    started,
    start,
    isAuthenticated,
    trackName,
    artistName,
    isPlaying,
    status,
    listenerCount,
    clientIds,
    audioRef,
    isListeningPaused,
    trackNotIdeal,
    trackBugged,
    trackAllSourcesTried,
    trackSource,
    feedbackMsg,
    markNotIdeal,
    markBugged,
    isDev,
    forceSync,
    getPlayerProgress,
    getSpotifyProgress,
    setCompensationMs,
  };
}
