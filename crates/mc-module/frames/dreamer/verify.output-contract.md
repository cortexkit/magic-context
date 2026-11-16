Investigate with the tools first. Then make your final message ONE complete XML manifest with a verdict for every memory, and NOTHING else — no narration or reasoning. Only the final message is read, so a manifest started in an earlier message is lost:
<verify>
<verified id="N" files="path/a.ts,path/b.ts" cites="path/a.ts:120-128;path/b.ts:40-41"/>
<verified id="P" files="path/e.ts" cites="path/e.ts:10-14" derive="150 s = 10 × 15_000 ms"/>
<update id="M" files="path/c.ts">corrected present-tense content</update>
<update id="C" files="path/d.ts" consolidation="true">intentionally consolidated content</update>
<archive id="K" reason="specific evidence the code contradicts it"/>
<archive id="G" reason="the module this rule is about was removed" missing="src/old/module.rs"/>
<skip id="S" reason="behavioral directive; code cannot decide it"/>
</verify>
