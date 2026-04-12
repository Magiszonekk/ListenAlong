import { type RefObject } from 'react';

interface AudioPlayerProps {
  audioRef: RefObject<HTMLAudioElement | null>;
}

export function AudioPlayer({ audioRef }: AudioPlayerProps) {
  return (
    <audio
      id="audio-player"
      ref={audioRef}
      controls
      className="w-full max-w-[500px] accent-[#1db954]"
    />
  );
}
