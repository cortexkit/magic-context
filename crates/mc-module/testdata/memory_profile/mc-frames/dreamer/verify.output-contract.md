Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<verify>
<verified id="N" files="path/a.ts,path/b.ts"/>
<update id="M" files="path/c.ts">corrected present-tense content</update>
<update id="C" files="path/d.ts" consolidation="true">intentionally consolidated content</update>
<archive id="K" reason="specific evidence the code contradicts it"/>
<skip id="S" reason="behavioral directive; code cannot decide it"/>
</verify>
