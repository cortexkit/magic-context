//! Tasks that mutate the same resource share a conflict-domain lease. Each
//! acquisition gets a distinct token, so replaced holders cannot renew or finish.

use super::{budget::TokenBudget, schedules::TaskName, Error, Result};
use crate::parity_schema_manifest::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Run {
    pub lease: DreamLease,
    pub task: TaskName,
    pub domain: String,
    pub started_at: i64,
    pub scheduled_at: i64,
    pub duration_ms: i64,
    pub budget: TokenBudget,
    pub spent_tokens: u64,
    pub finished: bool,
}

pub(super) fn by_invocation(
    db: &Connection,
    project: &str,
    invocation: &str,
) -> Result<Option<Run>> {
    let json: Option<String> = db
        .query_row(
            "SELECT state FROM dream_runs WHERE project=?1 AND invocation=?2",
            params![project, invocation],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|j| serde_json::from_str(&j).map_err(Error::from))
        .transpose()
}

pub(super) fn save(db: &Connection, run: &Run) -> Result<()> {
    db.execute("INSERT INTO dream_runs(project,invocation,token,state) VALUES(?1,?2,?3,?4) ON CONFLICT(project,invocation) DO UPDATE SET state=excluded.state", params![run.lease.scope.project.0, run.lease.invocation.0, run.lease.token, serde_json::to_string(run)?])?;
    Ok(())
}

pub(super) fn owned(
    db: &Connection,
    lease: &DreamLease,
    now: i64,
    allow_expired: bool,
) -> Result<Run> {
    let run = by_invocation(db, &lease.scope.project.0, &lease.invocation.0)?
        .ok_or(Error::Refused("unknown_run"))?;
    if run.lease.token != lease.token
        || run.lease.scope != lease.scope
        || run.lease.invocation != lease.invocation
    {
        return Err(Error::Refused("superseded_token"));
    }
    if run.finished {
        return Err(Error::Refused("already_finished"));
    }
    let token: Option<String> = db
        .query_row(
            "SELECT token FROM dream_leases WHERE domain=?1",
            [&run.domain],
            |r| r.get(0),
        )
        .optional()?;
    if token.as_deref() != Some(&lease.token) {
        return Err(Error::Refused("superseded_token"));
    }
    if !allow_expired && run.lease.expires_at_ms < now {
        return Err(Error::Refused("lease_expired"));
    }
    Ok(run)
}

pub(super) fn busy(db: &Connection, domain: &str, now: i64) -> Result<bool> {
    let expiry: Option<i64> = db
        .query_row(
            "SELECT expires_at FROM dream_leases WHERE domain=?1",
            [domain],
            |r| r.get(0),
        )
        .optional()?;
    Ok(expiry.is_some_and(|expiry| expiry > now))
}

pub(super) fn acquire(
    db: &Connection,
    request: &DreamClaimRequest,
    task: TaskName,
    scheduled_at: i64,
) -> Result<DreamLease> {
    if let Some(existing) = by_invocation(db, &request.scope.project.0, &request.invocation.0)? {
        if existing.lease.scope != request.scope
            || existing.task != task
            || existing.domain != request.domain
        {
            return Err(Error::Refused("invocation_conflict"));
        }
        if existing.finished {
            return Err(Error::Refused("invocation_finished"));
        }
        return Ok(owned(db, &existing.lease, request.now_ms, false)?.lease);
    }
    if busy(db, &request.domain, request.now_ms)? {
        return Err(Error::Refused("lease_busy"));
    }
    let duration_ms =
        i64::try_from(request.lease_ms).map_err(|_| Error::Refused("invalid_lease_duration"))?;
    if duration_ms <= 0 {
        return Err(Error::Refused("invalid_lease_duration"));
    }
    let expires = request
        .now_ms
        .checked_add(duration_ms)
        .ok_or(Error::Refused("invalid_lease_duration"))?;
    let budget = TokenBudget::new(request.token_budget).map_err(Error::Refused)?;
    let token: String = db.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    let lease = DreamLease {
        scope: request.scope.clone(),
        invocation: request.invocation.clone(),
        token,
        expires_at_ms: expires,
    };
    db.execute("INSERT INTO dream_leases(domain,token,expires_at) VALUES(?1,?2,?3) ON CONFLICT(domain) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at", params![request.domain, lease.token, expires])?;
    save(
        db,
        &Run {
            lease: lease.clone(),
            task,
            domain: request.domain.clone(),
            started_at: request.now_ms,
            scheduled_at,
            duration_ms,
            budget,
            spent_tokens: 0,
            finished: false,
        },
    )?;
    Ok(lease)
}

pub(super) fn heartbeat(db: &Connection, lease: &DreamLease, now: i64) -> Result<DreamLease> {
    // An expired lease may be refreshed only while the same token still owns the
    // domain. A replacement token always wins, including after a restart.
    let mut run = owned(db, lease, now, true)?;
    run.lease.expires_at_ms = now
        .checked_add(run.duration_ms)
        .ok_or(Error::Refused("invalid_lease_duration"))?;
    db.execute(
        "UPDATE dream_leases SET expires_at=?1 WHERE domain=?2 AND token=?3",
        params![run.lease.expires_at_ms, run.domain, lease.token],
    )?;
    save(db, &run)?;
    Ok(run.lease)
}

pub(super) fn release(db: &Connection, run: &Run) -> Result<()> {
    db.execute(
        "DELETE FROM dream_leases WHERE domain=?1 AND token=?2",
        params![run.domain, run.lease.token],
    )?;
    Ok(())
}
