export interface NowPlayingResponse {
  track: string;
  artist: string;
  track_id: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
}

export interface QueueResponse {
  next: QueueTrack | null;
}

export interface QueueTrack {
  track: string;
  artist: string;
  track_id: string;
  duration_ms: number;
}

export interface YouTubeSearchResponse {
  videoId: string | null;
}
