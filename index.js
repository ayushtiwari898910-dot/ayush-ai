const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const multer = require('multer');

const PORT = process.env.PORT || 25029;
const HOST = '0.0.0.0';
const AUTH_DIR = 'auth_info_baileys';

const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 30000;

// ===== SECURE GF - MEMORY ONLY, CODE ME LEAK NAHI HOGA =====
let GF_JIDS = [];
const GF_PROMPT = `You are Ayush, not AI. You are Ayush, the loving boyfriend. Talk in romantic, caring Hinglish like real boyfriend. Use baby, jaan, ❤️ natural. Keep replies SHORT 1-2 lines. If she is angry, manao pyaar se. NEVER say you are AI. You ARE Ayush.`;
const NORMAL_PROMPT = `You are Ayush. You are a real human assistant on WhatsApp. Talk in natural Hinglish, short, friendly, smart. Don't sound like a bot.`;

let sock = null;
let pairingCode = null;
let isPaired = false;
let currentPhone = null;
let pairingRequested = false;
let isConnecting = false;
let lastError = null;
let connectedAt = null;
let serverStartTime = Date.now();
let groupsCache = {};

const aiAutoReplyState = { enabled: true, systemPrompt: NORMAL_PROMPT, stats: { handled: 0, failed: 0 } };

const bulkState = {
  running: false, stopFlag: false, sent: 0, failed: 0, tasks: 0, total: 0, remaining: 0,
  cycle: 0, msgIndex: 0, targetIndex: 0, totalTargets: 0, currentMessage: '', currentTarget: '',
  targets: [], messages: [], delayMs: DEFAULT_DELAY_SECONDS * 1000,
  logs: [], logId: 0, startedAt: null, workerAlive: false, lastBeat: 0,
  groupNameLock: '', groupPhotoLock: 'any',
};

const watcherState = {
  enabled: false, message: '', watchName: true, watchPhoto: true, intervalSec: 45,
  snapshots: {}, events: [], eventId: 0,
  stats: { nameChanges: 0, photoChanges: 0, sent: 0, failed: 0 },
  timer: null, lastCheck: 0,
};

const masterLock = { enabled: false, password: '', setAt: null };

function checkOwnerAuth(req) {
  if (!masterLock.enabled) return true;
  const key = req.headers['x-owner-key'] || (req.body && req.body.ownerKey) || req.query.ownerKey;
  return key === masterLock.password;
}

