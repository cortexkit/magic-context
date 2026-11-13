Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory id="N" importance="80" scope="project" shareable="true" safety_critical="true"/>
<memory id="M" importance="20" scope="universe" shareable="false" safety_critical="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false.
- Set safety_critical to true for the operating rules covered by the hard floor above, false otherwise.
