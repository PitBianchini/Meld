package com.metrolist.music.heymeld

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCommandParserTest {
    private val cases = listOf(
        "Hey Meld, passa la canzone successiva" to VoiceCommand.Next,
        "hey meld passa alla prossima" to VoiceCommand.Next,
        "la canzone successiva" to VoiceCommand.Next,
        "prossima canzone" to VoiceCommand.Next,
        "salta" to VoiceCommand.Next,
        "avanti" to VoiceCommand.Next,
        "canzone precedente" to VoiceCommand.Previous,
        "torna alla canzone precedente" to VoiceCommand.Previous,
        "metti quella di prima" to VoiceCommand.Previous,
        "indietro" to VoiceCommand.Previous,
        "ricomincia" to VoiceCommand.Restart,
        "ricomincia la canzone da capo" to VoiceCommand.Restart,
        "dall'inizio" to VoiceCommand.Restart,
        "stoppa la musica" to VoiceCommand.Pause,
        "Hey Meld stop" to VoiceCommand.Pause,
        "metti in pausa" to VoiceCommand.Pause,
        "ferma la musica" to VoiceCommand.Pause,
        "basta" to VoiceCommand.Pause,
        "riprendi" to VoiceCommand.Resume,
        "continua" to VoiceCommand.Resume,
        "riproduci" to VoiceCommand.Resume,
        "fai ripartire la musica" to VoiceCommand.Resume,
        "alza il volume" to VoiceCommand.VolumeUp,
        "più forte" to VoiceCommand.VolumeUp,
        "abbassa il volume" to VoiceCommand.VolumeDown,
        "più piano" to VoiceCommand.VolumeDown,
        "volume al 50" to VoiceCommand.VolumeSet(50),
        "metti il volume al 30 per cento" to VoiceCommand.VolumeSet(30),
        "volume a cinquanta" to VoiceCommand.VolumeSet(50),
        "volume al massimo" to VoiceCommand.VolumeSet(100),
        "metti in coda Bohemian Rhapsody" to VoiceCommand.Enqueue("bohemian rhapsody", next = false),
        "aggiungi alla coda Thunderstruck" to VoiceCommand.Enqueue("thunderstruck", next = false),
        "metti dopo questa Imagine" to VoiceCommand.Enqueue("imagine", next = true),
        "metti subito dopo Yellow" to VoiceCommand.Enqueue("yellow", next = true),
        "riproduci la playlist allenamento" to VoiceCommand.Play("allenamento", PlayKind.PLAYLIST, shuffle = false),
        "metti la playlist Rock in casuale" to VoiceCommand.Play("rock", PlayKind.PLAYLIST, shuffle = true),
        "casuale" to VoiceCommand.Shuffle(null),
        "attiva la riproduzione casuale" to VoiceCommand.Shuffle(true),
        "disattiva casuale" to VoiceCommand.Shuffle(false),
        "che canzone è" to VoiceCommand.WhatIsPlaying,
        "che canzone è questa" to VoiceCommand.WhatIsPlaying,
        "chi canta questa canzone" to VoiceCommand.WhatIsPlaying,
        "come si chiama questa canzone" to VoiceCommand.WhatIsPlaying,
        "cosa sta suonando" to VoiceCommand.WhatIsPlaying,
        "metti mi piace" to VoiceCommand.Like(true),
        "mi piace" to VoiceCommand.Like(true),
        "aggiungi ai preferiti" to VoiceCommand.Like(true),
        "togli mi piace" to VoiceCommand.Like(false),
        "riproduci Bohemian Rhapsody dei Queen" to VoiceCommand.Play("bohemian rhapsody queen", PlayKind.SONG, shuffle = false),
        "riproduci Blinding Lights" to VoiceCommand.Play("blinding lights", PlayKind.AUTO, shuffle = false),
        "metti qualcosa dei Måneskin" to VoiceCommand.Play("måneskin", PlayKind.ARTIST, shuffle = false),
        "fammi sentire le canzoni di Ultimo" to VoiceCommand.Play("ultimo", PlayKind.ARTIST, shuffle = false),
        "riproduci l'album Random Access Memories" to VoiceCommand.Play("random access memories", PlayKind.ALBUM, shuffle = false),
        "metti l'album dei Pink Floyd" to VoiceCommand.Play("pink floyd", PlayKind.ALBUM, shuffle = false),
        "riproduci le mie canzoni preferite" to VoiceCommand.Play("", PlayKind.LIKED, shuffle = false),
        "metti i miei mi piace" to VoiceCommand.Play("", PlayKind.LIKED, shuffle = false),
        "per favore metti la canzone Bella ciao" to VoiceCommand.Play("bella ciao", PlayKind.SONG, shuffle = false),
        "riproduci Vasco Rossi" to VoiceCommand.Play("vasco rossi", PlayKind.AUTO, shuffle = false),
        "hey meld puoi passare alla prossima" to VoiceCommand.Next,
        "potresti alzare il volume" to VoiceCommand.VolumeUp,
        "mi metti Imagine di John Lennon" to VoiceCommand.Play("imagine john lennon", PlayKind.SONG, shuffle = false),
        "ehi meld riproduci i Coldplay" to VoiceCommand.Play("coldplay", PlayKind.AUTO, shuffle = false),
        "riproduci la canzone di Marinella" to VoiceCommand.Play("di marinella", PlayKind.SONG, shuffle = false),
        "ciao come stai" to VoiceCommand.Unknown,
    )

    @Test
    fun parsesItalianCommands() {
        val failures = cases.mapNotNull { (input, expected) ->
            val actual = VoiceCommandParser.parse(input)
            if (actual != expected) "'$input' -> $actual (expected $expected)" else null
        }
        assertEquals(failures.joinToString("\n"), 0, failures.size)
    }

    @Test
    fun recognizesWakeWordInTranscript() {
        listOf("Hey Meld passa", "ehi Mel stop", "e-mail riproduci Vasco", "hey melt").forEach {
            assertEquals(it, true, VoiceCommandParser.startsWithWakeWord(it))
        }
        listOf("metti la mia canzone", "hey you", "ciao a tutti", "melodia").forEach {
            assertEquals(it, false, VoiceCommandParser.startsWithWakeWord(it))
        }
    }

    @Test
    fun skipsMisheardWakeWord() {
        assertEquals(VoiceCommand.Next, VoiceCommandParser.parseBest(listOf("a mild passa la canzone successiva")))
        assertEquals(VoiceCommand.Pause, VoiceCommandParser.parseBest(listOf("hey man stoppa la musica")))
        assertEquals(
            VoiceCommand.Play("blinding lights", PlayKind.AUTO),
            VoiceCommandParser.parseBest(listOf("Emil riproduci Blinding Lights")),
        )
        assertEquals(VoiceCommand.Unknown, VoiceCommandParser.parseBest(listOf("ciao come stai oggi")))
    }

    @Test
    fun picksFirstUnderstoodAlternative() {
        assertEquals(
            VoiceCommand.Next,
            VoiceCommandParser.parseBest(listOf("ciao come va", "passa alla successiva")),
        )
    }
}