function pushLog(type, msg) {
  bulkState.logs.push({ id: ++bulkState.logId, ts: Date.now(), type, msg });
  if (bulkState.logs.length > 500) bulkState.logs.splice(0, bulkState.logs.length - 500);
  console.log(`[${type}] ${msg}`);
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function getGroupsFromStore() {
  const out = [];
  try {
    if (sock && sock.store && sock.store.groupMetadata) {
      const map = sock.store.groupMetadata;
      map.forEach((v) => { out.push({ id: v.id, name: v.subject || '', size: v.participants ? v.participants.length : 0 }); });
    }
  } catch (_) {}
  return out;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isSocketReady() { return !!(sock && isPaired); }

async function getAIResponse(userMessage, isGF) {
  try {
    const basePrompt = isGF ? GF_PROMPT : aiAutoReplyState.systemPrompt;
    const fullPrompt = `${basePrompt}\n\nUser: ${userMessage}\nReply as Ayush in Hinglish, short:`;
    const response = await fetch(`https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}?model=openai`);
    let text = await response.text();
    if (!text) throw new Error('empty');
    return text.replace(fullPrompt, '').trim().slice(0, 1000);
  } catch (e) { return isGF ? "baby network issue tha ❤️ bolo na?" : "Hello! I am Ayush's personal AI assistant."; }
}

function parseNumbers(raw) {
  if (!raw) return [];
  const out = []; const seen = new Set();
  String(raw).split(/[\r\n,;\s]+/).forEach((tok) => {
    const t = tok.trim(); if (!t) return;
    if (/@g\.us$/i.test(t)) { if (seen.has(t)) return; seen.add(t); out.push({ jid: t, label: '[G] ' + t }); return; }
    const digits = t.replace(/[^\d]/g, ''); if (!digits || digits.length < 8 || digits.length > 15) return;
    const jid = digits + '@s.whatsapp.net'; if (seen.has(jid)) return; seen.add(jid);
    out.push({ jid, label: '[N] +' + digits });
  });
  return out;
}
async function groupHasPhoto(jid) { try { if (!sock) return false; const url = await sock.profilePictureUrl(jid, 'image'); return !!url; } catch (_) { return false; } }
function addWatcherEvent(jid, gname, type, oldVal, newVal, ok, err) {
  watcherState.events.push({ id: ++watcherState.eventId, ts: Date.now(), jid, gname, type, oldVal: oldVal || '', newVal: newVal || '', ok: !!ok, err: err || '' });
  if (watcherState.events.length > 300) watcherState.events.splice(0, watcherState.events.length - 300);
}
async function buildGroupSnapshot() {
  const out = {}; const jids = Object.keys(groupsCache).filter((j) => j.endsWith('@g.us'));
  for (const jid of jids) { const meta = groupsCache[jid]; let photo = null; try { photo = await sock.profilePictureUrl(jid, 'image'); } catch (_) { photo = null; } out[jid] = { name: (meta && meta.name) || '', photo }; }
  return out;
}
async function fireWatcherEvent(jid, type, oldVal, newVal) {
  const meta = groupsCache[jid]; const gname = (meta && meta.name) || jid;
  let text = watcherState.message || ''; if (!text.trim()) return;
  text = text.replace(/\{\{group\}\}/g, gname).replace(/\{\{type\}\}/g, type === 'name' ? 'name' : 'photo').replace(/\{\{old\}\}/g, oldVal || '—').replace(/\{\{new\}\}/g, newVal || '—');
  try { await sock.sendMessage(jid, { text }); watcherState.stats.sent++; if (type === 'name') watcherState.stats.nameChanges++; else watcherState.stats.photoChanges++; addWatcherEvent(jid, gname, type, oldVal, newVal, true); } catch (e) { watcherState.stats.failed++; addWatcherEvent(jid, gname, type, oldVal, newVal, false, e.message); }
}
async function runWatcherCheck() {
  if (!watcherState.enabled || !isSocketReady()) return;
  try { const fresh = await buildGroupSnapshot(); const old = watcherState.snapshots; for (const jid of Object.keys(fresh)) { const n = fresh[jid]; const o = old[jid]; if (!o) continue; if (watcherState.watchName && o.name !== n.name && n.name) { await fireWatcherEvent(jid, 'name', o.name, n.name); } if (watcherState.watchPhoto && o.photo !== n.photo) { await fireWatcherEvent(jid, 'photo', o.photo ? 'old-photo' : 'none', n.photo ? 'new-photo' : 'removed'); } } watcherState.snapshots = fresh; watcherState.lastCheck = Date.now(); } catch (e) { pushLog('warn', 'Watcher check failed: ' + e.message); }
}
function startWatcherLoop() { if (watcherState.timer) clearInterval(watcherState.timer); watcherState.timer = setInterval(runWatcherCheck, watcherState.intervalSec * 1000); }
function stopWatcherLoop() { if (watcherState.timer) { clearInterval(watcherState.timer); watcherState.timer = null; } }
async function safeSend(jid, text) {
  let lastErr = null; for (let attempt = 0; attempt <= SEND_RETRY; attempt++) { try { if (!isSocketReady()) throw new Error('socket not ready'); await sock.sendMessage(jid, { text }); return { ok: true }; } catch (e) { lastErr = e; if (attempt < SEND_RETRY) { pushLog('warn', `Retry ${attempt + 1}/${SEND_RETRY} → ${jid}: ${e.message}`); await sleep(RETRY_WAIT_MS); } } } return { ok: false, error: lastErr ? lastErr.message : 'unknown' };
}
async function runWorker() {
  if (bulkState.workerAlive) return; bulkState.workerAlive = true; pushLog('info', 'Worker started — 24/7 loop active');
  try {
    while (!bulkState.stopFlag) {
      if (!isSocketReady()) { bulkState.lastBeat = Date.now(); await sleep(3000); continue; }
      for (let mi = 0; mi < bulkState.messages.length && !bulkState.stopFlag; mi++) {
        const msg = bulkState.messages[mi]; bulkState.msgIndex = mi; bulkState.currentMessage = msg;
        for (let ti = 0; ti < bulkState.targets.length && !bulkState.stopFlag; ti++) {
          const t = bulkState.targets[ti]; bulkState.targetIndex = ti; bulkState.currentTarget = t.label; bulkState.lastBeat = Date.now();
          if (!isSocketReady()) { pushLog('warn', 'Socket temporarily unavailable — waiting to resume'); break; }
          try { const res = await safeSend(t.jid, msg); if (res.ok) { bulkState.sent++; pushLog('ok', `Cycle ${bulkState.cycle + 1} | Msg ${mi + 1}/${bulkState.messages.length} → ${t.label}`); } else { bulkState.failed++; pushLog('err', `Msg ${mi + 1} → ${t.label}: ${res.error}`); } } catch (e) { bulkState.failed++; pushLog('err', `Unexpected send error → ${t.label}: ${e.message}`); }
          bulkState.remaining = bulkState.messages.length - (mi + 1); if (!bulkState.stopFlag) { await sleep(bulkState.delayMs); }
        }
        if (!isSocketReady() && !bulkState.stopFlag) break;
      }
      if (!bulkState.stopFlag) { bulkState.cycle++; bulkState.remaining = bulkState.messages.length; bulkState.msgIndex = 0; bulkState.targetIndex = 0; pushLog('info', `Cycle ${bulkState.cycle} completed — restarting from Message 1`); }
    }
  } catch (loopErr) { pushLog('err', 'Worker crashed: ' + loopErr.message); if (!bulkState.stopFlag) { bulkState.workerAlive = false; bulkState.running = true; setTimeout(() => { runWorker(); }, 3000); return; } } finally { if (bulkState.stopFlag) { bulkState.running = false; bulkState.stopFlag = false; bulkState.workerAlive = false; bulkState.currentMessage = ''; bulkState.currentTarget = ''; pushLog('info', `Task stopped — Sent: ${bulkState.sent}, Failed: ${bulkState.failed}, Cycles: ${bulkState.cycle}`); } else { bulkState.workerAlive = false; } }
}
setInterval(() => { if (bulkState.running && !bulkState.workerAlive) { pushLog('warn', 'Watchdog: worker not alive — restarting'); runWorker(); } }, WATCHDOG_INTERVAL_MS);

// ===== YAHI TERI ORIGINAL PAIRING METHOD HAI - PURI COPY =====
async function connectToWhatsApp(phone) {
  if (!phone) throw new Error('Phone number required');
  if (isConnecting) throw new Error('Connection already in progress');
  if (isPaired) throw new Error('Already paired');
  isConnecting = true; currentPhone = phone; pairingCode = null; lastError = null;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      mobile: false, syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);

    // AI AUTO REPLY LISTENER - GF MODE ADDED
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!aiAutoReplyState.enabled) return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue; if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid;
        if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) continue;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption;
        if (!text) continue;
        const isGF = GF_JIDS.includes(remoteJid);
        try {
          const aiReply = await getAIResponse(text, isGF);
          await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg });
          aiAutoReplyState.stats.handled++;
        } catch (e) { aiAutoReplyState.stats.failed++; }
      }
    });

    sock.ev.on('groups.upsert', (groups) => { groups.forEach((g) => { groupsCache[g.id] = { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }; }); });
    sock.ev.on('groups.update', (updates) => {
      updates.forEach((u) => { if (groupsCache[u.id]) { if (u.subject) groupsCache[u.id].name = u.subject; } else if (u.id) { groupsCache[u.id] = { id: u.id, name: u.subject || '', size: 0 }; } });
      if (watcherState.enabled && watcherState.watchName) {
        updates.forEach((u) => {
          if (!u.subject || !u.id) return; const prev = watcherState.snapshots[u.id];
          if (prev && prev.name && prev.name !== u.subject) { const oldName = prev.name; prev.name = u.subject; fireWatcherEvent(u.id, 'name', oldName, u.subject); }
          else if (!prev) { watcherState.snapshots[u.id] = { name: u.subject, photo: null }; }
        });
      }
    });

    // ==== TERI WALI PAIRING CODE LOGIC - 100% SAME ====
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'connecting' && !sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        try {
          await sleep(1000);
          pairingCode = await sock.requestPairingCode(phone);
          console.log(`\n📱 PAIRING CODE for ${phone}: ${pairingCode}\n`);
          pushLog('info', `Pairing code for ${phone}: ${pairingCode}`);
          lastError = null;
        } catch (err) {
          console.error('❌ Pairing code error:', err.message);
          lastError = err.message; pairingCode = null; pairingRequested = false; isConnecting = false;
        }
      }
      if (connection === 'open') {
        console.log('✅ WhatsApp connected!'); isPaired = true; pairingCode = null; pairingRequested = false; isConnecting = false; connectedAt = new Date().toISOString(); lastError = null; pushLog('ok', `WhatsApp connected (${phone})`);
        setTimeout(() => { try { const groups = getGroupsFromStore(); groups.forEach((g) => { groupsCache[g.id] = g; }); pushLog('info', `Loaded ${groups.length} groups into cache`); } catch (e) {} }, 3000);
        setTimeout(async () => { try { watcherState.snapshots = await buildGroupSnapshot(); pushLog('info', `Watcher snapshot ready (${Object.keys(watcherState.snapshots).length} groups)`); } catch (_) {} }, 5000);
        if (bulkState.running && !bulkState.workerAlive) { pushLog('info', 'Reconnect detected — resuming bulk worker'); runWorker(); }
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode; const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        pushLog('warn', `Connection closed (code ${statusCode})`); isPaired = false; isConnecting = false;
        if (bulkState.running) { pushLog('warn', 'Socket dropped — worker will auto-resume after reconnect'); }
        if (shouldReconnect && currentPhone) { pairingRequested = false; setTimeout(() => connectToWhatsApp(currentPhone).catch(console.error), 3000); }
        else if (statusCode === DisconnectReason.loggedOut) { pairingCode = null; pairingRequested = false; currentPhone = null; if (bulkState.running) { bulkState.stopFlag = true; pushLog('warn', 'Logged out — stopping bulk worker'); } }
      }
    });
  } catch (err) { isConnecting = false; lastError = err.message; throw err; }
}

