//! Local workspace membership and the shared memory policy from the plugin.
//! Membership comes from context.db, not the memory profile and ownership
//! snapshot frozen for a session.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};

use crate::context_db::StoredMemory;

#[derive(Debug, Clone, Default)]
pub struct Workspace {
    pub own: String,
    pub members: Vec<String>,
    pub names: BTreeMap<String, String>,
    pub canonical: BTreeMap<String, String>,
    pub expanded: Vec<String>,
    pub own_paths: Vec<String>,
    pub share_categories: Option<Vec<String>>,
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn normalize_categories(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw else {
        return vec!["CONSTRAINTS".into()];
    };
    let Ok(mut categories) = serde_json::from_str::<Vec<String>>(&raw) else {
        return Vec::new();
    };
    if categories
        .iter()
        .any(|category| !crate::memory::CATEGORY_ORDER.contains(&category.as_str()))
    {
        return Vec::new();
    }
    categories.sort();
    categories.dedup();
    categories
}

impl Workspace {
    pub fn resolve(conn: &Connection, project: &str) -> rusqlite::Result<Self> {
        let mut workspace = Self {
            own: project.into(),
            ..Self::default()
        };
        if table_exists(conn, "workspace_members")? {
            let mut statement = conn.prepare(
                "SELECT member.project_path, member.display_name
                   FROM workspace_members anchor JOIN workspace_members member
                     ON member.workspace_id = anchor.workspace_id
                  WHERE anchor.project_path = ?1
                  ORDER BY member.display_name ASC, member.project_path ASC",
            )?;
            let rows = statement.query_map([project], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (identity, name) = row?;
                if identity.is_empty() || workspace.members.contains(&identity) {
                    continue;
                }
                if !name.is_empty() {
                    workspace.names.insert(identity.clone(), name);
                }
                workspace.members.push(identity);
            }
        }
        if workspace.members.is_empty() {
            workspace.members.push(project.into());
        }
        workspace.canonical = workspace
            .members
            .iter()
            .map(|id| (id.clone(), id.clone()))
            .collect();
        workspace.expanded = workspace.members.clone();
        if workspace.is_workspaced() {
            // The plugin expands only aliases pointing directly at a member, not alias chains.
            if table_exists(conn, "v22_identity_rekey_map")? {
                let mut statement = conn.prepare(
                    "SELECT old_project_path, new_project_path FROM v22_identity_rekey_map
                      WHERE new_project_path IN (SELECT value FROM json_each(?1))
                      ORDER BY old_project_path ASC",
                )?;
                let rows = statement.query_map(
                    [serde_json::to_string(&workspace.members).unwrap()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                for row in rows {
                    let (old, new) = row?;
                    if !workspace.expanded.contains(&old) {
                        workspace.expanded.push(old.clone());
                    }
                    workspace.canonical.insert(old, new);
                }
            }
            workspace.share_categories = Some(if !table_exists(conn, "workspaces")? {
                Vec::new()
            } else if !column_exists(conn, "workspaces", "share_categories")? {
                vec!["CONSTRAINTS".into()]
            } else {
                let mut statement = conn.prepare(
                    "SELECT workspace.share_categories FROM workspace_members member
                       JOIN workspaces workspace ON workspace.id = member.workspace_id
                      WHERE member.project_path = ?1 ORDER BY workspace.id ASC LIMIT 1",
                )?;
                let mut rows = statement.query([project])?;
                match rows.next()? {
                    Some(row) => normalize_categories(row.get(0)?),
                    None => Vec::new(),
                }
            });
        }
        workspace.own_paths = workspace
            .expanded
            .iter()
            .filter(|path| {
                workspace
                    .canonical
                    .get(*path)
                    .is_some_and(|id| id == project)
            })
            .cloned()
            .collect();
        Ok(workspace)
    }

    pub fn is_workspaced(&self) -> bool {
        self.members.len() > 1
    }

    pub fn member(&self, stored: &str) -> Option<&str> {
        // Raw filesystem paths cannot be resolved through git in ck-mc. Unless
        // explicitly rekeyed, they stay unresolved, just as a failed plugin
        // resolver leaves them: no member floor and no source label.
        self.canonical.get(stored).map(String::as_str)
    }

    pub fn source_name(&self, stored: &str) -> Option<&str> {
        let member = self.member(stored)?;
        (member != self.own)
            .then(|| self.names.get(member))
            .flatten()
            .map(String::as_str)
    }

    /// Bindings for `predicate`: expanded paths, own paths, shared categories.
    pub fn bindings(&self) -> [String; 3] {
        [
            serde_json::to_string(&self.expanded).unwrap(),
            serde_json::to_string(&self.own_paths).unwrap(),
            serde_json::to_string(&self.share_categories).unwrap(),
        ]
    }

    /// Eligibility only; callers add status, expiry and dates. Only project
    /// memories are eligible. A workspace shares by the tag a memory was
    /// written under (`origin_category`), as its settings name them.
    pub fn predicate(&self, conn: &Connection, alias: &str) -> rusqlite::Result<String> {
        let path = format!("{alias}.owner_id");
        let level = format!("{alias}.level = 'project'");
        if self.share_categories.is_none() {
            return Ok(format!(
                "{level} AND {path} IN (SELECT value FROM json_each(?1))"
            ));
        }
        let classification = if column_exists(conn, "memories", "shareable")?
            && column_exists(conn, "memories", "scope")?
        {
            format!(" AND {alias}.shareable = 1 AND {alias}.scope IN ('project','ecosystem','universe')")
        } else {
            String::new()
        };
        Ok(format!(
            "{level} AND ({path} IN (SELECT value FROM json_each(?2)) OR
            ({path} IN (SELECT value FROM json_each(?1)) AND
             {alias}.origin_category IN (SELECT value FROM json_each(?3)){classification}))"
        ))
    }

    pub fn memories(&self, conn: &Connection, now: i64) -> rusqlite::Result<Vec<StoredMemory>> {
        let order = if self.is_workspaced() {
            "m.origin_category ASC, m.updated_at DESC, m.id ASC"
        } else {
            "COALESCE(m.importance, 50) DESC, m.id ASC"
        };
        let sql = format!(
            "SELECT m.id, m.owner_id, m.origin_category, m.content, m.importance,
                m.status, m.expires_at, m.superseded_by_memory_id, m.updated_at,
                m.last_seen_at, m.verified_at FROM memories m
            WHERE {} AND m.status IN ('active','permanent')
              AND (m.expires_at IS NULL OR m.expires_at > ?4)
            ORDER BY {order}",
            self.predicate(conn, "m")?
        );
        let mut statement = conn.prepare(&sql)?;
        let [all, own, categories] = self.bindings();
        let rows = statement.query_map(params![all, own, categories, now], |row| {
            Ok(StoredMemory {
                id: row.get(0)?,
                project_path: row.get(1)?,
                category: row.get(2)?,
                content: row.get(3)?,
                importance: row.get(4)?,
                status: row.get(5)?,
                expires_at: row.get(6)?,
                superseded_by_memory_id: row.get(7)?,
                updated_at: row.get(8)?,
                last_seen_at: row.get(9)?,
                verified_at: row.get(10)?,
            })
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = crate::context_db::ContextDb::fresh_in_memory();
        conn.execute_batch("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(1,'Workspace',0,0);
            INSERT INTO workspace_members VALUES(1,'pj-a','Alpha','/a',0),(1,'pj-b','Beta & Co','/b',0),(1,'pj-c','Gamma','/c',0);").unwrap();
        conn
    }

    fn insert(conn: &Connection, id: i64, project: &str, category: &str) {
        conn.execute(
            "INSERT INTO memories(id,level, owner_id,category, origin_category,content,normalized_hash,
            shareable,scope,first_seen_at,created_at,updated_at,last_seen_at)
            VALUES(?1,'project', ?2,CASE ?3 WHEN 'PROJECT_RULES' THEN 'swe:project-rules' WHEN 'ARCHITECTURE' THEN 'swe:architecture' WHEN 'CONSTRAINTS' THEN 'swe:constraints' WHEN 'CONFIG_VALUES' THEN 'swe:config-values' WHEN 'NAMING' THEN 'swe:naming' WHEN 'USER_DIRECTIVES' THEN 'swe:project-rules' WHEN 'USER_PREFERENCES' THEN 'swe:project-rules' WHEN 'CONFIG_DEFAULTS' THEN 'swe:config-values' WHEN 'ARCHITECTURE_DECISIONS' THEN 'swe:architecture' WHEN 'ENVIRONMENT' THEN 'swe:config-values' WHEN 'WORKFLOW_RULES' THEN 'swe:project-rules' WHEN 'KNOWN_ISSUES' THEN 'swe:constraints' ELSE 'mc:unmapped' END, ?3,'sharedword constraint',?4,1,'project',0,0,0,0)",
            params![id, project, category, format!("hash-{id}")],
        )
        .unwrap();
    }

    fn ids(memories: Vec<StoredMemory>) -> Vec<i64> {
        let mut ids: Vec<_> = memories.iter().map(|memory| memory.id).collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_single_member_keeps_project_order_and_does_not_expand_aliases() {
        let conn = database();
        conn.execute_batch(
            "DELETE FROM workspace_members WHERE project_path <> 'pj-a';
            INSERT INTO v22_identity_rekey_map VALUES('git:old-a','pj-a',0);",
        )
        .unwrap();
        insert(&conn, 1, "pj-a", "PROJECT_RULES");
        insert(&conn, 2, "pj-a", "CONSTRAINTS");
        insert(&conn, 3, "git:old-a", "CONSTRAINTS");
        let workspace = Workspace::resolve(&conn, "pj-a").unwrap();
        assert!(!workspace.is_workspaced());
        assert_eq!(workspace.expanded, ["pj-a"]);
        assert_eq!(workspace.share_categories, None);
        let memories = workspace.memories(&conn, 1).unwrap();
        assert_eq!(
            memories.iter().map(|memory| memory.id).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(
            crate::memory_legacy::trim_workspace_to_budget(
                memories.clone(),
                30,
                &workspace,
                crate::count::Counter::for_model(None)
            ),
            crate::memory_legacy::trim_to_budget(
                memories,
                30,
                crate::count::Counter::for_model(None)
            )
        );
    }

    #[test]
    fn aliases_name_foreign_rows_but_raw_paths_and_alias_chains_stay_unresolved() {
        let conn = database();
        conn.execute_batch(
            "INSERT INTO v22_identity_rekey_map(old_project_path,new_project_path,rekeyed_at)
            VALUES('git:old-a','pj-a',0),('/old/b','pj-b',0),('dir:chain','/old/b',0);",
        )
        .unwrap();
        let workspace = Workspace::resolve(&conn, "pj-a").unwrap();
        assert_eq!(workspace.members, ["pj-a", "pj-b", "pj-c"]);
        assert_eq!(workspace.own_paths, ["pj-a", "git:old-a"]);
        assert_eq!(workspace.source_name("git:old-a"), None);
        assert_eq!(workspace.member("/old/b"), Some("pj-b"));
        assert_eq!(workspace.source_name("/old/b"), Some("Beta & Co"));
        assert_eq!(workspace.member("dir:chain"), None);
        assert_eq!(workspace.member("/unresolved/path"), None);
        let standalone = Workspace::resolve(&conn, "git:old-a").unwrap();
        assert!(!standalone.is_workspaced());
        assert_eq!(standalone.expanded, ["git:old-a"]);
    }

    #[test]
    fn categories_default_normalize_or_fail_closed_and_legacy_columns_are_supported() {
        let conn = database();
        for (raw, expected) in [
            (None, vec!["CONSTRAINTS"]),
            (
                Some("[\"NAMING\",\"CONSTRAINTS\",\"NAMING\"]"),
                vec!["CONSTRAINTS", "NAMING"],
            ),
            (Some("[]"), vec![]),
            (Some("bad"), vec![]),
            (Some("{}"), vec![]),
            (Some("[\"constraints\"]"), vec![]),
            (Some("[1]"), vec![]),
        ] {
            // The current schema disallows NULL, while older workspace rows allowed it.
            conn.execute(
                "UPDATE workspaces SET share_categories=?1",
                [raw.unwrap_or("[\"CONSTRAINTS\"]")],
            )
            .unwrap();
            assert_eq!(normalize_categories(raw.map(str::to_owned)), expected);
            assert_eq!(
                Workspace::resolve(&conn, "pj-a").unwrap().share_categories,
                Some(expected.into_iter().map(str::to_owned).collect())
            );
        }
        conn.execute_batch("ALTER TABLE workspaces DROP COLUMN share_categories;")
            .unwrap();
        assert_eq!(
            Workspace::resolve(&conn, "pj-a").unwrap().share_categories,
            Some(vec!["CONSTRAINTS".into()])
        );
        conn.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE workspaces;")
            .unwrap();
        assert_eq!(
            Workspace::resolve(&conn, "pj-a").unwrap().share_categories,
            Some(vec![])
        );
        conn.execute_batch("DROP TABLE workspace_members;").unwrap();
        let workspace = Workspace::resolve(&conn, "pj-a").unwrap();
        assert_eq!(workspace.share_categories, None);
        assert_eq!(workspace.members, ["pj-a"]);
    }

    #[test]
    fn pool_enforces_foreign_visibility_but_only_head_excludes_nonproject_placements() {
        let conn = database();
        for (id, project, category) in [
            (1, "pj-a", "NAMING"),
            (2, "pj-b", "CONSTRAINTS"),
            (3, "pj-b", "NAMING"),
            (4, "pj-b", "CONSTRAINTS"),
            (5, "pj-b", "CONSTRAINTS"),
            (6, "pj-b", "CONSTRAINTS"),
            (7, "pj-b", "CONSTRAINTS"),
            (8, "pj-b", "CONSTRAINTS"),
            (9, "pj-a", "CONSTRAINTS"),
            (10, "pj-c", "CONSTRAINTS"),
            (11, "pj-c", "CONSTRAINTS"),
        ] {
            insert(&conn, id, project, category);
        }
        conn.execute_batch(
            "UPDATE memories SET shareable=0,scope='private' WHERE id=1;
            UPDATE memories SET shareable=0 WHERE id=4;
            UPDATE memories SET scope='private' WHERE id=5;
            UPDATE memories SET status='archived' WHERE id=6;
            UPDATE memories SET expires_at=10 WHERE id=7;
            UPDATE memories SET status='permanent',scope='ecosystem' WHERE id=8;
            UPDATE memories SET scope='universe' WHERE id=10;
            UPDATE memories SET level='workspace',owner_id='1' WHERE id=8;
            UPDATE memories SET level='global',owner_id='self' WHERE id=9;",
        )
        .unwrap();
        let workspace = Workspace::resolve(&conn, "pj-a").unwrap();
        // Memories at the workspace (8) or global (9) level are not project
        // memories, so no project reader sees them.
        assert_eq!(ids(workspace.memories(&conn, 10).unwrap()), [1, 2, 10, 11]);
        conn.execute_batch(
            "ALTER TABLE memories DROP COLUMN shareable; ALTER TABLE memories DROP COLUMN scope;",
        )
        .unwrap();
        assert_eq!(
            ids(workspace.memories(&conn, 10).unwrap()),
            [1, 2, 4, 5, 10, 11]
        );
    }

    #[test]
    fn plugin_workspace_trim_and_render_vectors_match_byte_for_byte() {
        let conn = database();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/workspace-memory-vectors.json"))
                .unwrap();
        for input in fixture["inputs"].as_array().unwrap() {
            let row = input.as_array().unwrap();
            insert(
                &conn,
                row[0].as_i64().unwrap(),
                row[1].as_str().unwrap(),
                row[2].as_str().unwrap(),
            );
            conn.execute(
                "UPDATE memories SET content=?1,importance=?2,status=?3 WHERE id=?4",
                params![
                    row[3].as_str().unwrap(),
                    row[4].as_i64().unwrap(),
                    row[5].as_str().unwrap(),
                    row[0].as_i64().unwrap()
                ],
            )
            .unwrap();
        }
        let workspace = Workspace::resolve(&conn, "pj-a").unwrap();
        let memories = workspace.memories(&conn, 1).unwrap();
        assert_eq!(
            serde_json::json!(memories.iter().map(|memory| memory.id).collect::<Vec<_>>()),
            fixture["pool"]
        );
        for vector in fixture["vectors"].as_array().unwrap() {
            let selected = crate::memory_legacy::trim_workspace_to_budget(
                memories.clone(),
                vector["budget"].as_u64().unwrap(),
                &workspace,
                crate::count::Counter::for_model(None),
            );
            assert_eq!(
                serde_json::json!(selected.iter().map(|memory| memory.id).collect::<Vec<_>>()),
                vector["selected"],
                "budget {}",
                vector["budget"]
            );
            assert_eq!(
                crate::memory_legacy::render_workspace_block(
                    &selected,
                    "project-memory",
                    Some(&workspace)
                ),
                vector["rendered"].as_str().unwrap(),
                "budget {}",
                vector["budget"]
            );
        }
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use crate::search::sources::{search_memories, Halves, Semantic};
    use std::collections::BTreeSet;

    #[test]
    fn word_and_vector_search_share_eligibility_sources_dates_and_visible_suppression() {
        let conn = crate::context_db::ContextDb::fresh_in_memory();
        conn.execute_batch("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(1,'Example',0,0);
            INSERT INTO workspace_members VALUES(1,'pj-a','Alpha','/a',0),(1,'pj-b','Beta','/b',0);
            INSERT INTO v22_identity_rekey_map VALUES('git:old-b','pj-b',0);
            INSERT INTO memories(id,level, owner_id,category, origin_category,content,normalized_hash,shareable,scope,first_seen_at,created_at,updated_at,last_seen_at)
                VALUES(1,'project', 'git:old-b','swe:constraints', 'CONSTRAINTS','zebra constraint','h1',1,'project',0,50,0,0),
                      (2,'project', 'pj-b','swe:naming', 'NAMING','zebra naming','h2',1,'project',0,50,0,0),
                      (3,'project', 'pj-b','swe:constraints', 'CONSTRAINTS','zebra private','h3',0,'project',0,50,0,0);
            ").unwrap();
        let vector: Vec<u8> = [1.0_f32, 0.0]
            .iter()
            .flat_map(|n| n.to_le_bytes())
            .collect();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO memory_embeddings VALUES(?1,?2,'test')",
                params![id, vector],
            )
            .unwrap();
        }
        let mut halves = Halves::default();
        let semantic = Semantic {
            vector: &[1.0, 0.0],
            model_id: "test",
            chunk_model_id: "test",
        };
        let (hits, suppressed) = search_memories(
            &conn,
            "pj-a",
            "zebra",
            10,
            &BTreeSet::new(),
            None,
            Some(semantic),
            Some(&mut halves),
        );
        assert!(suppressed.is_empty());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, 1);
        assert_eq!(hits[0].source_name.as_deref(), Some("Beta"));
        assert_eq!(hits[0].match_type, "hybrid");
        assert_eq!(halves.words.len(), 1);
        assert_eq!(halves.meaning.len(), 1);
        let (hits, suppressed) = search_memories(
            &conn,
            "pj-a",
            "zebra",
            10,
            &BTreeSet::from([1]),
            None,
            None,
            None,
        );
        assert!(hits.is_empty());
        assert_eq!(suppressed, [1]);
        let (hits, _) = search_memories(
            &conn,
            "pj-a",
            "zebra",
            10,
            &BTreeSet::new(),
            Some(crate::search::messages::DateRange { from: 51, to: 100 }),
            Some(semantic),
            None,
        );
        assert!(hits.is_empty());
        let (hits, _) = search_memories(
            &conn,
            "pj-a",
            "zebra missingword",
            10,
            &BTreeSet::new(),
            None,
            None,
            None,
        );
        assert_eq!(hits.len(), 1, "relaxed FTS must span workspace members too");
    }

    #[test]
    fn named_delta_attributes_escape_names_and_own_deltas_are_unchanged() {
        assert_eq!(crate::memory::added_line(1, "workspace", Some("CONSTRAINTS"),"x < y",Some("Beta & \"Co\"")),
            "  <added id=\"1\" level=\"workspace\" category=\"CONSTRAINTS\" project=\"Beta &amp; &quot;Co&quot;\">x &lt; y</added>");
        assert_eq!(
            crate::memory::updated_line(1, "workspace", Some("CONSTRAINTS"), "x", Some("Beta")),
            "  <updated id=\"1\" level=\"workspace\" category=\"CONSTRAINTS\" project=\"Beta\">x</updated>"
        );
        assert_eq!(
            crate::memory::added_line(1, "project", Some("CONSTRAINTS"), "x", None),
            "  <added id=\"1\" level=\"project\" category=\"CONSTRAINTS\">x</added>"
        );
        assert_eq!(
            crate::memory::updated_line(1, "global", None, "x", None),
            "  <updated id=\"1\" level=\"global\">x</updated>"
        );
        assert_eq!(
            crate::memory::removed_line(1, "global"),
            "  <removed id=\"1\" level=\"global\"/>"
        );
        assert_eq!(
            crate::memory::superseded_line(1, "project", 2),
            "  <superseded id=\"1\" level=\"project\" by=\"2\"/>"
        );
    }
}
