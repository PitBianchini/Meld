package com.metrolist.music.heymeld

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Italian text-to-speech replies. [say] suspends until the sentence has been spoken. */
class Speaker(context: Context) {
    private val ready = CompletableDeferred<Boolean>()
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Unit>>()

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready.complete(status == TextToSpeech.SUCCESS)
    }

    init {
        tts.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {}
            override fun onDone(utteranceId: String) { pending.remove(utteranceId)?.complete(Unit) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) { pending.remove(utteranceId)?.complete(Unit) }
            override fun onError(utteranceId: String, errorCode: Int) { pending.remove(utteranceId)?.complete(Unit) }
        })
    }

    suspend fun say(text: String) {
        if (withTimeoutOrNull(3_000) { ready.await() } != true) return
        if (tts.voice?.locale?.language != "it") tts.language = Locale.ITALIAN
        val id = UUID.randomUUID().toString()
        val done = CompletableDeferred<Unit>()
        pending[id] = done
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id) != TextToSpeech.SUCCESS) {
            pending.remove(id)
            return
        }
        withTimeoutOrNull(15_000) { done.await() }
    }

    fun shutdown() {
        tts.stop()
        tts.shutdown()
    }
}
