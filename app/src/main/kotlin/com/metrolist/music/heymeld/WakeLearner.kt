package com.metrolist.music.heymeld

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import timber.log.Timber
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import kotlin.random.Random

/**
 * Makes "Hey Meld" better at the user's own voice and surroundings over time.
 *
 * Examples are labelled by what happens after a detection:
 *  - a command that is understood means the wake word was really said (positive), and so were the
 *    almost-detections in the seconds before (the user had to repeat it);
 *  - a detection followed by a transcript without "Hey Meld" and without a command is a false
 *    trigger (hard negative), e.g. a song lyric;
 *  - now and then, ordinary background (music, TV, talking) is kept as a negative.
 * Every few new examples the head is fine-tuned on the phone ([WakeTrainer]) and kept only if it
 * does at least as well as before on held-out examples.
 */
class WakeLearner(context: Context, private val scope: CoroutineScope) {

    class Snapshot(val detection: FloatArray, val nearMisses: List<FloatArray>)

    private class Recent(val window: FloatArray, val score: Float, val at: Long)

    private val dir = File(context.filesDir, "heymeld").apply { mkdirs() }
    private val positivesFile = File(dir, "positives.bin")
    private val negativesFile = File(dir, "negatives.bin")
    private val hardFile = File(dir, "false_triggers.bin")
    private val personalFile = File(dir, "personal.bin")
    private val personalBaseFile = File(dir, "personal.base")

    private val positives = load(positivesFile)
    private val negatives = load(negativesFile)
    private val hard = load(hardFile)
    private val recent = ArrayDeque<Recent>()
    private var lastBackground = 0L
    private var newSinceTraining = 0
    private var training = false
    private var lastTraining = 0L
    private val rnd = Random(System.currentTimeMillis())

    var onNewModel: ((WakeDetectorHead) -> Unit)? = null

    /** Called by the audio thread for every chunk. */
    fun onChunk(detector: WakeWordDetector, score: Float, musicPlaying: Boolean) {
        val now = System.currentTimeMillis()
        val window = detector.lastWindow()
        synchronized(recent) {
            recent.addLast(Recent(window, score, now))
            while (recent.size > RECENT_CHUNKS) recent.removeFirst()
        }
        // keep some ordinary background as negatives, more often while music plays
        val every = if (musicPlaying) 15_000L else 45_000L
        if (score < 0.2f && now - lastBackground > every) {
            lastBackground = now
            synchronized(negatives) { addCapped(negatives, window, MAX_NEGATIVES) }
            if (rnd.nextInt(20) == 0) save(negativesFile, negatives)
        }
    }

    /** Called by the audio thread at a detection: the best window now and probable earlier attempts. */
    fun snapshot(): Snapshot {
        synchronized(recent) {
            val now = System.currentTimeMillis()
            val last = recent.lastOrNull()?.window ?: FloatArray(0)
            val near = mutableListOf<FloatArray>()
            val list = recent.toList()
            for (i in 1 until list.size - 1) {
                val r = list[i]
                val age = now - r.at
                // a local peak of the score 0.8-6 s before the detection
                if (age in 800L..6_000L && r.score >= NEAR_MISS && r.score >= list[i - 1].score && r.score >= list[i + 1].score) {
                    near += r.window
                }
            }
            return Snapshot(last, near.takeLast(3))
        }
    }

    fun confirmed(s: Snapshot) {
        if (s.detection.isEmpty()) return
        synchronized(positives) {
            addCapped(positives, s.detection, MAX_POSITIVES)
            s.nearMisses.forEach { addCapped(positives, it, MAX_POSITIVES) }
        }
        save(positivesFile, positives)
        newSinceTraining += 1 + s.nearMisses.size
        Timber.tag(TAG).i("wake positives %d (+%d near misses)", positives.size, s.nearMisses.size)
        maybeTrain()
    }

    fun falseTrigger(s: Snapshot) {
        if (s.detection.isEmpty()) return
        synchronized(hard) { addCapped(hard, s.detection, MAX_HARD) }
        save(hardFile, hard)
        newSinceTraining++
        maybeTrain()
    }

    /** The personalized head, if it was trained on top of the current base model. */
    fun loadPersonal(base: WakeDetectorHead): WakeDetectorHead? = try {
        if (personalFile.exists() && personalBaseFile.exists() && personalBaseFile.readText() == signature(base)) {
            WakeWordDetector.WakeHead.parse(personalFile.readBytes()).takeIf { it.frames == base.frames && it.dim == base.dim }
        } else {
            null
        }
    } catch (e: Exception) {
        null
    }

    private fun signature(h: WakeDetectorHead) = h.toBytes().contentHashCode().toString()

    fun reset() {
        synchronized(positives) { positives.clear() }
        synchronized(hard) { hard.clear() }
        listOf(positivesFile, hardFile, personalFile, personalBaseFile).forEach { it.delete() }
    }

    val examplesCount get() = positives.size

