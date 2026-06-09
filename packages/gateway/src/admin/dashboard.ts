// admin/dashboard.ts — Self-contained admin dashboard (HTML + vanilla JS).
//
// Served as a single document from GET /admin. No build step, no framework: the
// whole control-plane UI is one string so it ships inside the gateway image with
// zero extra toolchain.

export function renderDashboard(): string {
  return DASHBOARD_HTML
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Gateway — Admin</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --border:#272b35; --fg:#e6e8ec; --muted:#9aa3b2; --accent:#4f8cff; --ok:#3fb950; --err:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:16px; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .sp { flex:1; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; font-size:13px; cursor:pointer; }
  button.ghost { background:transparent; border:1px solid var(--border); color:var(--fg); }
  button:disabled { opacity:.5; cursor:default; }
  nav { display:flex; gap:4px; padding:10px 20px 0; flex-wrap:wrap; }
  nav a { padding:8px 12px; border-radius:6px 6px 0 0; cursor:pointer; color:var(--muted); font-size:13px; }
  nav a.active { background:var(--panel); color:var(--fg); }
  main { padding:20px; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; }
  .badge { padding:2px 8px; border-radius:10px; font-size:11px; }
  .badge.running { background:rgba(63,185,80,.15); color:var(--ok); }
  .badge.stopped { background:rgba(154,163,178,.15); color:var(--muted); }
  .badge.error { background:rgba(248,81,73,.15); color:var(--err); }
  textarea { width:100%; min-height:420px; background:#0c0e12; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .row { display:flex; gap:10px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .msg { font-size:13px; padding:8px 12px; border-radius:6px; margin-top:10px; }
  .msg.ok { background:rgba(63,185,80,.12); color:var(--ok); }
  .msg.err { background:rgba(248,81,73,.12); color:var(--err); white-space:pre-wrap; }
  .login { max-width:340px; margin:80px auto; }
  input[type=password],input[type=text] { width:100%; padding:10px; background:#0c0e12; color:var(--fg); border:1px solid var(--border); border-radius:6px; font-size:14px; }
  .muted { color:var(--muted); font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
  .stat { background:#0c0e12; border:1px solid var(--border); border-radius:8px; padding:14px; }
  .stat b { display:block; font-size:22px; margin-top:4px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts) => {
  const res = await fetch('/admin/api' + path, { credentials:'same-origin', headers:{'Content-Type':'application/json'}, ...opts });
  if (res.status === 401) { state.authed = false; render(); throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
};
const state = { authed:true, tab:'overview', data:{} };

async function login(ev) {
  ev.preventDefault();
  const token = $('#token').value;
  const m = $('#loginMsg');
  m.textContent = '';
  try {
    await api('/login', { method:'POST', body: JSON.stringify({ token }) });
    state.authed = true; state.tab='overview'; render(); loadTab();
  } catch (e) { m.className='msg err'; m.textContent = e.message; }
}

function loginView() {
  return '<div class="login panel"><h1>Agent Gateway Admin</h1>' +
    '<form onsubmit="login(event)"><div class="row"><input id="token" type="password" placeholder="Admin token" autofocus /></div>' +
    '<div class="row"><button type="submit">Sign in</button></div><div id="loginMsg"></div></form></div>';
}

const TABS = ['overview','connectors','adapter','config','environment','sessions','audit'];

function shell(inner) {
  return '<header><h1>Agent Gateway</h1><span class="sp"></span>' +
    '<button class="ghost" onclick="logout()">Sign out</button></header>' +
    '<nav>' + TABS.map(t => '<a class="' + (state.tab===t?'active':'') + '" onclick="go(\\'' + t + '\\')">' + t + '</a>').join('') + '</nav>' +
    '<main id="main">' + inner + '</main>';
}

async function logout() { try { await api('/logout',{method:'POST'}); } catch(e){} state.authed=false; render(); }
function go(t) { state.tab=t; render(); loadTab(); }

function render() {
  $('#app').innerHTML = state.authed ? shell('<div class="panel">Loading…</div>') : loginView();
}

async function loadTab() {
  const main = $('#main'); if (!main) return;
  try {
    if (state.tab==='overview') return renderOverview(await api('/status'));
    if (state.tab==='connectors') return renderConnectors(await api('/connectors'));
    if (state.tab==='adapter') return renderAdapter(await api('/adapter'));
    if (state.tab==='config') return renderConfig(await api('/config'));
    if (state.tab==='environment') return renderEnv(await api('/env'));
    if (state.tab==='sessions') return renderSessions(await api('/sessions'));
    if (state.tab==='audit') return renderAudit(await api('/audit'));
  } catch (e) { if (main) main.innerHTML = '<div class="msg err">' + e.message + '</div>'; }
}

function renderOverview(d) {
  const up = Math.floor(d.uptimeMs/1000);
  $('#main').innerHTML = '<div class="grid">' +
    stat('Version', d.version) + stat('Uptime', up + 's') +
    stat('Connectors', d.connectors.length) + stat('Sessions', d.sessionCount) +
    stat('Adapter', d.adapterType) + '</div>' +
    '<div class="panel"><h3>Connectors</h3>' + connectorTable(d.connectors) + '</div>';
}
function stat(label,val){ return '<div class="stat"><span class="muted">'+label+'</span><b>'+val+'</b></div>'; }

function connectorTable(list, editable) {
  if (!list.length) return '<p class="muted">No connectors.</p>';
  return '<table><tr><th>Account</th><th>Type</th><th>Status</th><th>Streaming</th><th>Active</th><th></th></tr>' +
    list.map(c => '<tr><td>'+c.accountId+'</td><td>'+c.type+'</td>' +
      '<td><span class="badge '+c.status+'">'+c.status+'</span>'+(c.lastError?' <span class="muted">'+esc(c.lastError)+'</span>':'')+'</td>' +
      '<td>'+(c.supportsStreaming?'yes':'no')+'</td><td>'+c.activeTurns+'</td>' +
      '<td>'+(editable?'<button class="ghost" onclick="editConnector(\\''+c.accountId+'\\')">Edit</button> ':'')+
        '<button class="ghost" onclick="restartConnector(\\''+c.accountId+'\\')">Restart</button></td></tr>').join('') + '</table>';
}
function renderConnectors(d){ $('#main').innerHTML = '<div class="panel"><h3>Connectors</h3>'+connectorTable(d.connectors, true)+'</div>'; }
async function restartConnector(id){ try { await api('/connectors/'+encodeURIComponent(id)+'/restart',{method:'POST'}); loadTab(); } catch(e){ alert(e.message); } }

async function editConnector(id){
  try {
    const d = await api('/config');
    const conns = (d.config && d.config.connectors) || [];
    const conn = conns.find(c => c && c.accountId === id);
    if (!conn) { alert('Connector not found: '+id); return; }
    state.data.editConnectorId = id;
    $('#main').innerHTML = '<div class="panel"><h3>Edit connector: '+esc(id)+'</h3>' +
      '<p class="muted">accountId is the identity key and cannot be changed. Secrets are shown masked or as environment-variable references — leave them as-is to keep the current value.</p>' +
      '<textarea id="connEdit">'+esc(JSON.stringify(conn,null,2))+'</textarea>' +
      '<div class="row"><button onclick="saveConnector()">Validate &amp; apply</button>' +
      '<button class="ghost" onclick="go(\\'connectors\\')">Cancel</button></div><div id="connMsg"></div></div>';
  } catch(e){ alert(e.message); }
}
async function saveConnector(){
  const m=$('#connMsg'); m.className='msg'; m.textContent='Applying…';
  let conn;
  try { conn = JSON.parse($('#connEdit').value); }
  catch(e){ m.className='msg err'; m.textContent='Invalid JSON: '+e.message; return; }
  const id = state.data.editConnectorId;
  try {
    const r = await api('/connectors/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(conn)});
    let t='Applied. +'+r.connectorResult.added.length+' ~'+r.connectorResult.changed.length+' -'+r.connectorResult.removed.length;
    if (r.requiresRestart && r.requiresRestart.length) t += ' (requires restart: '+r.requiresRestart.join(', ')+')';
    m.className='msg ok'; m.textContent=t;
  } catch(e){ m.className='msg err'; m.textContent=e.message; }
}

function renderAdapter(d){
  $('#main').innerHTML = '<div class="panel"><h3>Adapter</h3>' +
    '<p class="muted">Hot-swappable: '+(d.hotSwappable?'yes (http)':'no — requires restart')+'</p>' +
    '<pre style="overflow:auto">'+esc(JSON.stringify(d.adapter,null,2))+'</pre>' +
    '<div class="row"><button onclick="testAdapter()" '+(d.hotSwappable?'':'disabled')+'>Test connectivity</button>' +
    '<button class="ghost" onclick="restartAdapter()">Rebuild adapter</button></div>' +
    '<div id="adapterMsg"></div></div>';
  state.data.adapter = d.adapter;
}
async function testAdapter(){ const m=$('#adapterMsg'); m.className='msg'; m.textContent='Testing…';
  try { const r = await api('/adapter/test',{method:'POST',body:JSON.stringify(state.data.adapter)});
    m.className='msg '+(r.reachable?'ok':'err'); m.textContent = r.reachable?('Reachable (HTTP '+r.status+')'):('Unreachable: '+(r.error||'')); }
  catch(e){ m.className='msg err'; m.textContent=e.message; } }
async function restartAdapter(){ const m=$('#adapterMsg');
  try { const r = await api('/adapter/restart',{method:'POST'});
    m.className='msg '+(r.ok?'ok':'err'); m.textContent = r.ok?'Adapter rebuilt':(r.requiresRestart?'Requires process restart':r.error); }
  catch(e){ m.className='msg err'; m.textContent=e.message; } }

function renderConfig(d){
  $('#main').innerHTML = '<div class="panel"><h3>Raw configuration (secrets redacted)</h3>' +
    '<textarea id="cfg">'+esc(JSON.stringify(d.config,null,2))+'</textarea>' +
    '<div class="row"><button onclick="validateConfig()" class="ghost">Validate</button>' +
    '<button onclick="saveConfig()">Validate &amp; apply</button></div><div id="cfgMsg"></div></div>';
}
function parseCfg(){ return JSON.parse($('#cfg').value); }
async function validateConfig(){ const m=$('#cfgMsg');
  try { await api('/config/validate',{method:'POST',body:JSON.stringify(parseCfg())}); m.className='msg ok'; m.textContent='Valid'; }
  catch(e){ m.className='msg err'; m.textContent=e.message; } }
async function saveConfig(){ const m=$('#cfgMsg'); m.className='msg'; m.textContent='Applying…';
  try { const r = await api('/config',{method:'PUT',body:JSON.stringify(parseCfg())});
    let t='Applied. +'+r.connectorResult.added.length+' ~'+r.connectorResult.changed.length+' -'+r.connectorResult.removed.length;
    if (r.requiresRestart && r.requiresRestart.length) t += ' (requires restart: '+r.requiresRestart.join(', ')+')';
    if (r.adapterResult && r.adapterResult.requiresRestart) t += ' (adapter requires restart)';
    m.className='msg ok'; m.textContent=t; }
  catch(e){ m.className='msg err'; m.textContent=e.message; } }

function renderEnv(d){
  state.data.env = d.vars || [];
  const rows = state.data.env.map(v =>
    '<tr><td><code>'+esc(v.key)+'</code></td><td style="word-break:break-all">'+esc(v.value)+'</td>' +
    '<td><button class="ghost" onclick="editEnv(\\''+esc(v.key)+'\\')">Edit</button> ' +
    '<button class="ghost" onclick="delEnv(\\''+esc(v.key)+'\\')">Delete</button></td></tr>').join('');
  $('#main').innerHTML = '<div class="panel"><h3>Environment variables (data/.env)</h3>' +
    '<p class="muted">Stored in data/.env. The gateway reads these at container start, so changes here persist to disk but only take effect after the container is recreated (docker compose up).</p>' +
    '<div class="row"><input id="envKey" type="text" placeholder="KEY" style="max-width:260px" /><input id="envVal" type="text" placeholder="value" /></div>' +
    '<div class="row"><button onclick="saveEnv()">Save (add / update)</button></div><div id="envMsg"></div>' +
    '<table><tr><th>Key</th><th>Value</th><th></th></tr>'+(rows||'<tr><td colspan=3 class=muted>None</td></tr>')+'</table></div>';
}
function editEnv(key){
  const v = (state.data.env||[]).find(x => x.key === key);
  $('#envKey').value = key;
  $('#envVal').value = v ? v.value : '';
  $('#envKey').focus();
}
async function saveEnv(){
  const m=$('#envMsg'); const key=$('#envKey').value.trim(); const value=$('#envVal').value;
  if (!key){ m.className='msg err'; m.textContent='Key is required'; return; }
  m.className='msg'; m.textContent='Saving…';
  try {
    await api('/env/'+encodeURIComponent(key),{method:'PUT',body:JSON.stringify({value})});
    loadTab();
  } catch(e){ m.className='msg err'; m.textContent=e.message; }
}
async function delEnv(key){
  if (!confirm('Delete '+key+' from data/.env?')) return;
  try { await api('/env/'+encodeURIComponent(key),{method:'DELETE'}); loadTab(); }
  catch(e){ alert(e.message); }
}

function renderSessions(d){
  const rows = d.sessions.map(s => '<tr><td>'+esc(s.sessionKey)+'</td><td>'+new Date(s.lastTouchedAt).toLocaleString()+'</td><td>'+(s.isNew?'new':'')+'</td></tr>').join('');
  $('#main').innerHTML = '<div class="panel"><h3>Sessions</h3><table><tr><th>Session key</th><th>Last activity</th><th></th></tr>'+(rows||'<tr><td colspan=3 class=muted>None</td></tr>')+'</table></div>';
}
function renderAudit(d){
  const rows = d.entries.map(e => '<tr><td>'+new Date(e.timestamp).toLocaleString()+'</td><td>'+esc(e.platform)+'</td><td>'+esc(e.outcome)+'</td><td>'+esc(e.messageId)+'</td><td>'+(e.error?esc(e.error):'')+'</td></tr>').join('');
  $('#main').innerHTML = '<div class="panel"><h3>Audit log</h3><table><tr><th>Time</th><th>Source</th><th>Outcome</th><th>Detail</th><th>Error</th></tr>'+(rows||'<tr><td colspan=5 class=muted>None</td></tr>')+'</table></div>';
}

function esc(s){ return String(s).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }

render();
if (state.authed) loadTab();
</script>
</body>
</html>`
