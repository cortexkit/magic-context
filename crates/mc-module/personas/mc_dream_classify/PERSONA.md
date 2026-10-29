---
name: mc_dream_classify
version: 1
display_name: Memory classifier
routing:
  consumer: mc.dream.classify-memories
  iq: 50
generation:
  temperature: null
fragments: [system, task, mc/memory-profile@1]
---
{% if module.turn == "system" %}{% block instructions %}{% if not module.memory_profile.supplies %}{% include "system" %}{% endif %}{% endblock %}{% block memory_profile %}{% include "mc/memory-profile@1" %}{% endblock %}{% else %}{% block task %}{% include "task" %}{% endblock %}{% endif %}
