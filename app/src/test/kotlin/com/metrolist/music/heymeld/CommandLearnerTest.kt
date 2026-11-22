package com.metrolist.music.heymeld

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommandLearnerTest {
    private var stored: String? = null
    private fun learner() = CommandLearner(stored) { stored = it }

    @Test
    fun remembersExactPhrases() {
        val l = learner()
        l.learn("Hey Meld, cambia aria", VoiceCommand.Next)
        assertEquals(VoiceCommand.Next, learner().match(listOf("cambia aria")))
        assertEquals(VoiceCommand.Next, learner().match(listOf("ehi meld cambia l'aria")))
        assertNull(learner().match(listOf("cambia playlist")))
    }

    @Test
    fun turnsPhrasesWithANameIntoTemplates() {
        val l = learner()
        l.learn("sparami un po' di vasco rossi", VoiceCommand.Play("vasco rossi", PlayKind.ARTIST))
        assertEquals(VoiceCommand.Play("ultimo", PlayKind.ARTIST), learner().match(listOf("sparami un po' di ultimo")))
        assertEquals(VoiceCommand.Play("vasco rossi", PlayKind.ARTIST), learner().match(listOf("Hey Meld sparami un po' di Vasco Rossi")))
    }

    @Test
    fun forgetsTheLastLesson() {
        val l = learner()
        l.learn("cambia aria", VoiceCommand.Next)
        l.learn("zitto un attimo", VoiceCommand.Pause)
        l.forgetLast()
        assertNull(learner().match(listOf("zitto un attimo")))
        assertEquals(VoiceCommand.Next, learner().match(listOf("cambia aria")))
    }

    @Test
    fun recognizesForgetRequests() {
        assertEquals(CommandLearner.Companion.Meta.FORGET_LAST, CommandLearner.meta(listOf("Hey Meld dimentica l'ultima cosa che ti ho insegnato")))
        assertEquals(CommandLearner.Companion.Meta.FORGET_VOICE, CommandLearner.meta(listOf("dimentica la mia voce")))
        assertNull(CommandLearner.meta(listOf("passa alla prossima")))
    }

    @Test
    fun encodesEveryCommand() {
        listOf(
            VoiceCommand.Next, VoiceCommand.VolumeSet(40), VoiceCommand.Shuffle(null), VoiceCommand.Like(false),
            VoiceCommand.Play("estate 2024", PlayKind.PLAYLIST, shuffle = true), VoiceCommand.Enqueue("yellow", next = true),
        ).forEach { assertEquals(it, CommandLearner.decode(CommandLearner.encode(it)!!, null)) }
    }
}