    private fun maybeTrain() {
        val now = System.currentTimeMillis()
        if (training || positives.size < MIN_POSITIVES || negatives.size + hard.size < MIN_NEGATIVES) return
        if (newSinceTraining < 3 || now - lastTraining < 5 * 60_000L) return
        training = true
        lastTraining = now
        newSinceTraining = 0
        val pos = synchronized(positives) { positives.toList() }
        val neg = synchronized(negatives) { negatives.toList() }
        val hardNeg = synchronized(hard) { hard.toList() }
        val base = baseHead ?: run {
            training = false
            return
        }
        scope.launch(Dispatchers.Default) {
            try {
                val result = fineTune(base, pos, neg, hardNeg)
                if (result != null) {
                    personalFile.writeBytes(result.toBytes())
                    personalBaseFile.writeText(signature(base))
                    onNewModel?.invoke(result)
                }
            } catch (e: Throwable) {
                Timber.tag(TAG).w(e, "personalization failed")
            } finally {
                training = false
            }
        }
    }

    var baseHead: WakeDetectorHead? = null
    var currentHead: WakeDetectorHead? = null

    private fun fineTune(base: WakeDetectorHead, pos: List<FloatArray>, neg: List<FloatArray>, hardNeg: List<FloatArray>): WakeDetectorHead? {
        val split = Random(1)
        fun <T> holdOut(list: List<T>) = list.partition { split.nextInt(5) != 0 }
        val (posTr, posVal) = holdOut(pos)
        val (negTr, negVal) = holdOut(neg)
        val (hardTr, hardVal) = holdOut(hardNeg)
        if (posVal.isEmpty() || negVal.isEmpty()) return null

        // negatives are far more numerous in real life: weight them accordingly
        val examples = posTr.map { WakeTrainer.Example(it, 1f, 2f) } +
            negTr.map { WakeTrainer.Example(it, 0f, 1f) } +
            hardTr.map { WakeTrainer.Example(it, 0f, 4f) }
        val tuned = WakeTrainer(base).train(examples)

        val old = currentHead ?: base
        fun recall(h: WakeDetectorHead, t: Float) = posVal.count { h.predictFlat(it) >= t }.toFloat() / posVal.size
        fun accept(h: WakeDetectorHead, t: Float, l: List<FloatArray>) = if (l.isEmpty()) 0f else l.count { h.predictFlat(it) >= t }.toFloat() / l.size

        val oldRecall = recall(old, old.threshold)
        val oldNeg = accept(old, old.threshold, negVal)
        val oldHard = accept(old, old.threshold, hardVal)
        // the most permissive threshold that doesn't accept more background than the current model
        var best: Pair<Float, Float>? = null
        for (t in THRESHOLDS) {
            if (accept(tuned, t, negVal) > maxOf(oldNeg, 0.003f)) continue
            if (accept(tuned, t, hardVal) > maxOf(oldHard, 0.1f)) continue
            val r = recall(tuned, t)
            if (best == null || r > best.second) best = t to r
        }
        val chosen = best ?: return null
        Timber.tag(TAG).i(
            "personal model: recall %.2f -> %.2f at threshold %.2f (background accepted %.4f)",
            oldRecall, chosen.second, chosen.first, accept(tuned, chosen.first, negVal),
        )
        if (chosen.second < oldRecall) return null
        return tuned.withThreshold(chosen.first)
    }

    private fun addCapped(list: MutableList<FloatArray>, x: FloatArray, cap: Int) {
        if (list.size < cap) list += x else list[rnd.nextInt(cap)] = x
    }

    private fun load(f: File): MutableList<FloatArray> {
        if (!f.exists()) return mutableListOf()
        return try {
            DataInputStream(f.inputStream().buffered()).use { inp ->
                val n = inp.readInt()
                val len = inp.readInt()
                MutableList(n) { FloatArray(len) { inp.readFloat() } }
            }
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    private fun save(f: File, list: MutableList<FloatArray>) {
        val copy = synchronized(list) { list.toList() }
        scope.launch(Dispatchers.IO) {
            runCatching {
                val tmp = File(f.path + ".tmp")
                DataOutputStream(tmp.outputStream().buffered()).use { out ->
                    out.writeInt(copy.size)
                    out.writeInt(copy.firstOrNull()?.size ?: 0)
                    copy.forEach { w -> w.forEach(out::writeFloat) }
                }
                tmp.renameTo(f)
            }
        }
    }

    companion object {
        private const val TAG = "HeyMeld"
        private const val RECENT_CHUNKS = 80
        private const val NEAR_MISS = 0.4f
        private const val MAX_POSITIVES = 400
        private const val MAX_NEGATIVES = 2500
        private const val MAX_HARD = 300
        private const val MIN_POSITIVES = 6
        private const val MIN_NEGATIVES = 150
        private val THRESHOLDS = listOf(0.5f, 0.6f, 0.7f, 0.75f, 0.8f, 0.85f, 0.9f, 0.93f, 0.95f, 0.97f)
    }
}
