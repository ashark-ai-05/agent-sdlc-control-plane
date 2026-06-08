export function missionControlHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent SDLC Mission Control</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #09090b; color: #f4f4f5; }
    body { margin: 0; padding: 28px; background: radial-gradient(circle at top left, #172554 0, transparent 32rem), #09090b; }
    main { max-width: 1180px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    .muted { color: #a1a1aa; }
    .grid { display: grid; grid-template-columns: 320px 1fr; gap: 18px; margin-top: 22px; }
    .card { background: rgba(24,24,27,.86); border: 1px solid #3f3f46; border-radius: 16px; padding: 18px; box-shadow: 0 18px 60px rgba(0,0,0,.35); }
    button { background: #2563eb; color: white; border: 0; border-radius: 10px; padding: 9px 12px; font-weight: 700; cursor: pointer; margin: 4px 4px 4px 0; }
    button.secondary { background: #3f3f46; }
    button.danger { background: #be123c; }
    .run { padding: 10px; border-radius: 10px; border: 1px solid #3f3f46; margin: 8px 0; cursor: pointer; }
    .run:hover, .run.active { border-color: #60a5fa; background: rgba(37,99,235,.18); }
    .pill { display: inline-block; border-radius: 999px; padding: 3px 9px; font-size: 12px; background: #27272a; color: #e4e4e7; margin: 2px; }
    .ok { background: #14532d; } .warn { background: #713f12; } .bad { background: #7f1d1d; }
    pre { white-space: pre-wrap; overflow: auto; max-height: 520px; background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 14px; }
    a { color: #93c5fd; }
    input, select { background: #09090b; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 8px; padding: 8px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  </style>
</head>
<body>
<main>
  <h1>Agent SDLC Mission Control</h1>
  <div class="muted" id="repo">Loading repo...</div>
  <div class="grid">
    <section class="card">
      <div class="row"><button onclick="refresh()">Refresh</button><button class="secondary" onclick="scanRepo()">Repo scan</button></div>
      <h2>Runs</h2>
      <div id="runs"></div>
    </section>
    <section class="card">
      <h2 id="title">Select a run</h2>
      <div id="summary"></div>
      <h3>Approvals</h3>
      <div class="row">
        <select id="gate"><option>implementation_plan</option><option>execution</option><option>pr_creation</option><option>enterprise_update</option></select>
        <input id="actor" placeholder="actor" value="mission-control">
        <button onclick="approveGate()">Approve</button>
        <button class="danger" onclick="rejectGate()">Reject</button>
      </div>
      <h3>Workflow actions</h3>
      <div class="row">
        <input id="targetFile" placeholder="target file">
        <input id="setKey" placeholder="config key">
        <input id="setValue" placeholder="value">
        <button onclick="runAction('execute')">Execute config change</button>
      </div>
      <div class="row">
        <button onclick="runAction('pr-preview')">Generate PR preview</button>
        <button onclick="runAction('audit-report')">Audit report</button>
        <button onclick="runAction('create-pr')">Create PR request</button>
        <button onclick="runAction('enterprise-preview')">Enterprise preview</button>
        <button onclick="runAction('apply-enterprise-updates')">Enterprise apply request</button>
      </div>
      <h3>Artifacts</h3>
      <div id="artifacts"></div>
      <h3>Raw status</h3>
      <pre id="raw">{}</pre>
    </section>
  </div>
</main>
<script>
let selectedRun = null;
async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data.error || text));
  return data;
}
async function refresh() {
  const health = await api('/api/health');
  document.getElementById('repo').textContent = health.repo + ' • ' + health.currentBranch;
  const runs = await api('/api/runs');
  document.getElementById('runs').innerHTML = runs.runs.map(r => '<div class="run '+(r.runId===selectedRun?'active':'')+'" onclick="selectRun(\''+r.runId+'\')"><b>'+r.runId+'</b><br><span class="muted">'+r.state+'</span></div>').join('') || '<div class="muted">No runs yet</div>';
  if (selectedRun) await selectRun(selectedRun, false);
}
async function selectRun(runId, rerenderList=true) {
  selectedRun = runId;
  const status = await api('/api/runs/' + encodeURIComponent(runId) + '/status');
  document.getElementById('title').textContent = runId + ' • ' + status.state;
  const validationClass = status.validation.ok === true ? 'ok' : status.validation.ok === false ? 'bad' : 'warn';
  document.getElementById('summary').innerHTML = '<span class="pill '+validationClass+'">validation: '+status.validation.ok+'</span><span class="pill">confidence: '+(status.confidence.overallConfidence ?? 'n/a')+' '+(status.confidence.rating || '')+'</span><p class="muted">Next: '+status.nextRecommendedCommand+'</p>';
  document.getElementById('artifacts').innerHTML = status.artifacts.filter(a => a.present).map(a => '<a class="pill" target="_blank" href="/api/runs/'+encodeURIComponent(runId)+'/artifacts/'+encodeURIComponent(a.name)+'">'+a.name+'</a>').join('');
  document.getElementById('raw').textContent = JSON.stringify(status, null, 2);
  if (rerenderList) await refresh();
}
async function approveGate() {
  if (!selectedRun) return alert('select a run first');
  await api('/api/runs/' + encodeURIComponent(selectedRun) + '/approvals', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ gate: gate.value, status: 'approved', actor: actor.value }) });
  await selectRun(selectedRun);
}
async function rejectGate() {
  if (!selectedRun) return alert('select a run first');
  const reason = prompt('Rejection reason', 'needs changes') || 'needs changes';
  await api('/api/runs/' + encodeURIComponent(selectedRun) + '/approvals', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ gate: gate.value, status: 'rejected', actor: actor.value, reason }) });
  await selectRun(selectedRun);
}
async function scanRepo() { document.getElementById('raw').textContent = JSON.stringify(await api('/api/repo/scan'), null, 2); }
async function runAction(action) {
  if (!selectedRun) return alert('select a run first');
  const payload = action === 'create-pr' ? { projectKey: 'TBD_PROJECT', repoSlug: 'TBD_REPO', reviewers: [] } : action === 'execute' ? { targetFile: targetFile.value, setKey: setKey.value, setValue: setValue.value } : {};
  const result = await api('/api/runs/' + encodeURIComponent(selectedRun) + '/actions/' + encodeURIComponent(action), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  document.getElementById('raw').textContent = JSON.stringify(result, null, 2);
  await selectRun(selectedRun);
}
refresh().catch(e => { document.getElementById('raw').textContent = e.stack || String(e); });
</script>
</body>
</html>`;
}
