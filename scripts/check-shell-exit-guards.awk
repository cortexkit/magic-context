# This is a lexical convention check, not a shell interpreter. Heredoc bodies and
# comments are data; every installed EXIT action in a strict script is checked,
# including replacements. Keep the status/finished spelling uniform so the
# convention is reviewable without dependencies on a shell parser.
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function fail(line, reason) {
    printf "FAIL: shell EXIT guard: %s:%d: %s\n", path, line, reason > "/dev/stderr"
    failed=1
}
function guarded(body, first, normalized) {
    body=trim(body)
    first=body
    sub(/[;\n].*$/, "", first)
    if (first !~ /^(local[ \t]+)?status=\$\?[ \t]*$/) return 0
    normalized=body
    gsub(/[ \t\n]+/, " ", normalized)
    return index(normalized, "if [ \"$status\" -eq 0 ] && [ \"${finished:-0}\" != 1 ]; then") &&
        normalized ~ /status=1([ ;]|$)/ &&
        index(normalized, "$0: exited before successful completion") &&
        index(normalized, ">&2") && index(normalized, "exit \"$status\"")
}
{
    if (heredoc != "") {
        delimiter=$0
        if (strip_tabs) sub(/^\t+/, "", delimiter)
        if (delimiter == heredoc) heredoc=""
        next
    }
    line=$0
    if (line ~ /^[ \t]*#/) next
    # The repository uses identifier delimiters, optionally quoted or tab-stripped.
    if (match(line, /<<-?[ \t]*[\047\"]?[A-Za-z_][A-Za-z_0-9]*[\047\"]?/)) {
        heredoc=substr(line, RSTART, RLENGTH)
        strip_tabs=(heredoc ~ /^<<-/)
        sub(/^<<-?[ \t]*/, "", heredoc)
        gsub(/[\047\"]/, "", heredoc)
    }
    sub(/[ \t]+#.*/, "", line)
    source[NR]=line
    # Treat enabling either option anywhere as strict, even with split set commands.
    rest=line
    while (match(rest, /(^|[;(&|])[ \t]*set[ \t]+[^;]+/)) {
        command=substr(rest, RSTART, RLENGTH)
        sub(/^.*set[ \t]+/, "", command)
        n=split(command, words, /[ \t]+/)
        for (i=1; i<=n; i++) {
            if (words[i] == "-o") {
                if (words[i+1] == "errexit") errexit=1
                if (words[i+1] == "nounset") nounset=1
                i++
            } else if (words[i] ~ /^-[A-Za-z]+$/) {
                if (words[i] ~ /e/) errexit=1
                if (words[i] ~ /u/) nounset=1
            } else break
        }
        rest=substr(rest, RSTART+RLENGTH)
    }
    if (line ~ /(^|;)[ \t]*finished=0([ \t;]|$)/) initialized=1
    if (line ~ /(^|;)[ \t]*finished=1([ \t;]|$)/) completed=1
}
END {
    if (!errexit || !nounset) exit 0
    for (line_number=1; line_number<=NR; line_number++) {
        rest=source[line_number]
        while (match(rest, /(^|[;(&|])[ \t]*trap[ \t]+/)) {
            action=trim(substr(rest, RSTART+RLENGTH))
            sub(/^--[ \t]+/, "", action)
            start=line_number
            quote=substr(action, 1, 1)
            if (quote == "\047" || quote == "\"") {
                while (!(closing=index(substr(action, 2), quote)) && line_number<NR)
                    action=action "\n" source[++line_number]
                if (!closing) { fail(start, "unterminated trap action"); break }
                closing++
                rest=substr(action, closing+1)
                action=substr(action, 2, closing-2)
            } else {
                match(action, /^[^ \t;]+/)
                rest=substr(action, RLENGTH+1)
                action=substr(action, 1, RLENGTH)
            }
            signals=rest
            sub(/[;&|)].*$/, "", signals)
            rest=substr(rest, length(signals)+1)
            if (signals !~ /(^|[ \t])(EXIT|0)([ \t]|$)/ || action == "-") continue
            if (quote != "\047" && action ~ /^[A-Za-z_][A-Za-z_0-9]*$/) {
                name=action
                action=""
                for (j=1; j<=NR; j++) {
                    if (source[j] ~ ("^[ \t]*" name "\\(\\)[ \t]*\\{")) {
                        while (++j<=NR && source[j] !~ /^[ \t]*}/)
                            action=action source[j] "\n"
                        break
                    }
                }
            }
            if (!initialized || !completed || quote == "\"" || !guarded(action))
                fail(start, "EXIT action needs status=$?, a finished guard, stderr diagnostic and status-preserving exit")
        }
    }
    exit failed ? 1 : 0
}
