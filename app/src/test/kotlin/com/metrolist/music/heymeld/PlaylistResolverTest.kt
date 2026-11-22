package com.metrolist.music.heymeld

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaylistResolverTest {
    private fun score(spoken: String, name: String) = PlaylistResolver.similarity(
        PlaylistResolver.significantTokens(spoken),
        PlaylistResolver.significantTokens(name),
    )

    @Test
    fun matchesSpokenPlaylistNames() {
        assertEquals(1.0, score("miei migliori 50", "I miei migliori 50"), 1e-9)
        assertEquals(1.0, score("estate 2024", "Estate 2024 🔥"), 1e-9)
        assertEquals(1.0, score("la playlist per correre", "Per correre"), 1e-9)
        assertTrue(score("rock italiano", "Rock Italiano anni 90") < 0.85)
        assertTrue(score("rock italiano", "Rock Italiano anni 90") >= 0.5)
        assertTrue(score("vasco rossi", "Lo-fi per studiare") < 0.3)
    }
}
