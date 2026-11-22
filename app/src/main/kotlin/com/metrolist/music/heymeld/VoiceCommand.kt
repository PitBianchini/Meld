package com.metrolist.music.heymeld

import java.text.Normalizer

enum class PlayKind { AUTO, SONG, ARTIST, ALBUM, PLAYLIST, LIKED }

sealed interface VoiceCommand {
    data object Next : VoiceCommand
    data object Previous : VoiceCommand
    data object Restart : VoiceCommand
    data object Pause : VoiceCommand
    data object Resume : VoiceCommand
    data object VolumeUp : VoiceCommand
    data object VolumeDown : VoiceCommand
    data class VolumeSet(val percent: Int) : VoiceCommand
    data class Shuffle(val enabled: Boolean?) : VoiceCommand
    data object WhatIsPlaying : VoiceCommand
    data class Like(val liked: Boolean) : VoiceCommand
    data class Play(val query: String, val kind: PlayKind, val shuffle: Boolean = false) : VoiceCommand
    data class Enqueue(val query: String, val next: Boolean) : VoiceCommand
    data object Unknown : VoiceCommand
}

/**
 * Turns an Italian transcription (with or without the wake word in front) into a [VoiceCommand].
 * Pure Kotlin so it can be unit tested without Android.
 */
object VoiceCommandParser {

    /**
     * Tries every alternative as is, then with the first 1-3 words dropped: when the
     * transcript includes a misheard "Hey Meld" ("a mild", "hey man"...) the command follows it.
     */
    fun parseBest(alternatives: List<String>): VoiceCommand {
        alternatives.forEach { alt -> parse(alt).takeIf { it != VoiceCommand.Unknown }?.let { return it } }
        for (drop in 1..3) {
            alternatives.forEach { alt ->
                val words = alt.trim().split(Regex("\\s+"))
                if (words.size > drop) {
                    parse(words.drop(drop).joinToString(" ")).takeIf { it != VoiceCommand.Unknown }?.let { return it }
                }
            }
        }
        return VoiceCommand.Unknown
    }

    fun parse(raw: String): VoiceCommand {
        val t = clean(raw)
        if (t.isBlank()) return VoiceCommand.Unknown

        parseVolume(t)?.let { return it }

        matchAny(t, ENQUEUE_NEXT)?.let { q -> if (q.isNotBlank()) return VoiceCommand.Enqueue(stripArticle(q), next = true) }
        matchAny(t, ENQUEUE)?.let { q -> if (q.isNotBlank()) return VoiceCommand.Enqueue(stripArticle(q), next = false) }

        if (t.matches(LIKE_OFF)) return VoiceCommand.Like(false)
        if (t.matches(LIKE_ON)) return VoiceCommand.Like(true)
        if (t.matches(WHAT)) return VoiceCommand.WhatIsPlaying

        if (t.matches(SHUFFLE_OFF)) return VoiceCommand.Shuffle(false)
        if (t.matches(SHUFFLE_ON)) return VoiceCommand.Shuffle(true)
        if (t.matches(SHUFFLE_TOGGLE)) return VoiceCommand.Shuffle(null)

        if (t.matches(PREVIOUS)) return VoiceCommand.Previous
        if (t.matches(NEXT)) return VoiceCommand.Next
        if (t.matches(RESTART)) return VoiceCommand.Restart
        if (t.matches(PAUSE)) return VoiceCommand.Pause
        if (t.matches(RESUME)) return VoiceCommand.Resume

        PLAY.matchEntire(t)?.let { m -> return buildPlay(m.groupValues[1]) }
        return VoiceCommand.Unknown
    }