const DASHBOARD_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>9AMAN X YAMDHUD — Control Center</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#050507;color:#e2e8f0;min-height:100vh}.container{max-width:1180px;margin:0 auto;padding:28px 18px 60px}.brand{text-align:center;margin-bottom:26px}.brand h1{font-size:28px;font-weight:900;letter-spacing:3px;color:#fff}.brand h1 .x{color:#ff003c}.card{background:linear-gradient(155deg, rgba(20,20,28,.72), rgba(10,10,15,.55));border:1px solid rgba(255,0,60,.28);border-radius:18px;padding:24px;margin-bottom:20px}.card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:2px;text-transform:uppercase}label{display:block;font-size:11px;color:#9a9aab;margin-bottom:7px;text-transform:uppercase}input,textarea,select{width:100%;background:rgba(5,5,10,.75);border:1px solid rgba(255,0,60,.25);border-radius:12px;padding:12px 14px;color:#fff;font-size:14px}button{background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border:none;border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;width:100%;margin-top:6px}button.ghost{background:transparent;border:1px solid rgba(255,0,60,.5);color:#ff5277}button.danger{background:linear-gradient(180deg,#ff0040,#a80028)} .badge{display:inline-block;padding:7px 16px;border-radius:999px;font-size:11px;font-weight:700}.b-idle{background:rgba(120,120,140,.15);color:#a8a8b8}.b-wait{background:rgba(255,180,0,.12);color:#ffc655}.b-paired{background:rgba(255,0,60,.14);color:#ff5277;border:1px solid rgba(255,0,60,.55)}.code-box{background:rgba(5,5,10,.85);border:2px dashed #ff003c;border-radius:16px;padding:26px 20px;margin:18px 0;text-align:center}.code-value{font-size:38px;font-weight:900;letter-spacing:8px;color:#ff003c;font-family:monospace}.msg{margin-top:14px;padding:12px 15px;border-radius:10px;font-size:13px;display:none}.msg.ok{background:rgba(255,0,60,.1);color:#ff8ba6;border:1px solid rgba(255,0,60,.4);display:block}.msg.err{background:rgba(255,60,60,.1);color:#ffa1a1;border:1px solid rgba(255,60,60,.4);display:block}.hidden{display:none!important}</style></head>
<body><div class="container"><div class="brand"><h1>AYUSH <span class="x">X</span> D3VIK9</h1><p>GF Private + Bulk + AI</p></div>

