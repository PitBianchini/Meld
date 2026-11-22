package com.metrolist.music.heymeld

import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * Fine-tunes the "Hey Meld" classifier head on the phone, with examples of the user's own voice and
 * of the sounds around them. Always starts from the shipped model and is pulled back towards it
 * (L2 to the base weights), so a few bad examples can't wreck the detector.
 * Pure Kotlin so the maths can be unit tested on the JVM.
 */
class WakeTrainer(private val base: WakeDetectorHead) {

    /** Mutable copy of the head parameters. */
    private class Params(val w: Array<FloatArray>, val b: Array<FloatArray>, val g: Array<FloatArray>, val be: Array<FloatArray>, val outW: FloatArray, var outB: Float) {
        fun copy() = Params(w.map { it.copyOf() }.toTypedArray(), b.map { it.copyOf() }.toTypedArray(), g.map { it.copyOf() }.toTypedArray(), be.map { it.copyOf() }.toTypedArray(), outW.copyOf(), outB)
        fun zero() = Params(w.map { FloatArray(it.size) }.toTypedArray(), b.map { FloatArray(it.size) }.toTypedArray(), g.map { FloatArray(it.size) }.toTypedArray(), be.map { FloatArray(it.size) }.toTypedArray(), FloatArray(outW.size), 0f)
        fun arrays(): List<FloatArray> = w.toList() + b.toList() + g.toList() + be.toList() + listOf(outW)
    }

    private val sizes = base.layers.map { it.inSize to it.outSize }
    private val baseParams = Params(
        base.layers.map { it.w.copyOf() }.toTypedArray(),
        base.layers.map { it.b.copyOf() }.toTypedArray(),
        base.layers.map { it.gamma.copyOf() }.toTypedArray(),
        base.layers.map { it.beta.copyOf() }.toTypedArray(),
        base.outW.copyOf(),
        base.outB,
    )

    class Example(val x: FloatArray, val label: Float, val weight: Float)

    /** Logit of one example with the given parameters, keeping what backprop needs. */
    private class Trace(val inputs: Array<FloatArray>, val normed: Array<FloatArray>, val invStd: FloatArray, val pre: Array<FloatArray>, var logit: Float)

    private fun forward(p: Params, x: FloatArray): Trace {
        val n = sizes.size
        val inputs = arrayOfNulls<FloatArray>(n + 1)
        val normed = arrayOfNulls<FloatArray>(n)
        val pre = arrayOfNulls<FloatArray>(n)
        val invStd = FloatArray(n)
        var h = x
        for (l in 0 until n) {
            val (inS, outS) = sizes[l]
            inputs[l] = h
            val z = FloatArray(outS)
            val w = p.w[l]
            for (o in 0 until outS) {
                var s = p.b[l][o]
                val row = o * inS
                for (i in 0 until inS) s += w[row + i] * h[i]
                z[o] = s
            }
            var mean = 0f
            for (v in z) mean += v
            mean /= outS
            var variance = 0f
            for (v in z) variance += (v - mean) * (v - mean)
            variance /= outS
            val inv = 1f / sqrt(variance + EPS)
            invStd[l] = inv
            val y = FloatArray(outS) { (z[it] - mean) * inv }
            normed[l] = y
            val a = FloatArray(outS) { y[it] * p.g[l][it] + p.be[l][it] }
            pre[l] = a
            h = FloatArray(outS) { maxOf(0f, a[it]) }
        }
        inputs[n] = h
        var logit = p.outB
        for (i in h.indices) logit += p.outW[i] * h[i]
        @Suppress("UNCHECKED_CAST")
        return Trace(inputs as Array<FloatArray>, normed as Array<FloatArray>, invStd, pre as Array<FloatArray>, logit)
    }

    /** Adds dLoss/dParams for one example (dLogit already includes label and weight) into [grad]. */
    private fun backward(p: Params, t: Trace, dLogit: Float, grad: Params) {
        val n = sizes.size
        val last = t.inputs[n]
        var dh = FloatArray(last.size) { p.outW[it] * dLogit }
        for (i in last.indices) grad.outW[i] += last[i] * dLogit
        grad.outB += dLogit
        for (l in n - 1 downTo 0) {
            val (inS, outS) = sizes[l]
            val da = FloatArray(outS) { if (t.pre[l][it] > 0f) dh[it] else 0f }
            val y = t.normed[l]
            val dy = FloatArray(outS)
            for (o in 0 until outS) {
                grad.g[l][o] += da[o] * y[o]
                grad.be[l][o] += da[o]
                dy[o] = da[o] * p.g[l][o]
            }
            var meanDy = 0f
            var meanDyY = 0f
            for (o in 0 until outS) {
                meanDy += dy[o]
                meanDyY += dy[o] * y[o]
            }
            meanDy /= outS
            meanDyY /= outS
            val dz = FloatArray(outS) { (dy[it] - meanDy - y[it] * meanDyY) * t.invStd[l] }
            val input = t.inputs[l]
            val w = p.w[l]
            val dIn = FloatArray(inS)
            for (o in 0 until outS) {
                val g = dz[o]
                if (g == 0f) continue
                grad.b[l][o] += g
                val row = o * inS
                for (i in 0 until inS) {
                    grad.w[l][row + i] += g * input[i]
                    dIn[i] += w[row + i] * g
                }
            }
            dh = dIn
        }
    }

