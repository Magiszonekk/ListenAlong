import { useState } from 'react';
import { Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AudioPlayer } from '@/components/AudioPlayer';
import { NowPlaying } from '@/components/NowPlaying';
import { SyncStatus } from '@/components/SyncStatus';
import { clientId, clientShort, useSpotifySync } from '@/hooks/useSpotifySync';

export default function App() {
  const {
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
  } = useSpotifySync();

  const [compensation, setCompensation] = useState(() => localStorage.getItem('syncCompensation') ?? '0');

  const [, setClickCount] = useState(0);
  const [lastClickTime, setLastClickTime] = useState(0);

  const handleSecretClick = () => {
    const now = Date.now();

    // jeśli przerwa za duża → reset
    if (now - lastClickTime > 1500) {
      setClickCount(1);
    } else {
      setClickCount(prev => {
        const newCount = prev + 1;
        console.log(`[dev] clicks: ${newCount}/5`);
        if (newCount === 4) console.log("[dev] almost there...");
        if (newCount >= 5) {
          localStorage.setItem("dev", "true");
          console.log("[dev] enabled 😎");
          window.location.reload(); // żeby hook złapał zmianę
          return 0;
        }

        return newCount;
      });
    }

    setLastClickTime(now);
  };

  const listenersText =
    listenerCount === null ? '' :
    listenerCount === 1 ? '1 listener' : `${listenerCount} listeners`;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center gap-4 p-6">
      <h1 onClick={handleSecretClick} className="text-2xl font-bold text-[#1db954] cursor-pointer">ListenAlong</h1>

      {listenersText && (
        <div className="relative group cursor-default">
          <p className="text-xs text-neutral-500">{listenersText}</p>
          {clientIds.length > 0 && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:flex flex-col bg-neutral-900 border border-neutral-700 text-xs rounded px-2 py-1 whitespace-nowrap z-10">
              {clientIds.map(id => (
                id === clientId
                  ? <span key={id} className="font-bold text-white">{id.slice(0, 6)} (ty)</span>
                  : <span key={id} className="text-neutral-400">{id.slice(0, 6)}</span>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="text-[11px] text-neutral-700 font-mono">ID: {clientShort}</p>

      {!isAuthenticated && (
        <p className="text-sm">
          Not connected.{' '}
          <a href="/auth/login" className="text-[#1db954] font-bold hover:underline">
            Log in with Spotify
          </a>
        </p>
      )}

      <NowPlaying track={trackName} artist={artistName} isPlaying={isPlaying} />

      <SyncStatus status={status} />

      {!started && (
        <Button
          onClick={start}
          className="bg-[#1db954] text-black hover:bg-[#17a349] rounded-full px-8 font-bold"
        >
          ▶ Start sync
        </Button>
      )}

      <AudioPlayer audioRef={audioRef} />

      {started && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-3">
            {trackSource === 'odesli' && (
              <Button
                onClick={markNotIdeal}
                disabled={trackNotIdeal || trackAllSourcesTried}
                title={trackAllSourcesTried ? 'Sprawdzono wszystkie źródła' : 'Zgłoś niedopasowanie (znajdziemy wersję o lepszym czasie)'}
                className={trackNotIdeal
                  ? "bg-yellow-600 text-white rounded-full w-11 h-11 text-base font-bold p-0 opacity-60 cursor-not-allowed"
                  : "bg-neutral-800 text-neutral-400 hover:bg-yellow-600 hover:text-white rounded-full w-11 h-11 text-base font-bold p-0 disabled:opacity-40 disabled:cursor-not-allowed"
                }
              >
                ~
              </Button>
            )}
            <Button
              onClick={markBugged}
              disabled={trackBugged || trackAllSourcesTried}
              title={trackAllSourcesTried ? 'Sprawdzono wszystkie źródła' : 'Zgłoś buga (znajdziemy inne źródło)'}
              className={trackBugged
                ? "bg-red-600 text-white rounded-full w-11 h-11 text-lg font-bold p-0 opacity-60 cursor-not-allowed"
                : "bg-neutral-800 text-neutral-400 hover:bg-red-600 hover:text-white rounded-full w-11 h-11 text-lg font-bold p-0 disabled:opacity-40 disabled:cursor-not-allowed"
              }
            >
              <Bug size={18} />
            </Button>
          </div>
          {feedbackMsg && (
            <p className="text-xs text-neutral-400 text-center">{feedbackMsg}</p>
          )}
          {trackAllSourcesTried && (
            <p className="text-xs text-neutral-500 text-center">Sprawdzono wszystkie źródła — brak lepszej wersji.</p>
          )}
          {isDev && (
            <div className="mt-2 border border-neutral-700 rounded-lg p-3 text-xs text-neutral-400 space-y-2 w-64">
              <div className="text-neutral-600 font-mono uppercase tracking-widest text-[10px]">dev</div>
              <div className="flex gap-2 flex-wrap">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={compensation}
                    onChange={e => { setCompensation(e.target.value); setCompensationMs(parseFloat(e.target.value) || 0); }}
                    className="bg-neutral-900 border border-neutral-700 text-neutral-300 rounded px-2 py-1 font-mono w-20 text-xs"
                    placeholder="ms"
                  />
                  <span className="text-neutral-600 text-[10px]">ms</span>
                </div>
                <button
                  onClick={() => { forceSync(); console.log(`[dev] force sync compensation=${compensation}ms`); }}
                  className="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded px-3 py-1 font-mono"
                >
                  Force Sync
                </button>
                <button
                  onClick={() => console.log(`[dev] player: ${getPlayerProgress().toFixed(3)}s`)}
                  className="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded px-3 py-1 font-mono"
                >
                  Player progress
                </button>
                <button
                  onClick={() => console.log(`[dev] spotify: ${getSpotifyProgress().toFixed(3)}s`)}
                  className="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded px-3 py-1 font-mono"
                >
                  Spotify progress
                </button>
                <button
                  onClick={() => {
                    const player = getPlayerProgress();
                    const spotify = getSpotifyProgress();
                    const diff = player - spotify;
                    console.log(`[dev] compare — player: ${player.toFixed(3)}s | spotify: ${spotify.toFixed(3)}s | diff: ${diff > 0 ? '+' : ''}${diff.toFixed(3)}s`);
                  }}
                  className="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded px-3 py-1 font-mono"
                >
                  Compare
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
