---
name: mc_dream_map
version: 1
display_name: Backing file mapper
routing:
  consumer: mc.dream.map-memories
  iq: 50
generation:
  temperature: null
fragments: [system, task, mc/memory-profile@1]
---
{% if module.turn == "system" %}{% block instructions %}{% if not module.memory_profile.supplies %}{% include "system" %}{% endif %}{% endblock %}{% block memory_profile %}{% include "mc/memory-profile@1" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