    internal fun loss(p: WakeDetectorHead, examples: List<Example>, l2: Float): Double =
        loss(fromHead(p), examples, l2)

    private fun loss(p: Params, examples: List<Example>, l2: Float): Double {
        var total = 0.0
        for (e in examples) {
            val z = forward(p, e.x).logit.toDouble()
            // numerically stable binary cross-entropy with logits
            total += e.weight * (maxOf(z, 0.0) - z * e.label + ln(1 + exp(-kotlin.math.abs(z))))
        }
        var reg = 0.0
        p.arrays().zip(baseParams.arrays()).forEach { (a, b0) -> for (i in a.indices) reg += (a[i] - b0[i]).let { it * it } }
        return total / examples.size + l2 * reg
    }

    /** Analytic gradient of [loss], exposed for the gradient-check unit test. */
    internal fun gradient(p: WakeDetectorHead, examples: List<Example>, l2: Float): List<FloatArray> {
        val params = fromHead(p)
        val g = params.zero()
        for (e in examples) {
            val t = forward(params, e.x)
            val prob = sigmoid(t.logit)
            backward(params, t, e.weight * (prob - e.label) / examples.size, g)
        }
        g.arrays().zip(params.arrays().zip(baseParams.arrays())).forEach { (ga, pair) ->
            val (a, b0) = pair
            for (i in ga.indices) ga[i] += 2 * l2 * (a[i] - b0[i])
        }
        return g.arrays() + listOf(floatArrayOf(g.outB))
    }

    /**
     * Mini-batch Adam starting from the base model.
     * @return the personalized head (threshold and consecutive copied from the base).
     */
    fun train(examples: List<Example>, epochs: Int = 12, lr: Float = 1e-3f, l2: Float = 1e-3f, batch: Int = 32, seed: Int = 7): WakeDetectorHead {
        val p = baseParams.copy()
        val m = p.zero()
        val v = p.zero()
        var mB = 0f
        var vB = 0f
        val rnd = Random(seed)
        var step = 0
        repeat(epochs) {
            val order = examples.indices.shuffled(rnd)
            for (start in order.indices step batch) {
                val idx = order.subList(start, minOf(order.size, start + batch))
                val g = p.zero()
                for (i in idx) {
                    val e = examples[i]
                    val t = forward(p, e.x)
                    backward(p, t, e.weight * (sigmoid(t.logit) - e.label) / idx.size, g)
                }
                step++
                val b1c = 1 - Math.pow(B1.toDouble(), step.toDouble()).toFloat()
                val b2c = 1 - Math.pow(B2.toDouble(), step.toDouble()).toFloat()
                val ps = p.arrays()
                val gs = g.arrays()
                val ms = m.arrays()
                val vs = v.arrays()
                val bs = baseParams.arrays()
                for (k in ps.indices) {
                    val pa = ps[k]
                    val ga = gs[k]
                    val ma = ms[k]
                    val va = vs[k]
                    val b0 = bs[k]
                    for (i in pa.indices) {
                        val gi = ga[i] + 2 * l2 * (pa[i] - b0[i])
                        ma[i] = B1 * ma[i] + (1 - B1) * gi
                        va[i] = B2 * va[i] + (1 - B2) * gi * gi
                        pa[i] -= lr * (ma[i] / b1c) / (sqrt(va[i] / b2c) + 1e-8f)
                    }
                }
                val gb = g.outB + 2 * l2 * (p.outB - baseParams.outB)
                mB = B1 * mB + (1 - B1) * gb
                vB = B2 * vB + (1 - B2) * gb * gb
                p.outB -= lr * (mB / b1c) / (sqrt(vB / b2c) + 1e-8f)
            }
        }
        return toHead(p, base.threshold)
    }

    private fun toHead(p: Params, threshold: Float) = WakeDetectorHead(
        base.frames, base.dim,
        sizes.indices.map { l -> WakeWordDetector.WakeHead.Layer(sizes[l].first, sizes[l].second, p.w[l].copyOf(), p.b[l].copyOf(), p.g[l].copyOf(), p.be[l].copyOf()) },
        p.outW.copyOf(), p.outB, threshold, base.consecutive,
    )

    private fun fromHead(h: WakeDetectorHead) = Params(
        h.layers.map { it.w.copyOf() }.toTypedArray(),
        h.layers.map { it.b.copyOf() }.toTypedArray(),
        h.layers.map { it.gamma.copyOf() }.toTypedArray(),
        h.layers.map { it.beta.copyOf() }.toTypedArray(),
        h.outW.copyOf(),
        h.outB,
    )

    private companion object {
        const val EPS = 1e-5f
        const val B1 = 0.9f
        const val B2 = 0.999f
        fun sigmoid(z: Float) = (1.0 / (1.0 + exp(-z.toDouble()))).toFloat()
    }
}

typealias WakeDetectorHead = WakeWordDetector.WakeHead
