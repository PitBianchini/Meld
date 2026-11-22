package com.metrolist.music.heymeld

import androidx.media3.exoplayer.offline.Download
import com.metrolist.music.constants.SongSortType
import com.metrolist.music.extensions.toMediaItem
import com.metrolist.music.playback.MusicService
import com.metrolist.music.playback.SpotifyYouTubeMapper
import com.metrolist.music.playback.VoiceSearchMatcher
import com.metrolist.music.playback.queues.ListQueue
import com.metrolist.music.playback.queues.Queue
import com.metrolist.music.playback.queues.SpotifyLikedSongsQueue
import com.metrolist.music.playback.queues.SpotifyPlaylistQueue
import com.metrolist.music.playback.queues.YouTubePlaylistQueue
import com.metrolist.spotify.Spotify
import kotlinx.coroutines.flow.first
import timber.log.Timber

/** Finds one of the user's own playlists (Meld, YouTube library, Spotify, downloads, likes) by spoken name. */
class PlaylistResolver {

    class Match(val name: String, val score: Double, val queue: suspend () -> Queue?)

    /** Best playlist whose name matches [spoken], or null if none is at least [minScore] similar. */
    suspend fun find(service: MusicService, spoken: String, minScore: Double): Match? {
        val wanted = significantTokens(spoken)
        if (wanted.isEmpty()) return null
        val candidates = localPlaylists(service) + spotifyPlaylists(service)
        val best = candidates
            .map { (name, queue) -> Match(name, similarity(wanted, significantTokens(name)), queue) }
            .maxByOrNull { it.score }
        Timber.tag(TAG).i("playlist '%s' -> best '%s' (%.2f) among %d", spoken, best?.name, best?.score, candidates.size)
        return best?.takeIf { it.score >= minScore }
    }

    suspend fun liked(service: MusicService): Pair<String, Queue>? {
        val songs = service.database.likedSongs(SongSortType.CREATE_DATE, true).first()
        if (songs.isNotEmpty()) return "i tuoi mi piace" to ListQueue("Mi piace", songs.map { it.toMediaItem() })
        if (Spotify.isAuthenticated()) {
            return "i brani che ti piacciono su Spotify" to SpotifyLikedSongsQueue(mapper = SpotifyYouTubeMapper(service.database))
        }
        return null
    }

    suspend fun downloaded(service: MusicService): Pair<String, Queue>? {
        val downloads = service.downloadUtil.downloads.value
        val songs = service.database.allSongs().first()
            .filter { downloads[it.id]?.state == Download.STATE_COMPLETED }
            .sortedBy { downloads[it.id]?.updateTimeMs ?: 0L }
        if (songs.isEmpty()) return null
        return "i brani scaricati" to ListQueue("Scaricati", songs.map { it.toMediaItem() })
    }

    suspend fun topTracks(service: MusicService): Pair<String, Queue>? {
        if (!Spotify.isAuthenticated()) return null
        val tracks = Spotify.topTracks(limit = 50).getOrNull()?.items?.filter { !it.isLocal }.orEmpty()
        if (tracks.isEmpty()) return null
        return "i tuoi brani più ascoltati" to SpotifyLikedSongsQueue(mapper = SpotifyYouTubeMapper(service.database), tracks = tracks)
    }

    private suspend fun localPlaylists(service: MusicService): List<Pair<String, suspend () -> Queue?>> =
        runCatching { service.database.playlistsByNameAsc().first() }.getOrDefault(emptyList()).map { p ->
            p.playlist.name to suspend {
                val songs = service.database.playlistSongs(p.playlist.id).first().map { it.song.toMediaItem() }
                when {
                    songs.isNotEmpty() -> ListQueue(p.playlist.name, songs)
                    p.playlist.browseId != null -> YouTubePlaylistQueue(p.playlist.browseId, p.playlist.name)
                    else -> null
                }
            }
        }

    private suspend fun spotifyPlaylists(service: MusicService): List<Pair<String, suspend () -> Queue?>> {
        if (!Spotify.isAuthenticated()) return emptyList()
        val all = mutableListOf<Pair<String, String>>()
        var offset = 0
        while (offset < 500) {
            val page = Spotify.myPlaylists(limit = 50, offset = offset)
                .onFailure { Timber.tag(TAG).w(it, "Spotify playlists unavailable") }
                .getOrNull() ?: break
            all += page.items.map { it.name to it.id }
            offset += page.items.size
            if (page.items.isEmpty() || offset >= page.total) break
        }
        val mapper by lazy { SpotifyYouTubeMapper(service.database) }
        return all.map { (name, id) -> name to suspend { SpotifyPlaylistQueue(playlistId = id, mapper = mapper) } }
    }

    companion object {
        private const val TAG = "HeyMeld"
        private val STOP_WORDS = setOf(
            "il", "lo", "la", "i", "gli", "le", "l", "un", "una", "uno", "mia", "mio", "mie", "miei", "tua", "tuo",
            "di", "del", "della", "dei", "degli", "delle", "e", "ed", "the", "my", "a", "of", "playlist",
        )

        internal fun significantTokens(text: String): Set<String> =
            VoiceSearchMatcher.tokenize(text.replace("'", " ")).filter { it !in STOP_WORDS }.toSet()
                .ifEmpty { VoiceSearchMatcher.tokenize(text) }

        /**
         * 1.0 when both names have the same meaningful words (small mishearings allowed);
         * saying only part of a long name ("rock italiano" for "Rock italiano anni 90") still scores 0.7+.
         */
        internal fun similarity(a: Set<String>, b: Set<String>): Double {
            if (a.isEmpty() || b.isEmpty()) return 0.0
            fun close(x: String, y: String) = x == y || (x.length > 3 && y.length > 3 && VoiceSearchMatcher.jaroWinkler(x, y) >= 0.88)
            val hits = a.count { x -> b.any { y -> close(x, y) } }
            val back = b.count { y -> a.any { x -> close(x, y) } }
            if (hits == a.size) return 0.7 + 0.3 * back / b.size
            return minOf(hits.toDouble() / a.size, back.toDouble() / b.size)
        }
    }
}
