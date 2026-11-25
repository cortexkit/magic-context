---
name: lab
version: 1
display_name: Lab test
---
Test lab persona.{% if tools.git_read %} Git is available.{% endif %}{% if tools.read %} Reader is available.{% endif %}{% if tools.memory_search %} Memory search is available.{% endif %}{% if tools.history_search %} History search is available.{% endif %}
