package com.metrolist.music.heymeld

import android.content.Context
import org.tensorflow.lite.Interpreter
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Streaming openWakeWord pipeline (16 kHz mono PCM, 80 ms chunks):
 * melspectrogram (TFLite) -> Google speech_embedding (TFLite) -> "Hey Meld" classifier head.
 * Mirrors openwakeword.utils.AudioFeatures._streaming_features for one 1280-sample chunk at a time.
 */
class WakeWordDetector private constructor(
    private val melspec: Interpreter,
    private val embedding: Interpreter,
    private val head: WakeHead,
) : Closeable {

    private val raw = ShortArray(RAW_WINDOW)
    private var rawFilled = 0
    private val melInput = Array(1) { FloatArray(RAW_WINDOW) }
    private val melOutput = Array(1) { Array(1) { Array(MEL_FRAMES_PER_CHUNK) { FloatArray(MEL_BINS) } } }
    private val melFrames = ArrayDeque<FloatArray>()
    private val embInput = Array(1) { Array(EMB_WINDOW) { Array(MEL_BINS) { FloatArray(1) } } }
    private val embOutput = Array(1) { Array(1) { Array(1) { FloatArray(EMB_DIM) } } }
    private val features = ArrayDeque<FloatArray>()
    private var chunksSinceReset = 0

    init {
        melspec.resizeInput(0, intArrayOf(1, RAW_WINDOW))
        melspec.allocateTensors()
        reset()
    }

    /** Clears audio history (e.g. after a detection or after the mic was paused). */
    @Synchronized
    fun reset() {
        raw.fill(0)
        rawFilled = 0
        melFrames.clear()
        repeat(EMB_WINDOW) { melFrames.addLast(FloatArray(MEL_BINS) { 1f }) }
        features.clear()
        repeat(head.frames) { features.addLast(FloatArray(EMB_DIM)) }
        chunksSinceReset = 0
    }

    /** @param chunk exactly [CHUNK] samples. @return wake word probability 0..1. */
    @Synchronized
    fun process(chunk: ShortArray): Float {
        require(chunk.size == CHUNK)
        System.arraycopy(raw, CHUNK, raw, 0, RAW_WINDOW - CHUNK)
        System.arraycopy(chunk, 0, raw, RAW_WINDOW - CHUNK, CHUNK)
        rawFilled = (rawFilled + CHUNK).coerceAtMost(RAW_WINDOW)

        val input = melInput[0]
        for (i in 0 until RAW_WINDOW) input[i] = raw[i].toFloat()
        melspec.run(melInput, melOutput)
        for (frame in melOutput[0][0]) {
            melFrames.addLast(FloatArray(MEL_BINS) { frame[it] / 10f + 2f })
        }
        while (melFrames.size > EMB_WINDOW) melFrames.removeFirst()

        for (f in 0 until EMB_WINDOW) {
            val src = melFrames[f]
            val dst = embInput[0][f]
            for (b in 0 until MEL_BINS) dst[b][0] = src[b]
        }
        embedding.run(embInput, embOutput)
        features.addLast(embOutput[0][0][0].copyOf())
        while (features.size > head.frames) features.removeFirst()

        chunksSinceReset++
        // openWakeWord ignores the first 5 predictions while buffers fill.
        if (chunksSinceReset < WARMUP_CHUNKS) return 0f
        return head.predict(features)
    }

    val threshold: Float get() = head.threshold

    override fun close() {
        melspec.close()
        embedding.close()
    }

    /**
     * Small fully connected classifier exported by the training workflow
     * (Linear -> LayerNorm -> ReLU blocks, then Linear -> Sigmoid).
     * Binary layout, little endian: magic "HMW1", frames, dim, layerCount,
     * then per hidden layer: in, out, W[out][in], b[out], gamma[out], beta[out]; final: in, W[in], b;
     * then the suggested detection threshold.
     */
    class WakeHead(
        val frames: Int,
        private val dim: Int,
        private val layers: List<Layer>,
        private val outW: FloatArray,
        private val outB: Float,
        val threshold: Float,
    ) {
        class Layer(val inSize: Int, val outSize: Int, val w: FloatArray, val b: FloatArray, val gamma: FloatArray, val beta: FloatArray)

        fun predict(window: List<FloatArray>): Float {
            var x = FloatArray(frames * dim)
            window.forEachIndexed { i, f -> System.arraycopy(f, 0, x, i * dim, dim) }
            for (l in layers) {
                val y = FloatArray(l.outSize)
                for (o in 0 until l.outSize) {
                    var s = l.b[o]
                    val row = o * l.inSize
                    for (i in 0 until l.inSize) s += l.w[row + i] * x[i]
                    y[o] = s
                }
                var mean = 0f
                for (v in y) mean += v
                mean /= y.size
                var variance = 0f
                for (v in y) variance += (v - mean) * (v - mean)
                variance /= y.size
                val inv = 1f / sqrt(variance + 1e-5f)
                for (o in y.indices) y[o] = max(0f, (y[o] - mean) * inv * l.gamma[o] + l.beta[o])
                x = y
            }
            var s = outB
            for (i in x.indices) s += outW[i] * x[i]
            return (1.0 / (1.0 + exp(-s.toDouble()))).toFloat()
        }

        companion object {
            fun parse(bytes: ByteArray): WakeHead {
                val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                val magic = ByteArray(4).also { buf.get(it) }
                require(String(magic) == "HMW1") { "Not a Hey Meld model" }
                val frames = buf.int
                val dim = buf.int
                val count = buf.int
                fun floats(n: Int) = FloatArray(n) { buf.float }
                val layers = List(count) {
                    val inSize = buf.int
                    val outSize = buf.int
                    Layer(inSize, outSize, floats(inSize * outSize), floats(outSize), floats(outSize), floats(outSize))
                }
                val lastIn = buf.int
                val outW = floats(lastIn)
                val outB = buf.float
                val threshold = if (buf.remaining() >= 4) buf.float else 0.5f
                return WakeHead(frames, dim, layers, outW, outB, threshold)
            }
        }
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHUNK = 1280
        private const val RAW_WINDOW = CHUNK + 160 * 3
        private const val MEL_FRAMES_PER_CHUNK = 8
        private const val MEL_BINS = 32
        private const val EMB_WINDOW = 76
        private const val EMB_DIM = 96
        private const val WARMUP_CHUNKS = 5

        const val MODEL_ASSET = "heymeld/hey_meld.bin"

        fun hasModel(context: Context): Boolean =
            runCatching { context.assets.open(MODEL_ASSET).close() }.isSuccess

        fun create(context: Context): WakeWordDetector {
            fun load(name: String): ByteBuffer {
                val bytes = context.assets.open(name).use { it.readBytes() }
                return ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply {
                    put(bytes)
                    rewind()
                }
            }
            val options = Interpreter.Options().setNumThreads(1)
            val head = WakeHead.parse(context.assets.open(MODEL_ASSET).use { it.readBytes() })
            return WakeWordDetector(
                Interpreter(load("heymeld/melspectrogram.tflite"), options),
                Interpreter(load("heymeld/embedding_model.tflite"), options),
                head,
            )
        }
    }
}
