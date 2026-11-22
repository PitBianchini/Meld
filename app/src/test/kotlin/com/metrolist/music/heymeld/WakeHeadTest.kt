package com.metrolist.music.heymeld

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Checks the Kotlin classifier head against PyTorch outputs written by heymeld/training/train.py. */
class WakeHeadTest {
    @Test
    fun matchesTrainingOutputs() {
        val model = File("src/main/assets/heymeld/hey_meld.bin")
        val vectors = File("src/test/resources/heymeld/vectors.txt")
        assumeTrue("model not trained yet", model.exists() && vectors.exists())

        val head = WakeWordDetector.WakeHead.parse(model.readBytes())
        vectors.readLines().filter { it.isNotBlank() }.forEach { line ->
            val values = line.trim().split(' ').map { it.toFloat() }
            val expected = values.first()
            val flat = values.drop(1)
            val window = flat.chunked(96).map { it.toFloatArray() }
            assertEquals(16, window.size)
            assertEquals(expected, head.predict(window), 1e-4f)
        }
    }
}
