package com.metrolist.music.heymeld

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.SpeechRecognizer
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.metrolist.music.MainActivity
import com.metrolist.music.R
import com.metrolist.music.playback.MusicService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import timber.log.Timber
import java.io.IOException
import java.io.OutputStream

/**
 * Foreground service (type microphone) that listens for "Hey Meld" while Meld is open,
 * then transcribes the Italian command, runs it on [MusicService] and answers out loud.
 */
class HeyMeldService : Service() {

    private enum class Mode { LISTEN, COMMAND, HANDOFF, BUSY }

    private val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
    private val main = Handler(Looper.getMainLooper())
    private lateinit var audioManager: AudioManager
    private lateinit var detector: WakeWordDetector
    private lateinit var speaker: Speaker
    private lateinit var recognizer: CommandRecognizer
    private lateinit var executor: CommandExecutor

    private var musicService: MusicService? = null
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            musicService = (binder as? MusicService.MusicBinder)?.service
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            musicService = null
        }
    }

    @Volatile private var mode = Mode.LISTEN
    @Volatile private var alive = true
    @Volatile private var micReleased = false
    @Volatile private var restartRecord = false
    @Volatile private var commandSink: OutputStream? = null
    @Volatile private var cooldownUntil = 0L
    private var audioThread: Thread? = null
    private var duckedFrom: Float? = null

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) { restartRecord = true }
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) { restartRecord = true }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        HeyMeld.init(this)
        audioManager = getSystemService(AudioManager::class.java)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE_MUTE -> {
                HeyMeld.toggleMuted()
                if (!HeyMeld.running.value) stopSelf()
                return START_NOT_STICKY
            }
        }
        if (HeyMeld.running.value) return START_NOT_STICKY

        try {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, buildNotification(HeyMeld.muted.value),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
            )
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Cannot start microphone foreground service")
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            detector = WakeWordDetector.create(this)
        } catch (e: Throwable) {
            Timber.tag(TAG).e(e, "Wake word model missing or invalid")
            stopSelf()
            return START_NOT_STICKY
        }
        speaker = Speaker(this)
        recognizer = CommandRecognizer(this)
        executor = CommandExecutor(this)
        bindService(Intent(this, MusicService::class.java), connection, BIND_AUTO_CREATE)
        audioManager.registerAudioDeviceCallback(deviceCallback, main)
        HeyMeld.setRunning(true)

        scope.launch {
            HeyMeld.muted.collectLatest { muted ->
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(muted))
            }
        }
        audioThread = Thread(::audioLoop, "HeyMeldAudio").apply {
            priority = Thread.NORM_PRIORITY + 1
            start()
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Meld was swiped away: keep listening only while music keeps playing in the background.
        if (meldPlayer?.isPlaying != true) stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        alive = false
        HeyMeld.setRunning(false)
        closeSink()
        audioThread?.join(1_000)
        if (::detector.isInitialized) {
            detector.close()
            speaker.shutdown()
            recognizer.destroy()
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
            runCatching { unbindService(connection) }
        }
        unduck()
        scope.cancel()
        super.onDestroy()
    }

    // region audio thread

    @SuppressLint("MissingPermission")
    private fun audioLoop() {
        val chunk = ShortArray(WakeWordDetector.CHUNK)
        val history = ArrayDeque<ShortArray>()
        var record: AudioRecord? = null
        var effects: List<android.media.audiofx.AudioEffect> = emptyList()
        var lastModeCheck = 0L
        var inCall = false
        var lastPeriodicCheck = System.currentTimeMillis()

        fun release() {
            effects.forEach { runCatching { it.release() } }
            effects = emptyList()
            record?.let { runCatching { it.stop() }; it.release() }
            record = null
        }

        while (alive) {
            val now = System.currentTimeMillis()
            if (now - lastModeCheck > 1_000) {
                lastModeCheck = now
                inCall = audioManager.mode != AudioManager.MODE_NORMAL
            }
            if (now - lastPeriodicCheck > 60_000) {
                lastPeriodicCheck = now
                main.post(::stopIfMeldClosed)
            }
            val mustRelease = HeyMeld.muted.value || inCall || mode == Mode.HANDOFF
            if (mustRelease) {
                if (record != null) {
                    release()
                    detector.reset()
                }
                micReleased = true
                Thread.sleep(150)
                continue
            }
            if (record == null || restartRecord) {
                release()
                restartRecord = false
                val opened = openRecord()
                if (opened == null) {
                    Thread.sleep(2_000)
                    continue
                }
                record = opened.first
                effects = opened.second
                micReleased = false
                detector.reset()
                history.clear()
            }

            if (!readFully(record!!, chunk)) {
                release()
                Thread.sleep(500)
                continue
            }
            history.addLast(chunk.copyOf())
            while (history.size > PREBUFFER_CHUNKS) history.removeFirst()

            when (mode) {
                Mode.LISTEN -> {
                    val p = detector.process(chunk)
                    if (p >= detector.threshold && System.currentTimeMillis() >= cooldownUntil) {
                        Timber.tag(TAG).i("Wake word detected (%.2f)", p)
                        mode = Mode.COMMAND
                        val readEnd = openSink(history)
                        main.post { onWakeWord(readEnd) }
                    }
                }
                Mode.COMMAND -> commandSink?.let { sink ->
                    try {
                        sink.write(toBytes(chunk))
                    } catch (e: IOException) {
                        closeSink()
                    }
                }
                else -> Unit
            }
        }
        release()
    }

    @SuppressLint("MissingPermission")
    private fun openRecord(): Pair<AudioRecord, List<android.media.audiofx.AudioEffect>>? {
        val source = if (speakerIsOutput()) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
        val minBuf = AudioRecord.getMinBufferSize(WakeWordDetector.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        return try {
            val rec = AudioRecord(
                source, WakeWordDetector.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf, WakeWordDetector.CHUNK * 2 * 4),
            )
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                rec.release()
                return null
            }
            val fx = buildList<android.media.audiofx.AudioEffect> {
                if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.setEnabled(true); add(it) }
                if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.setEnabled(true); add(it) }
            }
            rec.startRecording()
            rec to fx
        } catch (e: Exception) {
            Timber.tag(TAG).w(e, "Microphone unavailable")
            null
        }
    }

    private fun speakerIsOutput(): Boolean = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none {
        it.type in setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER,
        )
    }

    private fun readFully(record: AudioRecord, buffer: ShortArray): Boolean {
        var offset = 0
        while (offset < buffer.size) {
            val n = record.read(buffer, offset, buffer.size - offset)
            if (n <= 0) return false
            offset += n
        }
        return true
    }

    /** Opens the pipe the speech recognizer reads from (Android 13+), pre-filled with the audio right after the wake word. */
    private fun openSink(history: Collection<ShortArray>): ParcelFileDescriptor? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || HeyMeld.audioSourceBroken(this)) return null
        return try {
            val (read, write) = ParcelFileDescriptor.createPipe()
            val out = ParcelFileDescriptor.AutoCloseOutputStream(write)
            history.toList().takeLast(2).forEach { out.write(toBytes(it)) }
            commandSink = out
            read
        } catch (e: IOException) {
            null
        }
    }

    private fun closeSink() {
        val sink = commandSink
        commandSink = null
        runCatching { sink?.close() }
    }

    private fun toBytes(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            val s = samples[i].toInt()
            out[i * 2] = (s and 0xff).toByte()
            out[i * 2 + 1] = (s shr 8 and 0xff).toByte()
        }
        return out
    }

    // endregion

    // region command handling (main thread)

    private fun onWakeWord(readEnd: ParcelFileDescriptor?) {
        duck()
        scope.launch {
            try {
                handleCommand(readEnd)
            } catch (e: Exception) {
                Timber.tag(TAG).e(e, "Voice command failed")
                speaker.say("Qualcosa è andato storto")
            } finally {
                closeSink()
                unduck()
                detector.reset()
                cooldownUntil = System.currentTimeMillis() + 1_000
                mode = Mode.LISTEN
            }
        }
    }

    private suspend fun handleCommand(readEnd: ParcelFileDescriptor?) {
        if (!recognizer.available) {
            speaker.say("Il riconoscimento vocale non è disponibile su questo telefono")
            return
        }
        var outcome = if (readEnd != null) {
            recognizer.listen(readEnd).also {
                runCatching { readEnd.close() }
                closeSink()
            }
        } else {
            listenWithOwnMic()
        }

        if (readEnd != null && outcome is CommandRecognizer.Outcome.Failed && outcome.error.isAudioSourceError()) {
            Timber.tag(TAG).w("Recognizer refused our audio stream (error %d), switching to its own microphone", outcome.error)
            HeyMeld.markAudioSourceBroken(this)
            mode = Mode.BUSY
            speaker.say("Scusa, ripeti il comando")
            outcome = listenWithOwnMic()
        }
        mode = Mode.BUSY

        when (outcome) {
            CommandRecognizer.Outcome.NothingHeard -> Unit
            is CommandRecognizer.Outcome.Failed -> speaker.say(
                if (outcome.error == SpeechRecognizer.ERROR_NETWORK || outcome.error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) {
                    "Non riesco a collegarmi a internet"
                } else {
                    "Non ho capito"
                },
            )
            is CommandRecognizer.Outcome.Text -> {
                val command = VoiceCommandParser.parseBest(outcome.alternatives)
                Timber.tag(TAG).i("Heard %s -> %s", outcome.alternatives.firstOrNull(), command)
                val service = musicService?.takeIf { it.isPlayerReady.value }
                if (service == null) {
                    speaker.say("Meld non è pronto, riprova tra un attimo")
                    return
                }
                val reply = executor.execute(service, command)
                speaker.say(reply)
                if (command == VoiceCommand.Pause) keepPaused(service)
            }
        }
    }

    private suspend fun listenWithOwnMic(): CommandRecognizer.Outcome {
        mode = Mode.HANDOFF
        var waited = 0
        while (!micReleased && waited < 1_000) {
            delay(20)
            waited += 20
        }
        val outcome = recognizer.listen(null)
        mode = Mode.BUSY
        return outcome
    }

    /** The recognizer may hand audio focus back to Meld after we paused, which would resume playback. */
    private fun keepPaused(service: MusicService) {
        scope.launch {
            repeat(3) {
                delay(600)
                if (service.player.isPlaying) service.player.pause()
            }
        }
    }

    private fun Int.isAudioSourceError() = this == SpeechRecognizer.ERROR_CLIENT ||
        this == SpeechRecognizer.ERROR_AUDIO ||
        this == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ||
        this == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED ||
        this == SpeechRecognizer.ERROR_SERVER_DISCONNECTED ||
        this == SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT

    private val meldPlayer get() = musicService?.takeIf { it.isPlayerReady.value }?.player

    private fun duck() {
        val player = meldPlayer ?: return
        if (duckedFrom != null) return
        duckedFrom = player.volume
        player.volume = player.volume * DUCK_FACTOR
    }

    private fun unduck() {
        val previous = duckedFrom ?: return
        duckedFrom = null
        val player = meldPlayer ?: return
        if (player.volume < previous) player.volume = previous
    }

    private fun stopIfMeldClosed() {
        val meldVisible = getSystemService(android.app.ActivityManager::class.java).appTasks.isNotEmpty()
        if (!meldVisible && meldPlayer?.isPlaying != true) stopSelf()
    }

    // endregion

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Hey Meld", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Comandi vocali «Hey Meld»"
            setShowBadge(false)
            setSound(null, null)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(muted: Boolean) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(if (muted) R.drawable.mic_off else R.drawable.mic)
        .setContentTitle(if (muted) "Hey Meld in pausa" else "Hey Meld in ascolto")
        .setContentText(if (muted) "Tocca «Riattiva» per i comandi vocali" else "Di' «Hey Meld» e poi il comando")
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(
            PendingIntent.getActivity(
                this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .addAction(
            if (muted) R.drawable.mic else R.drawable.mic_off,
            if (muted) "Riattiva" else "Silenzia",
            PendingIntent.getService(
                this, 1, Intent(this, HeyMeldService::class.java).setAction(ACTION_TOGGLE_MUTE),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        )
        .build()

    companion object {
        private const val TAG = "HeyMeld"
        private const val CHANNEL_ID = "hey_meld"
        private const val NOTIFICATION_ID = 0x4D45
        private const val PREBUFFER_CHUNKS = 4
        private const val DUCK_FACTOR = 0.15f
        const val ACTION_TOGGLE_MUTE = "com.metrolist.music.heymeld.TOGGLE_MUTE"
    }
}
