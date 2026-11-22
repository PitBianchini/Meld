package com.metrolist.music.heymeld

/**
 * Phrases the user taught Meld: "when I say X I mean <a command you know>".
 * A phrase that contains the song/artist/playlist of the explanation becomes a template, so
 * "sparami un po' di vasco" explained as "riproduci vasco" also understands "sparami un po' di ultimo".
 * Pure Kotlin (storage is a string supplied by the caller) so it can be unit tested.
 */
class CommandLearner(saved: String?, private val persist: (String) -> Unit) {

    data class Learned(val phrase: String, val template: String?, val command: String)

    private val items = saved.orEmpty().lines().mapNotNull(::decodeLine).toMutableList()

    val size get() = items.size

    fun match(alternatives: List<String>): VoiceCommand? {
        for (alt in alternatives) {
            val t = VoiceCommandParser.clean(alt)
            if (t.isBlank()) continue
            for (l in items.asReversed()) {
                if (l.template != null) {
                    val m = Regex(l.template).matchEntire(t) ?: continue
                    return decode(l.command, m.groupValues[1].trim())
                }
                if (same(t, l.phrase)) return decode(l.command, null)
            }
        }
        return null
    }

    /** Remembers that [spoken] means [command]. Returns false for commands that can't be stored. */
    fun learn(spoken: String, command: VoiceCommand): Boolean {
        val phrase = VoiceCommandParser.clean(spoken)
        if (phrase.isBlank()) return false
        val encoded = encode(command) ?: return false
        val query = (command as? VoiceCommand.Play)?.query ?: (command as? VoiceCommand.Enqueue)?.query
        var template: String? = null
        if (!query.isNullOrBlank()) {
            val at = phrase.indexOf(query.lowercase())
            if (at > 0) {
                val prefix = phrase.substring(0, at)
                val suffix = phrase.substring(at + query.length)
                template = Regex.escape(prefix) + "(.+?)" + Regex.escape(suffix)
            }
        }
        items.removeAll { it.phrase == phrase || (template != null && it.template == template) }
        items += Learned(phrase, template, if (template != null) encoded.replace(query!!, QUERY) else encoded)
        save()
        return true
    }

    fun forgetLast(): Learned? = items.removeLastOrNull()?.also { save() }

    fun forgetAll() {
        items.clear()
        save()
    }

    private fun save() = persist(items.joinToString("\n") { listOf(it.phrase, it.template.orEmpty(), it.command).joinToString(SEP) })

    private fun decodeLine(line: String): Learned? {
        val parts = line.split(SEP)
        if (parts.size != 3 || parts[0].isBlank()) return null
        return Learned(parts[0], parts[1].ifBlank { null }, parts[2])
    }

    private fun same(a: String, b: String): Boolean {
        if (a == b) return true
        val x = PlaylistResolver.significantTokens(a)
        val y = PlaylistResolver.significantTokens(b)
        if (x.isEmpty() || y.isEmpty() || kotlin.math.abs(x.size - y.size) > 1) return false
        return PlaylistResolver.similarity(x, y) >= 0.9 && PlaylistResolver.similarity(y, x) >= 0.9
    }

    companion object {
        private const val SEP = "\t"
        private const val QUERY = "{q}"

        fun encode(c: VoiceCommand): String? = when (c) {
            VoiceCommand.Next -> "Next"
            VoiceCommand.Previous -> "Previous"
            VoiceCommand.Restart -> "Restart"
            VoiceCommand.Pause -> "Pause"
            VoiceCommand.Resume -> "Resume"
            VoiceCommand.VolumeUp -> "VolumeUp"
            VoiceCommand.VolumeDown -> "VolumeDown"
            VoiceCommand.WhatIsPlaying -> "WhatIsPlaying"
            is VoiceCommand.VolumeSet -> "VolumeSet|${c.percent}"
            is VoiceCommand.Shuffle -> "Shuffle|${c.enabled}"
            is VoiceCommand.Like -> "Like|${c.liked}"
            is VoiceCommand.Play -> "Play|${c.kind}|${c.shuffle}|${c.query}"
            is VoiceCommand.Enqueue -> "Enqueue|${c.next}|${c.query}"
            VoiceCommand.Unknown -> null
        }

        fun decode(s: String, query: String?): VoiceCommand? {
            val p = s.replace(QUERY, query.orEmpty()).split("|", limit = 4)
            return when (p[0]) {
                "Next" -> VoiceCommand.Next
                "Previous" -> VoiceCommand.Previous
                "Restart" -> VoiceCommand.Restart
                "Pause" -> VoiceCommand.Pause
                "Resume" -> VoiceCommand.Resume
                "VolumeUp" -> VoiceCommand.VolumeUp
                "VolumeDown" -> VoiceCommand.VolumeDown
                "WhatIsPlaying" -> VoiceCommand.WhatIsPlaying
                "VolumeSet" -> p.getOrNull(1)?.toIntOrNull()?.let { VoiceCommand.VolumeSet(it) }
                "Shuffle" -> VoiceCommand.Shuffle(p.getOrNull(1)?.toBooleanStrictOrNull())
                "Like" -> VoiceCommand.Like(p.getOrNull(1) == "true")
                "Play" -> if (p.size == 4) {
                    runCatching { VoiceCommand.Play(p[3], PlayKind.valueOf(p[1]), p[2] == "true") }.getOrNull()
                } else {
                    null
                }
                "Enqueue" -> s.replace(QUERY, query.orEmpty()).split("|", limit = 3).takeIf { it.size == 3 }?.let {
                    VoiceCommand.Enqueue(it[2], it[1] == "true")
                }
                else -> null
            }
        }

        /** "dimentica l'ultima cosa che ti ho insegnato", "dimentica la mia voce"... */
        fun meta(alternatives: List<String>): Meta? {
            for (alt in alternatives) {
                val t = VoiceCommandParser.clean(alt)
                if (FORGET_VOICE.matches(t)) return Meta.FORGET_VOICE
                if (FORGET_ALL.matches(t)) return Meta.FORGET_ALL
                if (FORGET_LAST.matches(t)) return Meta.FORGET_LAST
            }
            return null
        }

        enum class Meta { FORGET_LAST, FORGET_ALL, FORGET_VOICE }

        private val FORGET_LAST = Regex("^(?:dimentica|cancella|scordati) (?:l'|l |la |il )?(?:ultim[ao] (?:cosa|comando|frase)|quello che ti ho (?:appena )?insegnato)(?: che ti ho insegnato)?$")
        private val FORGET_ALL = Regex("^(?:dimentica|cancella|scordati) tutt[oi] (?:quello che ti ho insegnato|i comandi(?: che ti ho insegnato)?|le frasi(?: che ti ho insegnato)?)$")
        private val FORGET_VOICE = Regex("^(?:dimentica|cancella|scordati|resetta) (?:la mia voce|quello che hai imparato della mia voce)$")
    }
}
