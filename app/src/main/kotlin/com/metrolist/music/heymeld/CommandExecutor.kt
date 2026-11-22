package com.metrolist.music.heymeld

import android.content.Context
import android.media.AudioManager
import com.metrolist.innertube.YouTube
import com.metrolist.innertube.models.AlbumItem
import com.metrolist.innertube.models.ArtistItem
import com.metrolist.innertube.models.PlaylistItem
import com.metrolist.innertube.models.SongItem
import com.metrolist.innertube.models.WatchEndpoint
import com.metrolist.innertube.models.YTItem
import com.metrolist.music.extensions.toMediaItem
import com.metrolist.music.models.toMediaMetadata
import com.metrolist.music.playback.MusicService
import com.metrolist.music.playback.queues.Queue
import com.metrolist.music.playback.queues.YouTubeAlbumRadio
import com.metrolist.music.playback.queues.YouTubeQueue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import timber.log.Timber
import kotlin.math.roundToInt

/** Runs a [VoiceCommand] against Meld's player and returns the sentence to speak back. */
class CommandExecutor(private val context: Context) {

    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val playlists = PlaylistResolver()

    suspend fun execute(service: MusicService, command: VoiceCommand): String = withContext(Dispatchers.Main) {
        if (!service.isPlayerReady.value) return@withContext "Meld non è pronto, riprova tra un attimo"
        val player = service.player
        when (command) {
            VoiceCommand.Next -> {
                if (!player.hasNextMediaItem()) return@withContext "Non ci sono altre canzoni in coda"
                player.seekToNext()
                player.play()
                "Canzone successiva"
            }
            VoiceCommand.Previous -> {
                if (player.hasPreviousMediaItem()) player.seekToPreviousMediaItem() else player.seekTo(0)
                player.play()
                "Canzone precedente"
            }
            VoiceCommand.Restart -> {
                player.seekTo(0)
                player.play()
                "Ricomincio da capo"
            }
            VoiceCommand.Pause -> {
                player.pause()
                "Musica in pausa"
            }
            VoiceCommand.Resume -> {
                if (player.mediaItemCount == 0) return@withContext "Non c'è niente da riprendere. Dimmi cosa vuoi ascoltare"
                player.play()
                "Riprendo"
            }
            VoiceCommand.VolumeUp -> setVolume(volumePercent() + 15).let { "Volume al $it per cento" }
            VoiceCommand.VolumeDown -> setVolume(volumePercent() - 15).let { "Volume al $it per cento" }
            is VoiceCommand.VolumeSet -> setVolume(command.percent).let { "Volume al $it per cento" }
            is VoiceCommand.Shuffle -> {
                val enabled = command.enabled ?: !player.shuffleModeEnabled
                player.shuffleModeEnabled = enabled
                if (enabled) "Riproduzione casuale attivata" else "Riproduzione casuale disattivata"
            }
            VoiceCommand.WhatIsPlaying -> {
                val m = service.currentMediaMetadata.value
                    ?: return@withContext "Non sta suonando niente"
                val artists = m.artists.joinToString(" e ") { it.name }
                if (artists.isBlank()) "Questa è ${m.title}" else "Questa è ${m.title}, di $artists"
            }
            is VoiceCommand.Like -> like(service, command.liked)
            is VoiceCommand.Play -> play(service, command)
            is VoiceCommand.Enqueue -> enqueue(service, command)
            VoiceCommand.Unknown -> "Non ho capito"
        }
    }

    private fun volumePercent(): Int {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        return (audioManager.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max).roundToInt()
    }

