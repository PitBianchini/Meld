package com.metrolist.music.heymeld

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class WakeTrainerTest {
    private val rnd = Random(42)
    private fun rand(n: Int, scale: Float = 0.5f) = FloatArray(n) { (rnd.nextFloat() * 2 - 1) * scale }

    private fun smallHead(): WakeDetectorHead {
        val frames = 2
        val dim = 3
        val hidden = listOf(6 to 4, 4 to 4)
        val layers = hidden.map { (i, o) ->
            WakeWordDetector.WakeHead.Layer(i, o, rand(i * o), rand(o), FloatArray(o) { 1f + rnd.nextFloat() * 0.2f }, rand(o, 0.1f))
        }
        return WakeWordDetector.WakeHead(frames, dim, layers, rand(4), 0.1f, 0.5f, 1)
    }

    private fun perturbed(h: WakeDetectorHead, array: Int, index: Int, delta: Float): WakeDetectorHead {
        // same order as WakeTrainer.Params.arrays(): all W, all b, all gamma, all beta, outW, then outB
        val n = h.layers.size
        val ws = h.layers.map { it.w.copyOf() }
        val bs = h.layers.map { it.b.copyOf() }
        val gs = h.layers.map { it.gamma.copyOf() }
        val bes = h.layers.map { it.beta.copyOf() }
        val outW = h.outW.copyOf()
        var outB = h.outB
        val all = ws + bs + gs + bes + listOf(outW)
        if (array < all.size) all[array][index] += delta else outB += delta
        val layers = (0 until n).map { WakeWordDetector.WakeHead.Layer(h.layers[it].inSize, h.layers[it].outSize, ws[it], bs[it], gs[it], bes[it]) }
        return WakeWordDetector.WakeHead(h.frames, h.dim, layers, outW, outB, h.threshold, h.consecutive)
    }

    @Test
    fun gradientMatchesFiniteDifferences() {
        val base = smallHead()
        val trainer = WakeTrainer(base)
        // evaluate away from the base weights so the L2 term is exercised too
        val point = perturbed(perturbed(base, 0, 3, 0.2f), 8, 1, -0.3f)
        val examples = List(6) { WakeTrainer.Example(rand(6, 1f), if (it % 2 == 0) 1f else 0f, if (it % 2 == 0) 1f else 3f) }
        val l2 = 0.01f
        val grads = trainer.gradient(point, examples, l2)
        var checked = 0
        for (a in grads.indices) {
            for (i in grads[a].indices) {
                val eps = 1e-3f
                val num = (trainer.loss(perturbed(point, a, i, eps), examples, l2) - trainer.loss(perturbed(point, a, i, -eps), examples, l2)) / (2 * eps)
                assertEquals("array $a index $i", num, grads[a][i].toDouble(), 2e-3 + 2e-2 * kotlin.math.abs(num))
                checked++
            }
        }
        assertTrue(checked > 50)
    }

    @Test
    fun trainingLearnsSeparableExamples() {
        val base = smallHead()
        val pos = List(40) { WakeTrainer.Example(FloatArray(6) { 1f + rnd.nextFloat() * 0.3f }, 1f, 1f) }
        val neg = List(40) { WakeTrainer.Example(FloatArray(6) { -1f - rnd.nextFloat() * 0.3f }, 0f, 1f) }
        val tuned = WakeTrainer(base).train(pos + neg, epochs = 60, lr = 1e-2f, l2 = 1e-4f, batch = 8)
        val posScore = pos.map { tuned.predictFlat(it.x) }.average()
        val negScore = neg.map { tuned.predictFlat(it.x) }.average()
        assertTrue("pos $posScore neg $negScore", posScore > 0.9 && negScore < 0.1)
    }
}
