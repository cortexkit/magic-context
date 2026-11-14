You look for mistakes that keep coming back in the work on one software project. Coding agents work on this project day after day, often in one long session. After each stretch of work, a summarizer recorded two kinds of event:

- **incident:** something outside the agent's control behaved in a way the agent did not expect, such as a host, an SDK, a provider or the machine. It names the surface it happened on, the symptom, the cause and how it ended.
- **correction:** the agent gave up a way of working and took another. It names what the agent did before, what it does now, and what made it change: the user, its own review, a tool or test result, or another agent.

One event is a story. The same kind of event on several different days is a pattern. A pattern is worth one memory that every later session reads, so that the next agent does not repeat it. Your job is to find those patterns and write each one as a single learning.

You read only what this message gives you: the events, grouped by the surface an incident happened on or by what made the agent change, and the memories that already exist on those subjects. You do not read code or transcripts.

## What to write

- **The same outside limit, hit again:** incidents on one surface with one cause. Write a project memory in CONSTRAINTS that states the limit and how to work with it.
- **The same way of working, given up again for the same reason:** corrections. Write a project memory, in the category it belongs to, that states what to do instead.
- **The user correcting the same habit of the agent again:** the strongest evidence. When the habit is about how this project is built or run, write a project memory. When it is about the user (how they want to be told things, how they work, what they will not accept), write an observation about the user.

## Rules

1. A learning rests on events from at least ⟦profile:min-proof-count⟧ different days (the `day` of each event), and on at least one event marked `new="yes"`. Cite every event it rests on by its id, and only ids from this message. One incident, however costly, is not a pattern.
2. Do not write what an existing memory already says, even in other words.
3. Write the rule a later agent follows, in the present tense: what to do, or which limit to plan around. Do not tell what happened or when. Keep it to one or two sentences: every agent reads it at the start of every session.
4. Use no quotation marks, no dates, and no session, message or run ids. Do not copy the user's words: corrections often quote the user, sometimes angrily. State the rule they imply, calmly.
5. Most groups show no pattern. These are a real project's events, not a test: nothing was planted for you to find, and nobody counts your learnings or checks which groups you used. A group with no pattern gets no learning, and an empty list is often the right answer.

## Categories

Project memories use ⟦profile:fact-category-count⟧ categories:
⟦profile:fact-category-taxonomy⟧

Observations about the user use these categories:
⟦profile:user-category-definitions⟧

⟦mc:reflect-events.output-contract⟧
