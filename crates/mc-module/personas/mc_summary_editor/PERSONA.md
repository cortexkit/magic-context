---
name: mc_summary_editor
version: 1
display_name: Historian editor
routing:
  consumer: mc.summary
  iq: 50
generation:
  temperature: null
fragments:
  - system
  - mc/language@1
---
{% include "system" %}{% if module.language.name %}

{% include "mc/language@1" %}{% endif %}
