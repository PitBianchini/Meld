"""Copies the Italian voice-command regexes from the Android parser into ios-app/src/voice/patterns.ts.
Run from the repository root:  python3 ios-app/scripts/gen-parser-patterns.py"""
import json
import re

src = open("app/src/main/kotlin/com/metrolist/music/heymeld/VoiceCommand.kt").read()
SONG = re.search(r'private const val SONG = "(.*?)"\n', src).group(1)


def unk(s):  # Kotlin string literal body -> regex source
    return s.replace("\\\\", "\\").replace("$SONG", SONG.replace("\\\\", "\\")).replace('\\"', '"')


singles = {name: unk(body) for name, body in re.findall(r'private val (\w+) = r\("(.*?)"\)\n', src)}
lists = {}
for name in ["ENQUEUE_NEXT", "ENQUEUE"]:
    block = re.search(r"private val %s = listOf\((.*?)\n    \)" % name, src, re.S).group(1)
    lists[name] = [unk(x) for x in re.findall(r'r\("(.*?)"\)', block)]
block = re.search(r"private val KIND_PREFIXES = listOf\((.*?)\n    \)", src, re.S).group(1)
kinds = [(unk(a), b) for a, b in re.findall(r'r\("(.*?)"\) to PlayKind\.(\w+)', block)]
inf = dict(re.findall(r'"(\w+)" to "(\w+)"', re.search(r"INFINITIVES = mapOf\((.*?)\n    \)", src, re.S).group(1)))
nums = dict(re.findall(r'"(\w+)" to (\d+)', re.search(r"ITALIAN_NUMBERS = mapOf\((.*?)\n    \)", src, re.S).group(1)))

out = [
    "// Generated from the Android parser (app/src/main/kotlin/com/metrolist/music/heymeld/VoiceCommand.kt).",
    "// Regenerate with: python3 ios-app/scripts/gen-parser-patterns.py",
    "",
]
for k, v in singles.items():
    out.append(f"export const {k} = new RegExp({json.dumps(v)});")
for k, v in lists.items():
    out.append(f"export const {k} = [{', '.join('new RegExp(' + json.dumps(x) + ')' for x in v)}];")
out.append("export const KIND_PREFIXES: [RegExp, string][] = [" + ", ".join(f"[new RegExp({json.dumps(a)}), '{b}']" for a, b in kinds) + "];")
out.append(f"export const INFINITIVES: Record<string, string> = {json.dumps(inf)};")
out.append("export const ITALIAN_NUMBERS: Record<string, number> = {" + ", ".join(f"{json.dumps(k)}: {v}" for k, v in nums.items()) + "};")
open("ios-app/src/voice/patterns.ts", "w").write("\n".join(out) + "\n")
