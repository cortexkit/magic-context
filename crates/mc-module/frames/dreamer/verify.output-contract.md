Output ONE XML manifest and NOTHING else — no narration or reasoning. Open <verify> before investigating and emit each complete verdict immediately before investigating the next memory, so interruption preserves finished work. Close </verify> when done:
<verify>
<verified id="N" files="path/a.ts,path/b.ts"/>
<update id="M" files="path/c.ts">corrected present-tense content</update>
<update id="C" files="path/d.ts" consolidation="true">intentionally consolidated content</update>
<archive id="K" reason="specific evidence the code contradicts it"/>
<archive id="G" reason="the module this rule is about was removed" missing="src/old/module.rs"/>
<skip id="S" reason="behavioral directive; code cannot decide it"/>
</verify>