    private fun buildPlay(rest: String): VoiceCommand {
        var q = rest.trim()
        var shuffle = false
        SHUFFLE_SUFFIX.find(q)?.let {
            shuffle = true
            q = q.removeRange(it.range).trim()
        }
        if (q.isBlank()) return VoiceCommand.Resume
        if (q.matches(LIKED)) return VoiceCommand.Play("", PlayKind.LIKED, shuffle)

        for ((regex, kind) in KIND_PREFIXES) {
            regex.matchEntire(q)?.let { m ->
                val name = m.groupValues[1].trim()
                if (name.isNotBlank()) return VoiceCommand.Play(name, kind, shuffle)
            }
        }
        q = stripArticle(q)
        SONG_BY.matchEntire(q)?.let { m ->
            return VoiceCommand.Play("${m.groupValues[1].trim()} ${m.groupValues[2].trim()}", PlayKind.SONG, shuffle)
        }
        return VoiceCommand.Play(q, PlayKind.AUTO, shuffle)
    }

    private fun parseVolume(t: String): VoiceCommand? {
        if (!t.contains("volume") && !t.contains("forte") && !t.contains("piano")) return null
        if (t.matches(VOLUME_MAX)) return VoiceCommand.VolumeSet(100)
        if (t.matches(VOLUME_MIN)) return VoiceCommand.VolumeSet(10)
        VOLUME_SET.find(t)?.let { m ->
            val n = m.groupValues[1].toIntOrNull() ?: ITALIAN_NUMBERS[m.groupValues[1]]
            if (n != null) return VoiceCommand.VolumeSet(n.coerceIn(0, 100))
        }
        if (t.matches(VOLUME_UP)) return VoiceCommand.VolumeUp
        if (t.matches(VOLUME_DOWN)) return VoiceCommand.VolumeDown
        return null
    }

    /** True when the transcript begins with something that sounds like "Hey Meld". */
    fun startsWithWakeWord(raw: String): Boolean {
        val t = raw.lowercase().replace(Regex("[,.!?;:]"), " ").trim()
        return WAKE.find(t)?.let { it.value.isNotBlank() } == true
    }

