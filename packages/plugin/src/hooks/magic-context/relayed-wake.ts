import { normalizeText } from "./read-session-formatting";

/** Only whole core inbox envelopes are relays; a user's surrounding words stay user text. */
export function isRelayedWake(text: string): boolean {
    text = text.trim().replace(/\r\n/g, "\n");
    if (!/^<system-reminder>\nInbox:[^\n]*\n[\s\S]*\n<\/system-reminder>$/.test(text)) return false;
    let depth = 0;
    for (const match of text.matchAll(/<\/?system-reminder>/g)) {
        depth += match[0].startsWith("</") ? -1 : 1;
        if (depth === 0 && match.index + match[0].length !== text.length) return false;
    }
    return depth === 0;
}

function capped(text: string, limit: number): string {
    const normalized = normalizeText(text);
    return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function peers(lines: string[]): string[] | null {
    const items: Array<{ name: string; text: string }> = [];
    for (const line of lines) {
        if (!line.trim() || /^From [^,\n]+, wake$/.test(line)) continue;
        if (line.trimStart().startsWith("Reply: peer_send(")) continue;
        const match = /^([^\s].*?) \(([^(),\s]+)(?:, [^)]*)?\): (.*)$/.exec(line);
        if (match) {
            items.push({ name: match[1]!, text: match[3]! });
        } else if (/^[ \t]+/.test(line) && items.length) {
            items[items.length - 1]!.text += ` ${line.trim()}`;
        } else return null;
    }
    if (items.some((item) => !item.text.trim())) return null;
    return items.map((item) => `PM from ${item.name}: ${capped(item.text, 1500)}`);
}

function rooms(lines: string[]): string[] | null {
    const rooms: Array<{
        title: string;
        posts: Array<{ name: string; addressed: boolean; text: string }>;
    }> = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        const header = /^#(.+?) \(rm_[^\s()]+\)$/.exec(line);
        if (header) {
            rooms.push({ title: header[1]!, posts: [] });
            continue;
        }
        const room = rooms[rooms.length - 1];
        if (!room) return null;
        const post = /^  \[#\d+(?: reply to #\d+)?\] ([^:,]+?)(, to you)?: (.*)$/.exec(line);
        if (post) {
            room.posts.push({
                name: post[1]!.startsWith("ses_") ? "another agent" : post[1]!,
                addressed: post[2] !== undefined,
                text: post[3]!,
            });
        } else if (line.startsWith("    ") && room.posts.length) {
            room.posts[room.posts.length - 1]!.text += ` ${line.trim()}`;
        } else return null;
    }
    const output: string[] = [];
    for (const room of rooms) {
        if (!room.posts.length || room.posts.some((post) => !post.text.trim())) return null;
        for (const post of room.posts.filter((post) => post.addressed)) {
            output.push(`Room ${room.title}, ${post.name}: ${capped(post.text, 1500)}`);
        }
        const others = room.posts.filter((post) => !post.addressed);
        if (others.length) {
            const names = [...new Set(others.map((post) => post.name))];
            output.push(`Room ${room.title}: ${others.length} posts (${names.join(", ")})`);
        }
    }
    return output;
}

function workers(kind: string, lines: string[]): string[] | null {
    const output: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (kind === "Worker completions") {
            const match = /^Work wi_[A-Za-z0-9_-]+ "(.+)" finished \(([^()]+)\)\.$/.exec(line);
            if (match)
                output.push(`Worker "${match[1]}": ${capped(`finished (${match[2]})`, 600)}`);
            else if (line.startsWith("Work ")) return null;
        } else if (kind === "worker_notice") {
            const match =
                /^Your worker on "(.+)" \(wi_[A-Za-z0-9_-]+\) sent a [a-z]+ notice\.(?: It needs no reply\.)?$/.exec(
                    line,
                );
            if (!match) {
                if (line.startsWith("Your worker on ")) return null;
                continue;
            }
            while (i + 1 < lines.length && !lines[i + 1]!.trim()) i++;
            const body = lines[++i];
            if (!body || body.startsWith("From ") || body.startsWith("Your worker on "))
                return null;
            output.push(`Worker "${match[1]}": ${capped(body, 600)}`);
        } else {
            const match = /^Background task `(bg_[A-Za-z0-9_-]+)` asks \(request `[^`]+`\):$/.exec(
                line,
            );
            if (!match) {
                if (line.startsWith("Background task ")) return null;
                continue;
            }
            const question: string[] = [];
            while (++i < lines.length) {
                const body = lines[i]!;
                if (
                    /^(Options:|Context:|Why it matters:|Reply with |Full ask:|Background task |From )/.test(
                        body,
                    )
                ) {
                    i--;
                    break;
                }
                question.push(body);
            }
            if (!question.join(" ").trim()) return null;
            output.push(`Worker ${match[1]}: ${capped(question.join(" "), 600)}`);
        }
    }
    return output;
}

/** Unknown or malformed sections stay omitted, never passed through as raw text. */
export function relayedWakeLines(text: string): string[] {
    if (!isRelayedWake(text)) return [];
    const body = text.trim().replace(/\r\n/g, "\n").slice(0, -"</system-reminder>".length);
    const sections: Array<{ kind: string; lines: string[] }> = [];
    let nested = 0;
    for (const line of body.split("\n").slice(2)) {
        if (!nested && line.startsWith("## ")) sections.push({ kind: line.slice(3), lines: [] });
        else sections[sections.length - 1]?.lines.push(line);
        for (const match of line.matchAll(/<\/?system-reminder>/g))
            nested += match[0].startsWith("</") ? -1 : 1;
    }
    return sections.flatMap(({ kind, lines }) => {
        if (lines.some((line) => /<\/?system-reminder>/.test(line))) return [];
        if (kind === "Peer messages") return peers(lines) ?? [];
        if (kind === "Room posts") return rooms(lines) ?? [];
        if (["Worker questions", "Worker completions", "worker_notice"].includes(kind))
            return workers(kind, lines) ?? [];
        return [];
    });
}
