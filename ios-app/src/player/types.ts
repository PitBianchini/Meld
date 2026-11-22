export type Track = {
  /** YouTube video id; empty until a Spotify track has been matched. */
  id: string;
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  durationSec?: number;
  /** Set for tracks coming from Spotify, resolved to a YouTube id when played. */
  spotifyId?: string;
};