<div class="card"><h2>Connection Status</h2><span id="badge" class="badge b-idle">Idle</span><div id="errBox" class="msg err hidden"></div></div>

<div class="card"><h2>❤️ GF Private Number - Secure</h2><label>GF Number (Private, Code me nahi dikhega)</label><input id="gfInput" type="tel" placeholder="919876543210"/><button onclick="saveGF()">Save GF Number (Private)</button><div id="gfMsg" class="msg"></div><div id="gfList" style="margin-top:10px;color:#ff8da8;font-size:12px"></div></div>

<div class="card" id="pairCard"><h2>Pair WhatsApp - TERI WALI METHOD</h2><label>Phone Number (no +)</label><input id="phoneInput" type="tel" placeholder="919876543210"/><button id="pairBtn" onclick="startPair()">Get Pairing Code</button><div id="codeSection" class="hidden"><div class="code-box"><div id="codeValue">Generating...</div></div><p style="font-size:13px;color:#aaa">WhatsApp > Linked Devices > Link a Device > Link with phone number > Enter code</p></div><div id="pairMsg" class="msg"></div></div>

<div class="card"><h2>Bulk Sender & AI Status</h2><div id="aiStatus">AI: ON</div><div id="bulkStatus">Bulk: Idle</div><button class="ghost" onclick="logout()">Logout / Reset</button></div>

