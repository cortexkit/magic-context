//! Core inbox text is data from other agents, not a user prompt. Keep only
//! recognized sections; a malformed section never falls back to raw text.

use std::sync::OnceLock;

use regex::Regex;

use super::normalize;

fn patterns() -> &'static [Regex; 9] {
    static PATTERNS: OnceLock<[Regex; 9]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"^([^\s].*?) \(([^(),\s]+)(?:, [^)]*)?\): (.*)$",
            r"^#(.+?) \(rm_[^\s()]+\)$",
            r"^  \[#\d+(?: reply to #\d+)?\] ([^:,]+?)(, to you)?: (.*)$",
            r#"^Work wi_[A-Za-z0-9_-]+ "(.+)" finished \(([^()]+)\)\.$"#,
            r#"^Your worker on "(.+)" \(wi_[A-Za-z0-9_-]+\) sent a [a-z]+ notice\.(?: It needs no reply\.)?$"#,
            r"^Background task `(bg_[A-Za-z0-9_-]+)` asks \(request `[^`]+`\):$",
            r"^(Options:|Context:|Why it matters:|Reply with |Full ask:|Background task |From )",
            r"^From [^,\n]+, wake$",
            r"</?system-reminder>",
        ]
        .map(|pattern| Regex::new(pattern).expect("fixed relay pattern"))
    })
}

fn capped(text: &str, limit: usize) -> String {
    let text = normalize(text);
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= limit {
        text
    } else {
        format!(
            "{}…",
            crate::js_text::string_from_utf16_prefix(&units, limit)
        )
    }
}

pub(super) fn is_wake(text: &str) -> bool {
    let text = text.trim().replace("\r\n", "\n");
    if !text.starts_with("<system-reminder>\nInbox:") || !text.ends_with("\n</system-reminder>") {
        return false;
    }
    let mut depth = 0;
    for tag in patterns()[8].find_iter(&text) {
        depth += if tag.as_str().starts_with("</") {
            -1
        } else {
            1
        };
        if depth == 0 && tag.end() != text.len() {
            return false;
        }
    }
    depth == 0
}

fn peers(lines: &[&str]) -> Option<Vec<String>> {
    let mut items: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.trim().is_empty() || patterns()[7].is_match(line) {
            continue;
        }
        if line.trim_start().starts_with("Reply: peer_send(") {
            continue;
        }
        if let Some(capture) = patterns()[0].captures(line) {
            items.push((capture[1].to_owned(), capture[3].to_owned()));
        } else if line.starts_with([' ', '\t']) {
            let (_, text) = items.last_mut()?;
            text.push(' ');
            text.push_str(line.trim());
        } else {
            return None;
        }
    }
    if items.iter().any(|(_, text)| text.trim().is_empty()) {
        return None;
    }
    Some(
        items
            .iter()
            .map(|(name, text)| format!("PM from {name}: {}", capped(text, 1500)))
            .collect(),
    )
}

struct Post {
    name: String,
    addressed: bool,
    text: String,
}

fn rooms(lines: &[&str]) -> Option<Vec<String>> {
    let mut rooms: Vec<(String, Vec<Post>)> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(header) = patterns()[1].captures(line) {
            rooms.push((header[1].to_owned(), Vec::new()));
            continue;
        }
        let (_, posts) = rooms.last_mut()?;
        if let Some(post) = patterns()[2].captures(line) {
            posts.push(Post {
                name: if post[1].starts_with("ses_") {
                    "another agent".to_owned()
                } else {
                    post[1].to_owned()
                },
                addressed: post.get(2).is_some(),
                text: post[3].to_owned(),
            });
        } else if line.starts_with("    ") {
            let post = posts.last_mut()?;
            post.text.push(' ');
            post.text.push_str(line.trim());
        } else {
            return None;
        }
    }
    let mut output = Vec::new();
    for (title, posts) in rooms {
        if posts.is_empty() || posts.iter().any(|post| post.text.trim().is_empty()) {
            return None;
        }
        for post in posts.iter().filter(|post| post.addressed) {
            output.push(format!(
                "Room {title}, {}: {}",
                post.name,
                capped(&post.text, 1500)
            ));
        }
        let mut names = Vec::new();
        let mut count = 0;
        for post in posts.iter().filter(|post| !post.addressed) {
            count += 1;
            if !names.contains(&post.name) {
                names.push(post.name.clone());
            }
        }
        if count > 0 {
            let noun = if count == 1 { "post" } else { "posts" };
            output.push(format!(
                "Room {title}: {count} {noun} ({})",
                names.join(", ")
            ));
        }
    }
    Some(output)
}

fn workers(kind: &str, lines: &[&str]) -> Option<Vec<String>> {
    let mut output = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        match kind {
            "Worker completions" => {
                if let Some(item) = patterns()[3].captures(line) {
                    output.push(format!(
                        "Worker \"{}\": {}",
                        &item[1],
                        capped(&format!("finished ({})", &item[2]), 600)
                    ));
                } else if line.starts_with("Work ") {
                    return None;
                }
            }
            "worker_notice" => {
                if let Some(item) = patterns()[4].captures(line) {
                    i += 1;
                    while i < lines.len() && lines[i].trim().is_empty() {
                        i += 1;
                    }
                    let body = *lines.get(i)?;
                    if body.starts_with("From ") || body.starts_with("Your worker on ") {
                        return None;
                    }
                    output.push(format!("Worker \"{}\": {}", &item[1], capped(body, 600)));
                } else if line.starts_with("Your worker on ") {
                    return None;
                }
            }
            _ => {
                if let Some(item) = patterns()[5].captures(line) {
                    i += 1;
                    let mut question = Vec::new();
                    while i < lines.len() && !patterns()[6].is_match(lines[i]) {
                        question.push(lines[i]);
                        i += 1;
                    }
                    let text = question.join(" ");
                    if text.trim().is_empty() {
                        return None;
                    }
                    output.push(format!("Worker {}: {}", &item[1], capped(&text, 600)));
                    continue;
                } else if line.starts_with("Background task ") {
                    return None;
                }
            }
        }
        i += 1;
    }
    Some(output)
}

pub(super) fn lines(text: &str) -> Vec<String> {
    if !is_wake(text) {
        return Vec::new();
    }
    let text = text.trim().replace("\r\n", "\n");
    let body = text.strip_suffix("</system-reminder>").expect("whole wake");
    let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
    let mut nested = 0;
    for line in body.split('\n').skip(2) {
        if let Some(kind) = line.strip_prefix("## ").filter(|_| nested == 0) {
            sections.push((kind, Vec::new()));
        } else if let Some((_, lines)) = sections.last_mut() {
            lines.push(line);
        }
        for tag in patterns()[8].find_iter(line) {
            nested += if tag.as_str().starts_with("</") {
                -1
            } else {
                1
            };
        }
    }
    sections
        .into_iter()
        .flat_map(|(kind, lines)| {
            if lines.iter().any(|line| patterns()[8].is_match(line)) {
                return Vec::new();
            }
            match kind {
                "Peer messages" => peers(&lines),
                "Room posts" => rooms(&lines),
                "Worker questions" | "Worker completions" | "worker_notice" => {
                    workers(kind, &lines)
                }
                _ => None,
            }
            .unwrap_or_default()
        })
        .collect()
}
