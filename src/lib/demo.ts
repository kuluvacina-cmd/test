import type { HistoryEvent, StoredLibrary, Track } from '../types'

type DemoTrack = [title: string, artist: string, album: string, genre: string, plays: number, lastDaysAgo: number]

const SONGS: DemoTrack[] = [
  ['Bước qua mùa cô đơn', 'Vũ.', 'Bước qua mùa cô đơn', 'Indie Việt', 18, 1],
  ['Có em', 'Madihu, Low G', 'Có em', 'Indie Việt', 14, 2],
  ['Chuyện rằng', 'Thịnh Suy', 'Chuyện rằng', 'Indie Việt', 11, 3],
  ['Nàng thơ', 'Hoàng Dũng', '25', 'Indie Việt', 22, 1],
  ['Một đêm say', 'Thịnh Suy', 'Một đêm say', 'Indie Việt', 6, 12],
  ['Bước qua nhau', 'Vũ.', 'Một vạn năm', 'Indie Việt', 4, 21],
  ['Lạ lùng', 'Vũ.', 'Lạ lùng', 'Indie Việt', 2, 58],
  ['Đôi lời', 'Hà Anh Tuấn', 'Đôi lời', 'Indie Việt', 1, 92],
  ['Trốn tìm', 'Đen, MTV', 'Trốn tìm', 'Hip-hop', 7, 14],
  ['Bài này chill phết', 'Đen, MIN', 'Bài này chill phết', 'Hip-hop', 12, 5],
  ['Đưa nhau đi trốn', 'Đen, Linh Cáo', 'Đưa nhau đi trốn', 'Hip-hop', 2, 71],
  ['Chìm sâu', 'RPT MCK, Trung Trần', '99%', 'Hip-hop', 16, 2],
  ['See You Again', 'Tyler, The Creator, Kali Uchis', 'Flower Boy', 'Hip-hop', 5, 18],
  ['Sunflower', 'Post Malone, Swae Lee', 'Spider-Man: Into the Spider-Verse', 'Hip-hop', 1, 110],
  ['Sunkissed', 'khai dreams', 'Sunkissed', 'R&B', 17, 1],
  ['Best Part', 'Daniel Caesar, H.E.R.', 'Freudian', 'R&B', 13, 4],
  ['Get You', 'Daniel Caesar, Kali Uchis', 'Freudian', 'R&B', 8, 8],
  ['Good Days', 'SZA', 'SOS', 'R&B', 5, 15],
  ['Pink + White', 'Frank Ocean', 'Blonde', 'R&B', 2, 46],
  ['Like I Want You', 'Giveon', 'Take Time', 'R&B', 1, 85],
  ['Snooze', 'SZA', 'SOS', 'R&B', 0, 0],
  ['double take', 'dhruv', 'rapunzel', 'R&B', 3, 30],
  ['Có hẹn với thanh xuân', 'MONSTAR', 'Over The Moon', 'Pop', 15, 3],
  ['thích em hơi nhiều', 'Wren Evans', 'thích em hơi nhiều', 'Pop', 9, 7],
  ['đã lỡ yêu em nhiều', 'JustaTee', 'đã lỡ yêu em nhiều', 'Pop', 2, 42],
  ['Chúng ta của hiện tại', 'Sơn Tùng M-TP', 'Chúng ta của hiện tại', 'Pop', 1, 104],
  ['Cruel Summer', 'Taylor Swift', 'Lover', 'Pop', 10, 6],
  ['Espresso', 'Sabrina Carpenter', 'Short n’ Sweet', 'Pop', 4, 11],
  ['Beautiful Things', 'Benson Boone', 'Fireworks & Rollerblades', 'Pop', 0, 0],
  ['golden hour', 'JVKE', 'this is what falling in love feels like', 'Pop', 0, 0],
  ['The Less I Know The Better', 'Tame Impala', 'Currents', 'Alternative', 12, 4],
  ['Sweater Weather', 'The Neighbourhood', 'I Love You.', 'Alternative', 6, 16],
  ['Space Song', 'Beach House', 'Depression Cherry', 'Alternative', 2, 63],
  ['505', 'Arctic Monkeys', 'Favourite Worst Nightmare', 'Alternative', 1, 95],
  ['Apocalypse', 'Cigarettes After Sex', 'Cigarettes After Sex', 'Alternative', 3, 29],
  ['Somewhere Only We Know', 'Keane', 'Hopes and Fears', 'Alternative', 0, 0],
]

const ART_COLORS = ['#62766d', '#c19070', '#74828f', '#9c7581', '#626d91', '#b2a07c', '#708d88', '#a58867', '#827792', '#b57669', '#788461', '#658199']
const DAY = 86_400_000

/** Clearly synthetic listening data; never used as a real Spotify history. */
export function demoLibrary(): StoredLibrary {
  const now = Date.now()
  const events: HistoryEvent[] = []
  const genres: Record<string, string> = {}
  const tracks: Track[] = SONGS.map(([title, artist, album, genre, plays, lastDaysAgo], index) => {
    const id = `demo-${String(index + 1).padStart(2, '0')}`
    const durationMs = (170 + (index * 17) % 96) * 1000
    const track: Track = {
      id,
      uri: `demo:track:${id}`,
      title,
      artist,
      album,
      durationMs,
      addedAt: new Date(now - (120 + index * 5) * DAY).toISOString(),
      genre,
      color: ART_COLORS[index % ART_COLORS.length],
    }
    genres[id] = genre
    for (let play = 0; play < plays; play += 1) {
      events.push({
        trackId: id,
        title,
        artist,
        playedAt: new Date(now - (lastDaysAgo + play * (2 + index % 4)) * DAY - (index * 19 % 120) * 60_000).toISOString(),
        msPlayed: Math.round(durationMs * (0.72 + ((index + play) % 7) * 0.04)),
      })
    }
    // A short preview is intentionally insufficient evidence of a full play.
    if (plays === 0 && index % 2 === 0) {
      events.push({ trackId: id, title, artist, playedAt: new Date(now - 2 * DAY).toISOString(), msPlayed: 12_000 })
    }
    return track
  })
  events.sort((a, b) => a.playedAt.localeCompare(b.playedAt))
  return {
    version: 1,
    source: 'demo',
    tracks,
    genres,
    history: { source: 'demo', events, from: events[0]?.playedAt ?? null, to: events.at(-1)?.playedAt ?? null },
  }
}
