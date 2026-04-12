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
    </div>
  );
}
