import { Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AudioPlayer } from '@/components/AudioPlayer';
import { NowPlaying } from '@/components/NowPlaying';
import { SyncStatus } from '@/components/SyncStatus';
import { clientShort, useSpotifySync } from '@/hooks/useSpotifySync';

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
    audioRef,
    trackNotIdeal,
    trackBugged,
    trackAllSourcesTried,
    trackSource,
    feedbackMsg,
    markNotIdeal,
    markBugged,
  } = useSpotifySync();

  const listenersText =
    listenerCount === null ? '' :
    listenerCount === 1 ? '1 listener' : `${listenerCount} listeners`;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold text-[#1db954]">Spotify → YouTube Sync</h1>

      {listenersText && (
        <p className="text-xs text-neutral-500">{listenersText}</p>
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
        </div>
      )}
    </div>
  );
}
