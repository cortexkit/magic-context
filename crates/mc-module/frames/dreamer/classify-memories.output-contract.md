Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory id="N" importance="80" safety_critical="true"/>
<memory id="M" importance="20" safety_critical="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100.
- Set safety_critical to true for the operating rules covered by the hard floor above, false otherwise.
