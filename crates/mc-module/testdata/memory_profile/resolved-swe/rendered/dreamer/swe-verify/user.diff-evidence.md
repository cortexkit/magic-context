## Verify these memories against the code

Project: ⟦projectIdentity⟧

The git diff below is the evidence. If changed hunks do not touch a claim, mark it verified without opening files. Open files only when a diff suggests the claim may have changed. A rename or deletion requires an update or archive when positively supported; do not archive on uncertainty. Decide verified / update / archive / skip (default verified; behavioral directives only permit verified or skip), then output ONE <verify> manifest covering every id.

<memories>
[⟦memory.id⟧] ⟦memory.category⟧
Content: ⟦memory.content⟧
Backing files: ⟦backingFile1⟧, ⟦backingFile2⟧
</memories>

<changed-files mode="⟦evidence.mode⟧">
File: ⟦changedFile.path⟧ (memories: ⟦changedFile.memoryId⟧)
⟦changedFile.diffText⟧
</changed-files>