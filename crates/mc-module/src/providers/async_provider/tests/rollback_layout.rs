use super::*;

#[derive(Default)]
struct Announced(Mutex<Vec<String>>);
#[async_trait]
impl Publisher for Announced {
    async fn publish(&self,ready:&notice::ViewReady)->Result<(),HandlerOutcome> {
        self.0.lock().unwrap().push(ready.session_ref.clone());
        Ok(())
    }
}

#[tokio::test]
async fn unreadable_session_does_not_stop_another_sessions_view_announcement() {
    let dir=tempfile::tempdir().unwrap();
    let rig=Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1,1000,None).await;
    moved_session::settle_historian(&rig).await;
    rig.history(20,"announcement isolation history");
    rig.notice(2,1000,None).await;
    moved_session::settle_historian(&rig).await;
    let store=rig.h.store.get().unwrap();
    let (views,high)=store.load_async_compaction_views(&rig.reference).unwrap();
    let (version,raw,engine,_) = views.last().cloned().unwrap();
    let (session,bad_ref)=(0..100).find_map(|index| {
        let session=format!("bad-announcement-{index}");
        let reference=runner_session_ref(&rig.module,"opencode",&session);
        (reference<rig.reference).then_some((session,reference))
    }).unwrap();
    let seen=Arc::new(Announced::default());
    *rig.h.provider_store.async_runtime.publisher.lock().unwrap()=Some(seen.clone());
    let key=format!("[\"{}\",\"{session}\",\"opencode\"]",rig.module);
    store.async_compaction_save(&bad_ref,&key,&session,"{unreadable").commit().unwrap();
    let mut bad_view:Value=serde_json::from_str(&raw).unwrap();
    bad_view["session_ref"]=json!(bad_ref);
    store.save_async_compaction_view(&bad_ref,version,&bad_view.to_string(),engine.as_deref().unwrap()).unwrap();
    let views=views.into_iter().map(|(v,raw,engine,_)|(v,raw,engine,false)).collect::<Vec<_>>();
    store.adopt_async_compaction_views(&rig.reference,&views,high).unwrap();
    rig.h.announce_async_views().await.unwrap();
    assert!(seen.0.lock().unwrap().contains(&rig.reference));
    assert!(!seen.0.lock().unwrap().contains(&bad_ref));
    assert!(store.pending_async_compaction_views().unwrap().iter().any(|(reference,_,_)|reference==&bad_ref));
}

fn fixture() -> (std::path::PathBuf,Arc<McStore>,Vec<String>) {
    let path=std::path::PathBuf::from(std::env::var("MC_ROLLBACK_DIR").unwrap());
    let references=serde_json::from_slice(&std::fs::read(path.join("references.json")).unwrap()).unwrap();
    let store=Arc::new(McStore::open_for_test(&StorageDescriptor {module_id:DEFAULT_MODULE_ID.into(),storage_namespace:"mc_cache".into(),isolation:Isolation::Module,
        backend:StorageBackend::Sqlite {path:path.join("store.db").to_string_lossy().into_owned()}}).unwrap());
    (path,store,references)
}

fn legacy_count(conn:&rusqlite::Connection,reference:&str)->Vec<u64> {
    ["mc_async_compaction","mc_async_compaction_entries","mc_async_compaction_views","mc_async_compaction_baselines"].iter().map(|table|
        conn.query_row(&format!("SELECT count(*) FROM main.{table} WHERE session_ref=?1"),[reference],|row|row.get(0)).unwrap()).collect()
}

#[tokio::test]
#[ignore = "cross-version fixture; driven after the archived placed build seeds it"]
async fn rollback_migrate_placed_fixture() {
    let (path,store,references)=fixture();
    let conn=rusqlite::Connection::open(path.join("store.db")).unwrap();
    let raw:String=conn.query_row("SELECT state_json FROM main.mc_async_compaction WHERE session_ref=?1",[&references[0]],|row|row.get(0)).unwrap();
    let before:Value=serde_json::from_str(&raw).unwrap();
    let mut migrated=load(&store,&references[0]).unwrap().unwrap();
    assert_eq!(serde_json::to_vec(&migrated.initial).unwrap(),serde_json::to_vec(&before["initial"]).unwrap());
    migrated.save(&store,&[]).unwrap();
    assert!(migrated.input_revision.is_some());
    assert_eq!(legacy_count(&conn,&references[0]),vec![0,0,0,0]);
    assert!(legacy_count(&conn,&references[1]).iter().all(|count|*count>0));
    let header:Value=serde_json::from_str(&store.load_async_compaction(&references[0]).unwrap().unwrap()).unwrap();
    assert!(header.get("initial").is_none());
    assert_eq!(header["initial_stored"],true);
    eprintln!("NEW_MIGRATION migrated_legacy_rows=0 header_is_cold=true revision_known=true untouched_legacy_rows={:?}",legacy_count(&conn,&references[1]));
}

#[tokio::test]
#[ignore = "cross-version fixture; driven after the placed build starts fresh"]
async fn rollback_reupgrade_prefers_the_fresh_legacy_record() {
    let (path,store,references)=fixture();
    let conn=rusqlite::Connection::open(path.join("store.db")).unwrap();
    let raw:String=conn.query_row("SELECT state_json FROM main.mc_async_compaction WHERE session_ref=?1",[&references[0]],|row|row.get(0)).unwrap();
    let before:Value=serde_json::from_str(&raw).unwrap();
    let state=load(&store,&references[0]).unwrap().unwrap();
    assert_eq!(state.generation,0);
    assert_eq!(state.initial,before["initial"]);
    assert!(store.load_async_compaction_views(&references[0]).unwrap().0.is_empty());
    assert_eq!(legacy_count(&conn,&references[0]),vec![0,0,0,0]);
    assert!(legacy_count(&conn,&references[1])[0]>0);
    eprintln!("NEW_REUPGRADE fresh_legacy_authoritative=true stale_views=0 migrated_legacy_rows=0 untouched_record_still_legacy=true");
}
