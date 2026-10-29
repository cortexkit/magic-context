---
name: mc_dream_curate
version: 1
display_name: Project memory curator
routing:
  consumer: mc.dream.curate
  iq: 70
generation:
  temperature: null
fragments: [system, task, mc/memory-profile@1]
---
{% if module.turn == "system" %}{% block instructions %}{% if not module.memory_profile.supplies %}{% include "system" %}{% endif %}{% endblock %}{% block memory_profile %}{% include "mc/memory-profile@1" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
