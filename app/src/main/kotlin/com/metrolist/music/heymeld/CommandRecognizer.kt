package com.metrolist.music.heymeld

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Transcribes the command spoken after "Hey Meld" with the system speech recognizer (it-IT).
 * When [audio] is given (Android 13+), the recognizer reads our own microphone stream so no
 * words are lost while it starts up; otherwise it opens the microphone itself.
 */
class CommandRecognizer(private val context: Context) {

    sealed interface Outcome {
        data class Text(val alternatives: List<String>) : Outcome
        data object NothingHeard : Outcome
        data class Failed(val error: Int) : Outcome
    }

    private var recognizer: SpeechRecognizer? = null

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    /** Must be called on the main thread. */
    suspend fun listen(audio: ParcelFileDescriptor?): Outcome {
        val sr = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        val result = CompletableDeferred<Outcome>()
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onResults(results: Bundle?) {
                val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                result.complete(if (texts.isEmpty()) Outcome.NothingHeard else Outcome.Text(texts))
            }
            override fun onError(error: Int) {
                result.complete(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Outcome.NothingHeard
                        else -> Outcome.Failed(error)
                    },
                )
            }
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "it-IT")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "it-IT")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 900L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 700L)
            if (audio != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, audio)
                putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, WakeWordDetector.SAMPLE_RATE)
            }
        }
        sr.startListening(intent)
        val outcome = withTimeoutOrNull(12_000) { result.await() }
        if (outcome == null) sr.cancel()
        return outcome ?: Outcome.NothingHeard
    }

    fun cancel() {
        recognizer?.cancel()
    }

    fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }
}
