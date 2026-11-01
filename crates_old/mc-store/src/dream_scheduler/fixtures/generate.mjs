// Reads TS files extracted with git show 282d9c08bce4:<path> into the evidence
// directory below. Never imports the current plugin source when making fixtures.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dir, '../../../../..');
const evidence = join(root, '.cortexkit/internal-docs/dream-scheduler-evidence');
const names = ['cron', 'storage-dream-state', 'storage-task-schedule', 'lease', 'task-registry', 'token-budget', 'task-scheduler'];
const hashes = Object.fromEntries([...names, 'task-config', 'task-gates', 'idle-schedule-prune', 'provider-output-failure'].map(name => [name + '.ts', createHash('sha256').update(readFileSync(join(evidence, name + '.ts'))).digest('hex')]));
hashes['mod.rs'] = createHash('sha256').update(readFileSync(join(evidence, 'mod.rs'))).digest('hex');
const source = names.map(name => readFileSync(join(evidence, name + '.ts'), 'utf8').replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, '')).join('\n');
const stubs = `
import { Database } from 'bun:sqlite';
const log = () => {};
const logSlowWriteTransaction = () => {};
const withSqliteBackgroundWriter = f => f();
const withDreamerModelCooldown = f => f();
const pruneIdleScheduleIdentities = () => {};
const DREAM_TASK_PROMOTION_DEFAULTS = {'promote-primers': 3, 'review-user-memories': 3};
const isUsableProjectIdentity = p => p.trim().length > 0;
let input = true, gate = true, postGate = true, gateCalls = 0;
const taskHasSchedulableInput = () => input;
const evaluateTaskGate = () => ++gateCalls > 1 ? postGate : gate;
const getDreamTaskBacklogs = () => ({});
export function setInputs(i,g,p) { input=i; gate=g; postGate=p; gateCalls=0; }
`;
const temp = mkdtempSync(join(tmpdir(), 'dream-oracle-'));
try {
    const js = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(stubs + source);
    writeFileSync(join(temp, 'oracle.mjs'), js);
    const m = await import(join(temp, 'oracle.mjs'));
    const { Database } = await import('bun:sqlite');
    let now = 0;
    Date.now = () => now;
    process.env.TZ = 'UTC';
    function db() {
        const d = new Database(':memory:');
        d.exec(`CREATE TABLE dream_state(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE task_schedule_state(project_path TEXT,task TEXT,last_run_at INTEGER,next_due_at INTEGER,schedule TEXT,last_status TEXT,last_error TEXT,retry_count INTEGER,last_checked_commit TEXT,last_broad_run_at INTEGER,retrospective_watermark_ms INTEGER,PRIMARY KEY(project_path,task));`);
        return d;
    }
    function state(d) {
        const s = m.getTaskScheduleState(d, 'git:fixture', 'verify');
        return s && { schedule:s.schedule,last_run_at:s.lastRunAt,next_due_at:s.nextDueAt,last_status:s.lastStatus,last_error:s.lastError,retry_count:s.retryCount,task_state_json:s.taskStateJson,retrospective_watermark_ms:s.retrospectiveWatermarkMs };
    }
    const scenarios = [
        { name:'due_skip_complete', steps:[{time:0, op:'plan',input:false},{time:0,op:'plan'}, {time:59999,op:'plan'},{time:60000,op:'tick',gate:false},{time:120000,op:'tick',post_gate:false},{time:180000,op:'tick',advance_ms:1000},{time:240000,op:'plan'}]},
        { name:'retry_cap', steps:[{time:0,op:'plan'}, ...[60000,61000,62000,63000].map(time=>({time,op:'tick',outcome:{status:'failed',transient:true,error:'network'}}))]},
        { name:'manual_disabled', steps:[{time:1000,op:'manual',schedule:'',gate:false,outcome:{status:'failed',transient:true,error:'network'}},{time:2000,op:'manual',schedule:'',gate:false},{time:60000,op:'plan',schedule:''}]},
        { name:'reconcile', steps:[{time:0,op:'plan'},{time:30000,op:'plan',schedule:'*/5 * * * *'},{time:31000,op:'plan',schedule:''},{time:60000,op:'tick',schedule:'*/5 * * * *'},{time:61000,op:'tick',memory_enabled:false}]},
        { name:'watermark_success_and_failure',steps:[{time:0,op:'plan'},{time:60000,op:'tick',advance_ms:3000,outcome:{status:'completed',schedulePatch:{taskStateJson:'cursor',retrospectiveWatermarkMs:62000}}},{time:120000,op:'tick',outcome:{status:'failed',error:'permanent'}},{time:180000,op:'tick',outcome:{status:'skipped',detail:'no work'}}]},
    ];
    for (const scenario of scenarios) {
        const d = db();
        for (const step of scenario.steps) {
            now = step.time;
            m.setInputs(step.input ?? true, step.gate ?? true, step.post_gate ?? true);
            const config = {task:'verify',schedule:step.schedule ?? '* * * * *',timeoutMinutes:1};
            let executed = 0;
            const deps = {db:d,projectIdentity:'git:fixture',tasks:[config],now, projectMemoryEnabled:step.memory_enabled, executor:async()=>{executed++;now += step.advance_ms ?? 0;return step.outcome ?? {status:'completed'};}};
            let due = [];
            if (step.op === 'plan') due = m.planDueTasks(d,deps.projectIdentity,deps.tasks,now).map(x=>x.scheduledAt);
            else if (step.op === 'manual') await m.runManualDream({...deps,task:'verify'});
            else await m.runDueTasksForProject(deps);
            step.expected = {state:state(d),executed,due};
        }
        d.close();
    }
    const leaseSteps = [
        {time:0,op:'acquire',holder:'a'}, {time:1,op:'acquire',holder:'b'},
        {time:120000,op:'refresh',holder:'a',generation:1},
        {time:240000,op:'acquire',holder:'b'},
        {time:240001,op:'refresh',holder:'a',generation:1},
        {time:240001,op:'release',holder:'a'}, {time:240002,op:'renew',holder:'b',generation:2},
        {time:240003,op:'release',holder:'b'}, {time:240004,op:'acquire',holder:'c'},
    ];
    const d = db();
    for (const step of leaseSteps) {
        now = step.time;
        let result;
        if (step.op === 'acquire') result = m.acquireLeaseWithAcquisition(d,step.holder,'memory:git:fixture');
        if (step.op === 'refresh') result = m.reacquireOwnedLease(d,step.holder,'memory:git:fixture',step.generation);
        if (step.op === 'renew') result = m.renewLease(d,step.holder,'memory:git:fixture',step.generation);
        if (step.op === 'release') {m.releaseLease(d,step.holder,'memory:git:fixture');result = null;}
        step.expected = {allowed:typeof result === 'boolean' ? result : step.op === 'acquire' ? result !== null : null,holder:m.getLeaseHolder(d,'memory:git:fixture'),active:m.isLeaseActive(d,'memory:git:fixture')};
    }
    d.close();
    const manualWaitCases = [];
    for (const releaseAt of [6000, null]) {
        const d = db(); now = 0;
        m.setInputs(true,true,true);
        m.acquireLeaseWithAcquisition(d,'blocker','memory:git:fixture');
        const delays = [];
        const realSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (resolve, ms) => {
            delays.push(ms); now += ms;
            if (releaseAt !== null && now >= releaseAt) m.releaseLease(d,'blocker','memory:git:fixture');
            return realSetTimeout(resolve,0);
        };
        try {
            const result = await m.runManualDream({db:d,projectIdentity:'git:fixture',task:'verify',tasks:[{task:'verify',schedule:'* * * * *',timeoutMinutes:1}],executor:async()=>({status:'completed'})});
            manualWaitCases.push({release_at:releaseAt,delays,ran:result.ran.length,deferred:result.deferredBusy.length,state:state(d)});
        } finally {globalThis.setTimeout = realSetTimeout;d.close();}
    }
    const budgetCases = [
        {name:'threshold_and_refusal',budget:100,ops:[{charge:[50,20,9,false,true]},{charge:[1,0,0,false,true]},{refuse:true},{refuse:true},{charge:[20,0,0,false,true]}]},
        {name:'completed_over_budget',budget:100,ops:[{charge:[110,0,0,true,true]}]},
        {name:'no_finalize_transport',budget:100,ops:[{charge:[80,0,0,false,false]},{refuse:true}]},
        {name:'explicit_finalize',budget:100,ops:[{finalize:true},{finalize:true},{refuse:true},{refuse:true}]},
    ];
    for (const c of budgetCases) {
        const guard = m.createDreamTokenBudget(c.budget);
        for (const op of c.ops) {
            const action = op.charge ? guard.charge(...op.charge) : op.finalize ? guard.finalize() : guard.refuseTool();
            const s = guard.snapshot();
            op.expected = {action,spent:s.spent,finalize_fired:s.finalizeFired,refused_calls:s.refusedCalls,hard_stopped:s.hardStopped};
        }
    }
    const cron = [
        {zone:'UTC',expression:'*/7 1-3/2 * * 7',after:1704067200000},
        {zone:'UTC',expression:'0 0 31 2 *',after:1704067200000},
        {zone:'UTC',expression:'0 0 1 * 1',after:1704067200000},
        {zone:'UTC',expression:'bad',after:1704067200000},
        {zone:'UTC',expression:'',after:1704067200000},
        {zone:'UTC',expression:'5/20 * * * *',after:1704067200000},
        {zone:'America/New_York',expression:'30 2 * * *',after:1710046800000},
        {zone:'America/New_York',expression:'30 1 * * *',after:1730611800000,consumed:1730611800000},
    ];
    for (const c of cron) { process.env.TZ=c.zone; c.expected=m.nextDueAtMs(c.expression,c.after,c.consumed); }
    const fixture = {provenance:{revision:'282d9c08bce490346583a3b8c145c402499f980f',sha256:hashes,dependencies:'Gate/input booleans, no-op idle GC/cooldown/logging, in-memory fixture SQL schema, and fake Date.now are injected. All scheduler, lease, cron and token-budget function bodies are pinned and unmodified.'},scenarios,lease_steps:leaseSteps,manual_wait_cases:manualWaitCases,budget_cases:budgetCases,cron,registry:m.CANONICAL_DREAM_TASKS.map(task=>({task,domain:m.leaseKeyFor(task,'git:fixture'),budget:m.DREAM_TOOL_LOOP_TOKEN_BUDGETS[task] ?? null}))};
    const serialized = JSON.stringify(fixture,null,2)+'\n';
    if (process.argv.includes('--check')) {
        if (readFileSync(join(import.meta.dir,'oracle.json'),'utf8') !== serialized) throw new Error('Frozen TS oracle fixture is stale');
    } else writeFileSync(join(import.meta.dir,'oracle.json'),serialized);
    console.log(`Generated ${scenarios.reduce((n,s)=>n+s.steps.length,0)} schedule steps, ${leaseSteps.length} lease steps, ${budgetCases.length} budget cases, ${cron.length} cron vectors from ${fixture.provenance.revision}`);
} finally { rmSync(temp,{recursive:true,force:true}); }
