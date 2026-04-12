import { Badge } from '@/components/ui/badge';

interface NowPlayingProps {
  track: string;
  artist: string;
  isPlaying: boolean;
}

export function NowPlaying({ track, artist, isPlaying }: NowPlayingProps) {
  return (
    <div className="text-center space-y-1 flex flex-col items-center justify-center">
      <span className="text-xl text-white font-bold">{track}</span>
      <div className="flex items-center justify-center flex-wrap">
        <Badge
          variant={isPlaying ? 'default' : 'secondary'}
          className={isPlaying ? 'bg-[#1db954] text-black hover:bg-[#1db954]' : ''}
        >
          {isPlaying ? '▶ Playing' : '⏸ Paused'}
        </Badge>
      </div>
      <div className="text-muted-foreground text-sm">{artist}</div>
    </div>
  );
}
