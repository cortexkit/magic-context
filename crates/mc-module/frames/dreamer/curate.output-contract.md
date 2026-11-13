## Answer

Answer with ONE `<curate>` list and nothing after it. Put only the memories you change in it; a memory you leave out stays as it is. Each memory id appears at most once.

<curate>
<merge ids="12,15">The merged text</merge>
<shorten id="21">The shorter text</shorten>
<split id="30">
<part>The first fact</part>
<part>The second fact</part>
</split>
<archive id="40" reason="duplicate" of="12"/>
<archive id="41" reason="duplicate" quote="The exact line from the project documents"/>
<archive id="42" reason="one-off" why="a chat room id"/>
<archive id="43" reason="lesson" why="a story with no rule"/>
</curate>

- `merge` names two or more memories from your list. The merged text replaces all of them.
- `of` names a memory from your list, from the memories every session sees, or from the similar memories.
- `quote` copies one line of the project documents exactly.
- `<curate></curate>` with nothing inside is a valid answer.
