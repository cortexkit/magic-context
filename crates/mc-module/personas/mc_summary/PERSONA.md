---
name: mc_summary
version: 1
display_name: Historian
routing:
  consumer: mc.summary
  iq: 50
generation:
  temperature: null
fragments:
  - system
  - mc/language@1
  - mc/memory-profile@1
---
{% block instructions %}{% if not module.memory_profile.supplies %}{% include "system" %}{% endif %}{% endblock %}{% block memory_profile %}{% include "mc/memory-profile@1" %}{% endblock %}{% block language %}{% if module.language.name %}

{% include "mc/language@1" %}{% endif %}{% endblock %}