    internal fun clean(raw: String): String {
        var t = Normalizer.normalize(raw.lowercase(), Normalizer.Form.NFC)
            .replace('’', '\'')
            .replace(Regex("[,.!?;:\"«»]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        t = WAKE.replace(t, "").trim()
        repeat(3) { t = POLITE_PREFIX.replace(t, "").trim() }
        val first = t.substringBefore(' ')
        INFINITIVES[first]?.let { t = it + t.substring(first.length) }
        t = POLITE_SUFFIX.replace(t, "").trim()
        return t
    }

    private fun stripArticle(q: String) = ARTICLE.replace(q.trim(), "").trim()

    private fun matchAny(t: String, regexes: List<Regex>): String? =
        regexes.firstNotNullOfOrNull { it.matchEntire(t)?.groupValues?.get(1)?.trim() }

    private fun r(p: String) = Regex(p)

    private val WAKE = r("^(?:(?:hey|ehi|ei|hei|e|a|ok|okay)\\s*)?(?:meld|mel|meldi|melt|meld's|amel?d|mell|melk|mail|email|e-mail|emeld|hemeld)\\b\\s*")
    private val POLITE_PREFIX = r("^(?:per favore|per piacere|perfavore|ti prego|dai|allora|ora|adesso|ehm|senti|puoi|potresti|riesci a|vorrei|voglio che|(?:mi|me|ce|ci)\\b(?! piac))\\b\\s*")
    private val POLITE_SUFFIX = r("\\s*\\b(?:per favore|per piacere|grazie|perfavore)$")
    private val INFINITIVES = mapOf(
        "passare" to "passa", "mettere" to "metti", "mettermi" to "metti", "riprodurre" to "riproduci",
        "riprodurmi" to "riproduci", "suonare" to "suona", "alzare" to "alza", "abbassare" to "abbassa",
        "fermare" to "ferma", "stoppare" to "stoppa", "saltare" to "salta", "tornare" to "torna",
        "aggiungere" to "aggiungi", "togliere" to "togli", "ricominciare" to "ricomincia",
        "riprendere" to "riprendi", "attivare" to "attiva", "disattivare" to "disattiva",
        "cercare" to "cerca", "cambiare" to "cambia", "aumentare" to "aumenta", "diminuire" to "diminuisci",
        "passami" to "passa", "mettimi" to "metti", "salvare" to "salva", "continuare" to "continua",
    )
    private val ARTICLE = r("^(?:(?:il|lo|la|i|gli|le|un|uno|una)\\s+|(?:l'|un')\\s*)")

    private const val SONG = "(?:canzone|brano|pezzo|traccia|musica)"
    private val NEXT = r("^(?:(?:passa|vai|salta|metti|cambia|manda)(?: (?:a|al|alla|la|il))? )?(?:(?:la |il )?$SONG )?(?:successiv[ao]|prossim[ao](?: $SONG)?|dopo|avanti|next|skip|skippa|salta(?: questa)?(?: $SONG)?|cambia(?: $SONG)?|un'altra(?: $SONG)?|passa(?: $SONG)?)$")
    private val PREVIOUS = r("^(?:(?:torna|vai|passa|metti|rimetti|riproduci)(?: (?:a|al|alla|la|il|indietro))?(?: (?:a|al|alla))? )?(?:(?:la |il )?$SONG )?(?:precedente|prima|di prima|indietro|quella (?:di )?prima)$")
    private val RESTART = r("^(?:ricomincia|riavvolgi|rimetti|riparti|riproduci|fai ripartire)(?: (?:la|il|questa|questo))?(?: $SONG)? (?:da capo|daccapo|dall'inizio|dall inizio|dal principio)$|^(?:ricomincia|riavvolgi)(?: (?:la|il|questa|questo))?(?: $SONG)?$|^(?:da capo|daccapo|dall'inizio)$")
    private val PAUSE = r("^(?:metti in pausa|metti pausa|pausa|stop|stoppa|ferma|fermati|fermala|basta|silenzio|zitto|spegni|interrompi|blocca)(?: (?:la|il|questa|questo|tutto))?(?: (?:la |il )?$SONG)?$")
    private val RESUME = r("^(?:riprendi|continua|play|riparti|fai ripartire|rimetti|riattiva|vai|fai partire|accendi|ricomincia a suonare|togli (?:la )?pausa)(?: (?:la|il))?(?: $SONG)?$")

    private val VOLUME_MAX = r(".*(?:volume (?:al )?massimo|al massimo|massimo volume|volume a palla|a tutto volume).*")
    private val VOLUME_MIN = r(".*(?:volume (?:al )?minimo|al minimo|minimo volume).*")
    private val VOLUME_SET = r("volume (?:al|a|del|sul|su|il)? ?(\\d{1,3}|dieci|venti|trenta|quaranta|cinquanta|sessanta|settanta|ottanta|novanta|cento)\\b")
    private val VOLUME_UP = r(".*(?:alza|aumenta|su|più|piu|sali|tira su).*(?:volume|forte).*|.*volume (?:su|più alto|piu alto|più forte|piu forte)$|^più forte$|^piu forte$")
    private val VOLUME_DOWN = r(".*(?:abbassa|diminuisci|giù|giu|meno|riduci|scendi).*(?:volume|forte|piano).*|.*volume (?:giù|giu|più basso|piu basso)$|^(?:più|piu) piano$")
    private val ITALIAN_NUMBERS = mapOf(
        "dieci" to 10, "venti" to 20, "trenta" to 30, "quaranta" to 40, "cinquanta" to 50,
        "sessanta" to 60, "settanta" to 70, "ottanta" to 80, "novanta" to 90, "cento" to 100,
    )

    private val LIKE_ON = r("^(?:metti(?: un)?|aggiungi(?: un)?|lascia(?: un)?)? ?(?:mi piace|like|cuore|cuoricino)(?: (?:a )?(?:questa|questo)(?: $SONG)?)?$|^(?:aggiungi|salva|metti)(?: (?:questa|questo|la|il))?(?: $SONG)? (?:ai|nei|tra i) (?:preferiti|mi piace)$|^(?:questa|questo)(?: $SONG)? mi piace$|^salva (?:questa|questo)(?: $SONG)?$")
    private val LIKE_OFF = r("^(?:togli|rimuovi|leva)(?: il)? (?:mi piace|like|cuore)(?: (?:a|da) (?:questa|questo)(?: $SONG)?)?$|^non mi piace(?: più| piu)?(?: questa(?: $SONG)?)?$|^(?:togli|rimuovi|leva)(?: (?:questa|questo|la|il))?(?: $SONG)? dai (?:preferiti|mi piace)$")
    private val WHAT = r("^(?:che|quale|qual è la|qual e la|qual è|quale è la)? ?(?:$SONG|pezzo) (?:è|e|sta suonando|stai suonando|è questa|e questa|è questo)(?: questa| questo)?$|^(?:cosa|che cosa|cos') ?(?:sta suonando|stai suonando|stiamo ascoltando|sto ascoltando|è questa|e questa|è questo)(?: $SONG)?$|^come si chiama(?: questa| questo)?(?: $SONG)?$|^chi (?:canta|la canta|è il cantante|e il cantante|è l'artista)(?: questa| questo)?(?: $SONG)?$|^che (?:canzone|cosa) (?:è|e)$|^info$")

    private val SHUFFLE_ON = r("^(?:attiva|metti|accendi)(?: la)? (?:riproduzione )?(?:casuale|shuffle)$|^(?:mescola|shuffle)(?: (?:la|le|i) (?:coda|canzoni|brani))?$")
    private val SHUFFLE_OFF = r("^(?:disattiva|togli|spegni|leva)(?: la)? (?:riproduzione )?(?:casuale|shuffle)$|^(?:non (?:in )?casuale|in ordine)$")
    private val SHUFFLE_TOGGLE = r("^(?:riproduzione )?casuale$")

    private val ENQUEUE_NEXT = listOf(
        r("^(?:metti|riproduci|suona|fammi sentire|aggiungi) (?:subito )?dopo (?:questa )?(.+)$"),
        r("^(?:dopo (?:questa|questo)(?: $SONG)?) (?:metti|riproduci|suona|fammi sentire) (.+)$"),
        r("^(?:metti|aggiungi) (.+) (?:subito )?dopo(?: (?:questa|questo))?$"),
    )
    private val ENQUEUE = listOf(
        r("^(?:metti|aggiungi|accoda) (?:in|alla|nella) coda (.+)$"),
        r("^(?:metti|aggiungi|accoda) (.+) (?:in|alla|nella) coda$"),
        r("^in coda (.+)$"),
        r("^accoda (.+)$"),
    )

    private val PLAY = r("^(?:riproduci|riproducimi|metti|mettimi|suona|suonami|fammi sentire|fammi ascoltare|voglio sentire|voglio ascoltare|ascolta|ascoltiamo|sentiamo|play|cerca e riproduci|cerca|fai partire|parti con|vai con|spara)(?:\\s+(.*))?$")
    private val SHUFFLE_SUFFIX = r("\\s*(?:in|a) (?:modalità |modalita )?(?:casuale|shuffle|ordine sparso)$")
    private val LIKED = r("^(?:le |i )?(?:mie |miei )?(?:canzoni|brani|pezzi)? ?(?:che mi piacciono|preferit[ie]|mi piace|piaciut[ie])$|^(?:la )?(?:playlist )?(?:dei |delle )?(?:mi piace|preferiti)$")
    private val SONG_BY = r("^(?:$SONG )?(.+?) (?:di|dei|degli|delle|del|della|dello) (.+)$")

    private val KIND_PREFIXES = listOf(
        r("^(?:la |una )?(?:mia )?playlist (?:di |chiamata |intitolata |dei |delle )?(.+)$") to PlayKind.PLAYLIST,
        r("^(?:l'|l |un |un')?(?:album|disco) (?:di |dei |degli |delle |del |della )?(.+)$") to PlayKind.ALBUM,
        r("^(?:qualcosa|qualche (?:canzone|pezzo|brano)|(?:della |un po' di |un po di |la )?musica|(?:le |delle |dei |i )?(?:canzoni|brani|pezzi|successi|hit)|l'artista|l artista|artista|il cantante|la cantante|il gruppo|la band) (?:di |dei |degli |delle |del |della |dello )?(.+)$") to PlayKind.ARTIST,
        r("^(?:la )?(?:canzone|brano|pezzo|traccia) (.+)$") to PlayKind.SONG,
    )
}