</div>
<script>
async function startPair(){
  const phone=document.getElementById('phoneInput').value.trim();
  const msgEl=document.getElementById('pairMsg');
  if(!phone){msgEl.textContent='Number daal';msgEl.className='msg err';return;}
  try{
    const res=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});
    const data=await res.json(); if(!data.success)throw new Error(data.error);
    document.getElementById('codeSection').classList.remove('hidden');
    msgEl.textContent='Pairing started - code aayega';msgEl.className='msg ok';
  }catch(e){msgEl.textContent=e.message;msgEl.className='msg err';}
}
async function saveGF(){
  const gfNum=document.getElementById('gfInput').value.trim();
  const msg=document.getElementById('gfMsg');
  if(!gfNum){msg.textContent='GF number daal';msg.className='msg err';return;}
  const res=await fetch('/api/gf/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numbers:[gfNum]})});
  const d=await res.json();
  msg.textContent='GF Saved Securely! ❤️';msg.className='msg ok'; loadGF();
}
async function loadGF(){ try{ const r=await fetch('/api/gf/status'); const d=await r.json(); document.getElementById('gfList').textContent = d.gf && d.gf.length ? d.gf.join(', ') + ' - Private Mode' : 'No GF set'; }catch(e){} }
async function logout(){ if(!confirm('Logout?'))return; await fetch('/api/logout',{method:'POST'}); location.reload(); }
async function pollStatus(){
  try{
    const res=await fetch('/api/status'); const d=await res.json();
    const badge=document.getElementById('badge');
    const codeSection=document.getElementById('codeSection');
    const codeValue=document.getElementById('codeValue');
    const errBox=document.getElementById('errBox');
    if(d.paired){ badge.textContent='Paired: '+d.phone; badge.className='badge b-paired'; codeSection.classList.add('hidden'); }
    else if(d.code){ badge.textContent='Waiting for pairing'; badge.className='badge b-wait'; codeSection.classList.remove('hidden'); codeValue.textContent=d.code; }
    else if(d.connecting){ badge.textContent='Connecting'; badge.className='badge b-wait'; }
    else{ badge.textContent='Idle'; badge.className='badge b-idle'; }
    if(d.error){ errBox.textContent=d.error; errBox.classList.remove('hidden'); } else{ errBox.classList.add('hidden'); }
  }catch(e){}
  setTimeout(pollStatus,2000);
}
pollStatus(); loadGF();
</script></body></html>`;

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));
const upload = multer({ dest: 'uploads/' });

app.post('/api/pair', async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked — owner key required' });
    const { phone } = req.body;
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ success: false, error: 'Invalid phone number' });
    if (isPaired) return res.status(400).json({ success: false, error: 'Already paired. Logout first.' });
    if (isConnecting) return res.status(400).json({ success: false, error: 'Connection in progress for ' + (currentPhone || 'another number') + '. Wait or logout.' });
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectToWhatsApp(phone).catch((e) => { console.error('Connect failed:', e.message); lastError = e.message; });
    res.json({ success: true, message: 'Pairing initiated' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/status', (req, res) => { res.json({ paired: isPaired, connecting: isConnecting, code: isPaired ? null : pairingCode, phone: currentPhone, connectedAt, error: lastError }); });
app.get('/api/gf/status', (req,res)=> res.json({gf:GF_JIDS}));
app.post('/api/gf/config', (req,res)=>{
  try{
    const {numbers}=req.body; if(!numbers||!Array.isArray(numbers)) return res.status(400).json({success:false,error:'numbers array required'});
    GF_JIDS = numbers.map(n=>{ let clean=n.replace(/[^0-9]/g,''); if(!clean) return null; return clean+'@s.whatsapp.net'; }).filter(Boolean);
    pushLog('info',`GF Private Updated: ${GF_JIDS.length}`);
    res.json({success:true,gf:GF_JIDS});
  }catch(e){ res.status(500).json({success:false,error:e.message}); }
});
app.get('/api/groups', async (req, res) => {
  try {
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'WhatsApp not paired yet' });
    const map = new Map(); Object.values(groupsCache).forEach((g) => map.set(g.id, g));
    try { getGroupsFromStore().forEach((g) => { if (!map.has(g.id)) map.set(g.id, g); }); } catch (_) {}
    if (map.size === 0 && typeof sock.groupFetchAllParticipating === 'function') { try { const all = await sock.groupFetchAllParticipating(); Object.values(all).forEach((g) => { map.set(g.id, { id: g.id, name: g.subject || '', size: g.participants ? g.participants.length : 0 }); }); } catch (e) {} }
    const groups = [...map.values()].filter((g) => g.id && g.id.endsWith('@g.us')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach((g) => { groupsCache[g.id] = g; }); res.json({ success: true, groups });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/send-groups', async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'WhatsApp not paired yet' });
    const { groupIds, message } = req.body; if (!Array.isArray(groupIds) || !groupIds.length) return res.status(400).json({ success: false, error: 'No groups selected' }); if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message is required' });
    let sent = 0, failed = 0; const errors = []; for (const jid of groupIds) { try { await sock.sendMessage(jid, { text: message }); sent++; } catch (e) { failed++; errors.push(jid + ': ' + e.message); } await sleep(800); } res.json({ success: true, sent, failed, total: groupIds.length, errors });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/bulk/start', upload.single('file'), async (req, res) => {
  try {
    if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' });
    if (!isPaired || !sock) return res.status(400).json({ success: false, error: 'WhatsApp not paired' });
    if (bulkState.running) return res.status(400).json({ success: false, error: 'Task already running' });
    const filePath = req.file ? req.file.path : null; if (!filePath) return res.status(400).json({ success: false, error: 'Upload .txt file' });
    const content = fs.readFileSync(filePath, 'utf8'); fs.unlinkSync(filePath);
    const seen = new Set(); const messages = []; content.split(/\r?\n/).forEach(line => { const t = line.trim(); if (!t) return; if (seen.has(t)) return; seen.add(t); messages.push(t); });
    if (!messages.length) return res.status(400).json({ success: false, error: 'No messages in file' });
    let targets = []; let groupIds = []; try { groupIds = JSON.parse(req.body.groupIds || '[]'); } catch (_) {}
    const numbersRaw = req.body.numbers || ''; const hater = req.body.hater || ''; const lastHater = req.body.lastHater || '';
    let delay = parseInt(req.body.delay) || DEFAULT_DELAY_SECONDS; if (delay < MIN_DELAY_SECONDS) delay = MIN_DELAY_SECONDS;
    const groupNameLock = (req.body.groupNameLock || '').trim().toLowerCase(); const groupPhotoLock = req.body.groupPhotoLock || 'any';
    if (groupIds.length) { for (const jid of groupIds) { if (!jid.endsWith('@g.us')) continue; const meta = groupsCache[jid]; if (groupNameLock && meta && !meta.name.toLowerCase().includes(groupNameLock)) continue; if (groupPhotoLock !== 'any') { const hasPhoto = await groupHasPhoto(jid); if (groupPhotoLock === 'has' && !hasPhoto) continue; if (groupPhotoLock === 'none' && hasPhoto) continue; } targets.push({ jid, label: '[G] ' + (meta ? meta.name : jid) }); } }
    if (numbersRaw) { const parsed = parseNumbers(numbersRaw); parsed.forEach(p => { if (!targets.find(t => t.jid === p.jid)) targets.push(p); }); }
    if (!targets.length) return res.status(400).json({ success: false, error: 'No valid targets after locks' });
    let finalMessages = messages.map(m => { let txt = m; if (hater) txt = hater + ' ' + txt; if (lastHater) txt = txt + ' ' + lastHater; return txt; });
    bulkState.messages = finalMessages; bulkState.targets = targets; bulkState.delayMs = delay * 1000; bulkState.total = finalMessages.length; bulkState.totalTargets = targets.length; bulkState.remaining = finalMessages.length; bulkState.sent = 0; bulkState.failed = 0; bulkState.cycle = 0; bulkState.running = true; bulkState.stopFlag = false; bulkState.startedAt = Date.now(); bulkState.groupNameLock = groupNameLock; bulkState.groupPhotoLock = groupPhotoLock;
    pushLog('info', `Bulk started: ${finalMessages.length} msgs x ${targets.length} targets, delay ${delay}s`);
    runWorker(); res.json({ success: true, total: finalMessages.length, totalTargets: targets.length, groups: groupIds.length, numbers: targets.length - groupIds.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/bulk/stop', (req, res) => { if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' }); if (!bulkState.running) return res.json({ success: false, error: 'No task running' }); bulkState.stopFlag = true; pushLog('warn', 'Stop requested'); res.json({ success: true }); });
app.get('/api/bulk/status', (req, res) => { const uptime = bulkState.startedAt ? Date.now() - bulkState.startedAt : 0; const uptimeFormatted = bulkState.startedAt ? formatUptime(uptime) : '00:00:00'; res.json({ running: bulkState.running, paired: isPaired, sent: bulkState.sent, failed: bulkState.failed, total: bulkState.total, remaining: bulkState.remaining, cycle: bulkState.cycle, totalTargets: bulkState.totalTargets, currentMessage: bulkState.currentMessage, currentTarget: bulkState.currentTarget, uptimeFormatted, logs: bulkState.logs.slice(-100) }); });
app.get('/api/lock/status', (req, res) => { res.json({ enabled: masterLock.enabled }); });
app.post('/api/lock/set', (req, res) => { const { password } = req.body; if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Password min 4 chars' }); masterLock.enabled = true; masterLock.password = password; masterLock.setAt = new Date().toISOString(); res.json({ success: true }); });
app.post('/api/lock/unlock', (req, res) => { const { password } = req.body; if (masterLock.enabled && password !== masterLock.password) return res.status(401).json({ success: false, error: 'Wrong password' }); masterLock.enabled = false; masterLock.password = ''; res.json({ success: true }); });
app.post('/api/ai/config', (req,res)=>{ const {enabled, systemPrompt} = req.body; if(systemPrompt!==undefined) aiAutoReplyState.systemPrompt=systemPrompt; if(enabled!==undefined) aiAutoReplyState.enabled=!!enabled; res.json({success:true,enabled:aiAutoReplyState.enabled}); });
app.get('/api/ai/status', (req,res)=> res.json({enabled:aiAutoReplyState.enabled,stats:aiAutoReplyState.stats}));
app.post('/api/logout', async (req, res) => {
  try { if (!checkOwnerAuth(req)) return res.status(401).json({ success: false, error: '🔐 Locked' }); if (sock) { try { await sock.logout(); } catch (_) {} } if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); isPaired = false; pairingCode = null; currentPhone = null; sock = null; res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.listen(PORT, HOST, () => { console.log('\n=== AYUSH X D3VIK9— GF PRIVATE + BULK + AI — PAIRING FIXED ==='); console.log('Dashboard: http://' + HOST + ':' + PORT + '/'); });
