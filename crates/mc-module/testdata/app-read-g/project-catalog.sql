WITH RECURSIVE n(x) AS (
    VALUES(1)
    UNION ALL SELECT x + 1 FROM n WHERE x < __MEMORY_COUNT__
)
INSERT INTO memories(project_path, category, content, normalized_hash,
                     first_seen_at, created_at, updated_at, last_seen_at, status)
SELECT printf('/fixture/catalog/project-%02d', x % 60), 'CONSTRAINTS',
       'catalog fixture memory', printf('catalog-%d', x), x, x, x, x, 'active'
FROM n;
