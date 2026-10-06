export interface Track {
  id: string
  uri: string
  title: string
  artist: string
  album: string
  durationMs: number
  addedAt: string
  artwork?: string
  genre?: string
  language?: string
  artistId?: string
  artistGenres?: string[]
  classificationSource?: 'manual' | 'catalog' | 'heuristic' | 'ai'
  classificationConfidence?: number
  manualLabels?: Array<'genre' | 'language'>
  color?: string
}

export interface HistoryEvent {
  trackId?: string
  title: string
  artist: string
  playedAt: string
  msPlayed: number
}

export interface HistoryData {
  events: HistoryEvent[]
  source: 'demo' | 'import' | 'spotify-recent'
  from: string | null
  to: string | null
}

export type ListeningLevel = 'heavy' | 'regular' | 'light' | 'unknown'

export interface EnrichedTrack extends Track {
  plays: number
  lastPlayed: string | null
  listening: ListeningLevel
  hasHistory: boolean
}

export interface PlaylistGroup {
  id: string
  name: string
  description: string
  color: string
  tracks: EnrichedTrack[]
  basis: 'genre' | 'artist' | 'history' | 'language' | 'genre-language'
}

export interface StoredLibrary {
  version: 1
  source: 'demo' | 'spotify'
  tracks: Track[]
  history: HistoryData | null
  genres: Record<string, string>
  groupMode?: 'taste' | 'genre' | 'language' | 'genre-language'
}
