import { useCallback, useEffect, useRef, useState } from 'react';

// Per-tab client ID (persisted in sessionStorage for heartbeat tracking)
function getClientId(): string {
  let id = sessionStorage.getItem('clientId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('clientId', id);
  }
  return id;
}

const clientId = getClientId();
export const clientShort = clientId.slice(0, 6);

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

interface NowPlaying {
  track: string;
  artist: string;
  track_id: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
}

interface QueueTrack {
  track: string;
  artist: string;
  track_id: string;
  duration_ms: number;
}

export function useSpotifySync() {
  const [started, setStarted] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const [trackName, setTrackName] = useState('—');
  const [artistName, setArtistName] = useState('—');
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('Kliknij Start aby zsynchronizować.');
  const [isListeningPaused, setIsListeningPaused] = useState(false);
  const listeningPausedRef = useRef(false);
  const programmaticPauseRef = useRef(false);
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
  }
  const [listenerCount, setListenerCount] = useState<number | null>(null);
  const [trackNotIdeal, setTrackNotIdeal] = useState(false);
  const [trackBugged, setTrackBugged] = useState(false);
  const [trackAllSourcesTried, setTrackAllSourcesTried] = useState(false);
  const [trackSource, setTrackSource] = useState('');
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Audio element is managed as a mutable ref — we swap it in the DOM directly
  const audioRef = useRef<HTMLAudioElement>(null);

  const currentTrackIdRef = useRef<string | null>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const pollCountRef = useRef(0);

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
    (audioRef as React.MutableRefObject<HTMLAudioElement>).current = el;
    attachAudioListeners(el);
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

  const pollQueue = useCallback(async () => {
    try {
      const res = await fetch('/spotify/queue');
      const data = await res.json();
      prefetchNext(data.next);
    } catch (_) {}
  }, [prefetchNext]);

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
        setStatus('Buffering...');
        pa.addEventListener('canplay', () => {
          log(`[debug] prefetchAudio canplay fired, swapping to ${prefetchVideoIdRef.current}`);
          seekThenSwap(pa, spotifySec);
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

    const newAudio = new Audio(`/youtube/audio/${ytData.videoId}`);
    newAudio.preload = 'auto';
    newAudio.addEventListener('canplay', () => {
      log(`[debug] canplay fired for ${ytData.videoId}, seeking then swapping`);
      seekThenSwap(newAudio, spotifySec);
    }, { once: true });
    newAudio.addEventListener('error', () => {
      const e = newAudio.error;
      log(`[error] newAudio failed for ${ytData.videoId}: code=${e?.code ?? '?'} message=${e?.message ?? '?'}`);
      setStatus('Audio load error — retrying...');
      currentVideoIdRef.current = null;
      currentTrackIdRef.current = null;
    }, { once: true });
    newAudio.load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Poll ---

  const poll = useCallback(async () => {
    let data: NowPlaying;
    try {
      const res = await fetch('/spotify/now-playing');
      if (res.status === 401) {
        setIsAuthenticated(false);
        setStatus('Not authenticated — please log in.');
        return;
      }
      data = await res.json();
    } catch (err) {
      setStatus('Network error: ' + (err as Error).message);
      return;
    }

    setIsAuthenticated(true);

    if (!data.is_playing) {
      if (wasSpotifyPlayingRef.current === true) logEvent('spotify_pause', currentTrackIdRef.current);
      wasSpotifyPlayingRef.current = false;
      setStatus('Spotify is paused or nothing is playing.');
      pauseProgrammatic(audioRef.current);
      setIsPlaying(false);
      return;
    }

    if (wasSpotifyPlayingRef.current === false) logEvent('spotify_play', currentTrackIdRef.current);
    wasSpotifyPlayingRef.current = true;
    setTrackName(data.track);
    setArtistName(data.artist);
    setIsPlaying(data.is_playing);
    const spotifySec = data.progress_ms / 1000;

    if (data.track_id !== currentTrackIdRef.current) {
      log(`\n--- ${data.track} – ${data.artist} ---`);
      log(`[debug] track changed: ${currentTrackIdRef.current} → ${data.track_id} (${data.track})`);
      currentTrackIdRef.current = data.track_id;
      setTrackNotIdeal(false);
      setTrackBugged(false);
      setTrackAllSourcesTried(false);
      setTrackSource('');
      await loadTrack(data, spotifySec);
      pollQueue();
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
    } else if (currentVideoIdRef.current) {
      if (++pollCountRef.current % 3 === 0) pollQueue();
      const audio = audioRef.current;
      if (audio) {
        if (audio.ended) {
          setStatus('Czekam na następny utwór...');
        } else {
          const drift = Math.abs(audio.currentTime - spotifySec);
          if (drift > 2) {
            setStatus(`Correcting drift (${drift.toFixed(1)}s)...`);
            audio.currentTime = spotifySec;
          } else {
            setStatus('In sync.');
          }
          if (audio.paused && !listeningPausedRef.current) audio.play().catch(() => {});
        }
      }
    }
  }, [loadTrack, pollQueue]);

  const updateListeners = useCallback(async () => {
    try {
      const res = await fetch('/clients');
      const data = await res.json();
      setListenerCount(data.count);
    } catch (_) {}
  }, []);

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
    if (audioRef.current) attachAudioListeners(audioRef.current);
    poll();
    const pollInterval = setInterval(poll, 3000);
    updateListeners();
    const listenersInterval = setInterval(updateListeners, 5000);
    return () => {
      clearInterval(pollInterval);
      clearInterval(listenersInterval);
    };
  }, [started, poll, updateListeners]);

  return {
    started,
    start,
    isAuthenticated,
    trackName,
    artistName,
    isPlaying,
    status,
    listenerCount,
    audioRef,
    isListeningPaused,
    trackNotIdeal,
    trackBugged,
    trackAllSourcesTried,
    trackSource,
    feedbackMsg,
    markNotIdeal,
    markBugged,
  };
}
