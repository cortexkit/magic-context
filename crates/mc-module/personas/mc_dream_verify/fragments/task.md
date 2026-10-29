## Verify these memories against the code

Project: {{ module.input.project }}

{% if module.input.has_evidence %}The git diff below is the evidence. If changed hunks do not touch a claim, mark it verified without opening files. Open files only when a diff suggests the claim may have changed. A rename or deletion requires an update or archive when positively supported; do not archive on uncertainty.{% else %}Read each memory's backing files to check its claims.{% endif %} Decide verified / update / archive / skip (default verified; behavioral directives only permit verified or skip), then output ONE <verify> manifest covering every id.

<memories>
{{ module.input.memories }}
</memories>{{ module.input.evidence }}
