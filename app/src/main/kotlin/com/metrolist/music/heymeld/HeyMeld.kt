package com.metrolist.music.heymeld

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.media3.session.CommandButton
import com.metrolist.music.R
import com.metrolist.music.constants.MediaSessionConstants
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import timber.log.Timber

/** Shared state of the "Hey Meld" voice control, used by the service and Meld's media notification. */
object HeyMeld {
    private const val PREFS = "hey_meld"
    private const val KEY_MUTED = "muted"
    private const val KEY_ASKED_MIC = "asked_mic"
    private const val KEY_AUDIO_SOURCE_BROKEN = "audio_source_broken"
    private const val MIC_REQUEST_CODE = 4_711

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running.asStateFlow()

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()

    private var appContext: Context? = null

    internal fun init(context: Context) {
        appContext = context.applicationContext
        _muted.value = prefs(context).getBoolean(KEY_MUTED, false)
    }

    internal fun setRunning(value: Boolean) {
        _running.value = value
    }

    fun toggleMuted() = setMuted(!_muted.value)

    /** Mic toggle shown first in Meld's media notification while Hey Meld is running. */
    fun notificationButton(): CommandButton? {
        if (!_running.value) return null
        val muted = _muted.value
        return CommandButton.Builder()
            .setDisplayName(if (muted) "Riattiva Hey Meld" else "Silenzia Hey Meld")
            .setIconResId(if (muted) R.drawable.mic_off else R.drawable.mic)
            .setSessionCommand(MediaSessionConstants.CommandToggleHeyMeld)
            .build()
    }

    fun setMuted(value: Boolean) {
        _muted.value = value
        appContext?.let { prefs(it).edit().putBoolean(KEY_MUTED, value).apply() }
    }

    internal fun audioSourceBroken(context: Context) = prefs(context).getBoolean(KEY_AUDIO_SOURCE_BROKEN, false)

    internal fun markAudioSourceBroken(context: Context) =
        prefs(context).edit().putBoolean(KEY_AUDIO_SOURCE_BROKEN, true).apply()

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun hasMic(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Called whenever a Meld screen comes to the foreground: the only moment Android lets us open the mic. */
    internal fun onForeground(activity: Activity) {
        if (!WakeWordDetector.hasModel(activity)) return
        if (!hasMic(activity)) {
            val p = prefs(activity)
            if (!p.getBoolean(KEY_ASKED_MIC, false)) {
                p.edit().putBoolean(KEY_ASKED_MIC, true).apply()
                ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST_CODE)
            }
            return
        }
        if (_running.value) return
        runCatching {
            ContextCompat.startForegroundService(activity, Intent(activity, HeyMeldService::class.java))
        }.onFailure { Timber.tag("HeyMeld").w(it, "Could not start Hey Meld") }
    }
}

/** Starts Hey Meld when Meld's UI is opened, without touching Meld's own startup code. */
class HeyMeldStarter : ContentProvider() {
    override fun onCreate(): Boolean {
        val app = context?.applicationContext as? Application ?: return false
        HeyMeld.init(app)
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) = HeyMeld.onForeground(activity)
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