    private fun setVolume(percent: Int): Int {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val index = (percent.coerceIn(0, 100) * max / 100f).roundToInt().coerceIn(0, max)
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, index, 0)
        return (index * 100f / max).roundToInt()
    }

    private suspend fun like(service: MusicService, liked: Boolean): String {
        val m = service.currentMediaMetadata.value ?: return "Non sta suonando niente"
        val current = withContext(Dispatchers.IO) { service.database.song(m.id).first()?.song?.liked } ?: false
        if (current == liked) return if (liked) "Ti piace già" else "Non era tra i mi piace"
        service.toggleLike()
        return if (liked) "Aggiunta ai mi piace" else "Tolta dai mi piace"
    }

    private suspend fun enqueue(service: MusicService, command: VoiceCommand.Enqueue): String {
        val song = withContext(Dispatchers.IO) { searchFirst<SongItem>(command.query, YouTube.SearchFilter.FILTER_SONG) }
            ?: return "Non ho trovato ${command.query}"
        val item = song.toMediaItem()
        if (command.next) service.playNext(listOf(item)) else service.addToQueue(listOf(item))
        return if (command.next) "Dopo questa metto ${describe(song)}" else "Ho messo in coda ${describe(song)}"
    }

    private suspend fun play(service: MusicService, command: VoiceCommand.Play): String {
        val resolved = withContext(Dispatchers.IO) { resolve(service, command) }
            ?: return when (command.kind) {
                PlayKind.LIKED -> "Non hai ancora brani tra i mi piace"
                PlayKind.DOWNLOADED -> "Non hai brani scaricati"
                else -> "Non ho trovato ${command.query}"
            }
        service.playQueue(resolved.queue)
        if (command.shuffle) service.player.shuffleModeEnabled = true
        return resolved.speech
    }

    private class Resolved(val queue: Queue, val speech: String)

    private suspend fun resolve(service: MusicService, command: VoiceCommand.Play): Resolved? {
        val q = command.query
        return when (command.kind) {
            PlayKind.LIKED -> playlists.liked(service)?.let { (name, queue) -> Resolved(queue, "Metto $name") }
            PlayKind.DOWNLOADED -> playlists.downloaded(service)?.let { (name, queue) -> Resolved(queue, "Metto $name") }
            PlayKind.PLAYLIST -> myPlaylist(service, q, 0.6)
                ?: topIfAsked(service, q)
                ?: searchFirst<PlaylistItem>(q, YouTube.SearchFilter.FILTER_FEATURED_PLAYLIST)?.let(::playlistQueue)
                ?: searchFirst<PlaylistItem>(q, YouTube.SearchFilter.FILTER_COMMUNITY_PLAYLIST)?.let(::playlistQueue)
            PlayKind.ALBUM -> searchFirst<AlbumItem>(q, YouTube.SearchFilter.FILTER_ALBUM)?.let(::albumQueue)
            PlayKind.ARTIST -> searchFirst<ArtistItem>(q, YouTube.SearchFilter.FILTER_ARTIST)?.let(::artistQueue)
                ?: searchFirst<SongItem>(q, YouTube.SearchFilter.FILTER_SONG)?.let(::songQueue)
            PlayKind.SONG -> searchFirst<SongItem>(q, YouTube.SearchFilter.FILTER_SONG)?.let(::songQueue)
            PlayKind.AUTO -> myPlaylist(service, q, 0.85)
                ?: topIfAsked(service, q)
                ?: topResult(q)?.let(::queueFor)
                ?: searchFirst<SongItem>(q, YouTube.SearchFilter.FILTER_SONG)?.let(::songQueue)
        }
    }

    private suspend fun myPlaylist(service: MusicService, query: String, minScore: Double): Resolved? {
        val match = playlists.find(service, query, minScore) ?: return null
        val queue = match.queue() ?: return null
        return Resolved(queue, "Metto la playlist ${match.name}")
    }

    /** "i miei migliori 50", "le più ascoltate"... without a playlist of that name: Spotify top tracks. */
    private suspend fun topIfAsked(service: MusicService, query: String): Resolved? {
        if (!TOP_WORDS.containsMatchIn(query.lowercase())) return null
        return playlists.topTracks(service)?.let { (name, queue) -> Resolved(queue, "Metto $name") }
    }

    private suspend fun topResult(query: String): YTItem? =
        YouTube.searchSummary(query).getOrNull()?.summaries?.firstOrNull()?.items?.firstOrNull {
            it is SongItem || it is ArtistItem || it is AlbumItem || it is PlaylistItem
        }

    private fun queueFor(item: YTItem): Resolved? = when (item) {
        is SongItem -> songQueue(item)
        is ArtistItem -> artistQueue(item)
        is AlbumItem -> albumQueue(item)
        is PlaylistItem -> playlistQueue(item)
        else -> null
    }

    private fun songQueue(song: SongItem) = Resolved(
        YouTubeQueue(WatchEndpoint(videoId = song.id), song.toMediaMetadata()),
        "Riproduco ${describe(song)}",
    )

    private fun artistQueue(artist: ArtistItem): Resolved? {
        val endpoint = artist.playEndpoint ?: artist.shuffleEndpoint ?: artist.radioEndpoint ?: return null
        return Resolved(YouTubeQueue(endpoint), "Metto i brani di ${artist.title}")
    }

    private fun albumQueue(album: AlbumItem): Resolved {
        val by = album.artists?.joinToString(" e ") { it.name }.orEmpty()
        return Resolved(
            YouTubeAlbumRadio(album.playlistId),
            if (by.isBlank()) "Metto l'album ${album.title}" else "Metto l'album ${album.title} di $by",
        )
    }

    private fun playlistQueue(playlist: PlaylistItem): Resolved? {
        val endpoint = playlist.playEndpoint ?: WatchEndpoint(playlistId = playlist.id)
        return Resolved(YouTubeQueue(endpoint), "Metto la playlist ${playlist.title}")
    }

    private suspend inline fun <reified T : YTItem> searchFirst(query: String, filter: YouTube.SearchFilter): T? =
        YouTube.search(query, filter)
            .onFailure { Timber.tag(TAG).w(it, "search failed for %s", query) }
            .getOrNull()?.items?.filterIsInstance<T>()?.firstOrNull()

    private fun describe(song: SongItem): String {
        val artists = song.artists.joinToString(" e ") { it.name }
        return if (artists.isBlank()) song.title else "${song.title} di $artists"
    }

    private companion object {
        const val TAG = "HeyMeld"
        val TOP_WORDS = Regex("migliori|top|più ascoltat|piu ascoltat|ascolto di più|ascolto di piu")
    }
}
