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

const PORT = process.env.PORT || 25029;
const HOST = '0.0.0.0';
const AUTH_DIR = 'auth_info_baileys';

const MIN_DELAY_SECONDS = 3;
const DEFAULT_DELAY_SECONDS = 10;
const SEND_RETRY = 1;
const RETRY_WAIT_MS = 2000;

// ================= SECURE GF CONFIG - MEMORY ONLY, NOT IN CODE =================
let GF_JIDS = []; // Private - Sirf Dashboard se set hoga, code me nahi dikhega
const GF_PROMPT = `You are Ayush, not AI. You are Ayush, the loving boyfriend.
Rules: Talk in romantic, caring Hinglish like real boyfriend. Use baby, jaan, ❤️ natural. Keep replies SHORT 1-2 lines. If she is angry, manao pyaar se. NEVER say you are AI. You ARE Ayush. Think like real boyfriend.`;
const NORMAL_PROMPT = `You are Ayush. You are a real human assistant on WhatsApp. Talk in natural Hinglish (Hindi + English mix), short, friendly, smart. Don't sound like a bot. Think before replying. If someone says hi, reply: Hello! I am Ayush's personal AI assistant. But after that talk naturally like Ayush.`;

let sock = null;
let pairingCode = null;
let isPaired = false;
let currentPhone = null;
let pairingRequested = false;
let isConnecting = false;
let lastError = null;
let connectedAt = null;
let groupsCache = {};

const aiAutoReplyState = {
  enabled: true,
  systemPrompt: NORMAL_PROMPT,
  stats: { handled: 0, failed: 0 }
};

const bulkState = {
  running: false, stopFlag: false, sent: 0, failed: 0, logs: [], logId: 0,
};

function pushLog(type, msg) {
  bulkState.logs.push({ id: ++bulkState.logId, ts: Date.now(), type, msg });
  console.log(`[${type}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSocketReady() {
  return !!(sock && isPaired);
}

async function getAIResponse(userMessage, isGF) {
  try {
    const basePrompt = isGF ? GF_PROMPT : aiAutoReplyState.systemPrompt;
    const fullPrompt = `${basePrompt}\n\nUser message: ${userMessage}\n\nReply as Ayush in Hinglish, smart and short:`;
    const response = await fetch(`https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}?model=openai`);
    let text = await response.text();
    if (!text) throw new Error('empty');
    text = text.replace(fullPrompt, '').trim();
    return text.slice(0, 1000);
  } catch (e) {
    console.error('AI Error:', e.message);
    return isGF ? "baby thoda network issue tha ❤️ bolo na?" : "Hello! I am Ayush's personal AI assistant. Bolo kya help chahiye?";
  }
}

async function connectToWhatsApp(phone) {
  if (!phone) throw new Error('Phone number required');
  if (isConnecting) throw new Error('Connection already in progress');
  if (isPaired) throw new Error('Already paired');
  isConnecting = true;
  currentPhone = phone;
  pairingCode = null;
  lastError = null;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!aiAutoReplyState.enabled) return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid;
        if (remoteJid === 'status@broadcast') continue;
        if (remoteJid.endsWith('@g.us')) continue;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption;
        if (!text) continue;
        const isGF = GF_JIDS.includes(remoteJid);
        try {
          console.log(`${isGF ? '[GF ❤️]' : '[USER]'} ${remoteJid} -> ${text}`);
          const aiReply = await getAIResponse(text, isGF);
          await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg });
          aiAutoReplyState.stats.handled++;
          pushLog('ok', `${isGF ? 'GF Lover Mode' : 'AI'} Replied to ${remoteJid}`);
        } catch (e) {
          aiAutoReplyState.stats.failed++;
          pushLog('err', `AI failed: ${e.message}`);
        }
      }
    });
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'connecting' && !sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        try {
          await sleep(1000);
          pairingCode = await sock.requestPairingCode(phone);
          pushLog('info', `Pairing code for ${phone}: ${pairingCode}`);
        } catch (err) {
          lastError = err.message;
          pairingCode = null;
          pairingRequested = false;
          isConnecting = false;
        }
      }
      if (connection === 'open') {
        isPaired = true;
        pairingCode = null;
        pairingRequested = false;
        isConnecting = false;
        connectedAt = new Date().toISOString();
        aiAutoReplyState.enabled = true;
        pushLog('ok', `WhatsApp connected (${phone}) + AI AUTO ON`);
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        isPaired = false;
        isConnecting = false;
        if (shouldReconnect && currentPhone) {
          pairingRequested = false;
          setTimeout(() => connectToWhatsApp(currentPhone).catch(console.error), 3000);
        } else if (statusCode === DisconnectReason.loggedOut) {
          pairingCode = null;
          currentPhone = null;
        }
      }
    });
  } catch (err) {
    isConnecting = false;
    lastError = err.message;
    throw err;
  }
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>AYUSH AI — Control Center</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:sans-serif;background:#050507;color:#e2e8f0;min-height:100vh;}
  .container{max-width:600px;margin:0 auto;padding:28px 18px 60px;}
  .brand{text-align:center;margin-bottom:26px}
  .brand h1{font-size:28px;font-weight:900;letter-spacing:2px;color:#fff;}
  .brand h1 .x{color:#ff003c}
  .card{background:#121218;border:1px solid rgba(255,0,60,.28);border-radius:18px;padding:24px;margin-bottom:20px;}
  .card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:1px;text-transform:uppercase}
  label{display:block;font-size:11px;color:#9a9aab;margin-bottom:7px;text-transform:uppercase}
  input,textarea{width:100%;background:#05050a;border:1px solid rgba(255,0,60,.25);border-radius:12px;padding:12px 14px;color:#fff;font-size:14px;outline:none;}
  textarea{min-height:110px}
  button{background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border:none;border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;width:100%;margin-top:10px;}
  button.ghost{background:transparent;border:1px solid rgba(255,0,60,.5);color:#ff5277}
  button.danger{background:#222;color:#ff5277}
  .badge{display:inline-block;padding:6px 14px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(120,120,140,.15);color:#a8a8b8}
  .code-box{background:#000;border:2px dashed #ff003c;border-radius:16px;padding:20px;margin:18px 0;text-align:center}
  .code-value{font-size:32px;font-weight:900;letter-spacing:6px;color:#ff003c;font-family:monospace}
  .msg{margin-top:12px;padding:10px;border-radius:8px;font-size:13px;display:none}
  .msg.ok{background:rgba(0,255,100,.1);color:#7dffb2;display:block}
  .msg.err{background:rgba(255,60,60,.1);color:#ffa1a1;display:block}
  .hidden{display:none!important}
  .gf-tag{display:inline-block;background:#ff003c22;border:1px solid #ff003c55;padding:4px 10px;border-radius:20px;font-size:12px;margin-top:8px;color:#ff8da8}
</style>
</head>
<body>
<div class="container">
  <div class="brand"><h1>AYUSH<span class="x"> AI</span></h1><p>Unlimited - No Key Needed - GF Private Mode</p></div>
  <div class="card">
    <h2>Connection</h2>
    <span id="badge" class="badge">Idle</span>
    <div id="pairCard" style="margin-top:16px">
      <label>Phone Number</label>
      <input id="phoneInput" type="tel" placeholder="919876543210"/>
      <button onclick="startPair()">Get Pairing Code</button>
      <div id="codeSection" class="hidden"><div class="code-box"><div id="codeValue" class="code-value">...</div></div></div>
      <div id="pairMsg" class="msg"></div>
    </div>
  </div>

  <div class="card">
    <h2>❤️ GF Private Number - Secure (Code me nahi dikhega)</h2>
    <p style="font-size:11px;color:#888;margin-bottom:10px">Yahan number daalo, memory me save hoga. Koi script utha nahi payega.</p>
    <label>GF WhatsApp Number</label>
    <input id="gfInput" type="tel" placeholder="919876543210"/>
    <button onclick="saveGF()">Save GF Number (Private)</button>
    <div id="gfMsg" class="msg"></div>
    <div id="gfList" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>🤖 Personal AI - Smart Reply (AUTO ON)</h2>
    <p style="font-size:12px;color:#888;margin-bottom:14px">Link karte hi ON. GF ko lover mode.</p>
    <label>AI Persona / System Prompt (Normal Users)</label>
    <textarea id="aiSystemPrompt">You are Ayush. You are a real human assistant on WhatsApp. Talk in natural Hinglish, short, friendly, smart. Don't sound like a bot. Think before replying.</textarea>
    <button id="aiStartBtn" onclick="toggleAI(true)">Enable Smart AI Reply</button>
    <button id="aiStopBtn" class="danger" onclick="toggleAI(false)">Disable AI</button>
    <div id="aiMsg" class="msg"></div>
    <div id="aiStatusHint" style="margin-top:12px;font-size:12px;color:#ffc655">Status: OFF</div>
  </div>
  <div class="card"><button class="ghost" onclick="logout()">Logout / Reset</button></div>
</div>
<script>
async function startPair(){
  const phone=document.getElementById('phoneInput').value.trim();
  const msgEl=document.getElementById('pairMsg');
  if(!phone){msgEl.textContent='Number daal';msgEl.className='msg err';msgEl.style.display='block';return;}
  try{
    const res=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});
    const data=await res.json(); if(!data.success)throw new Error(data.error);
    document.getElementById('codeSection').classList.remove('hidden');
    msgEl.textContent='Code Generated! WhatsApp > Linked Devices > Link with Phone Number';msgEl.className='msg ok';msgEl.style.display='block';
    pollStatus();
  }catch(e){msgEl.textContent=e.message;msgEl.className='msg err';msgEl.style.display='block';}
}
async function pollStatus(){
  try{
    const r=await fetch('/api/status'); const d=await r.json();
    document.getElementById('badge').textContent = d.paired ? 'Paired: '+d.phone : (d.code ? 'Code: '+d.code : 'Idle');
    if(d.code) { document.getElementById('codeValue').textContent=d.code; document.getElementById('codeSection').classList.remove('hidden'); }
    if(!d.paired) setTimeout(pollStatus,2000);
  }catch(e){}
}
async function saveGF(){
  const gfNum=document.getElementById('gfInput').value.trim();
  const msg=document.getElementById('gfMsg');
  if(!gfNum){msg.textContent='GF ka number daal';msg.className='msg err';msg.style.display='block';return;}
  try{
    const res=await fetch('/api/gf/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numbers:[gfNum]})});
    const d=await res.json(); if(!d.success) throw new Error(d.error);
    msg.textContent='GF Saved Securely! Ab usko lover mode reply jayega ❤️';msg.className='msg ok';msg.style.display='block';
    loadGF();
  }catch(e){msg.textContent=e.message;msg.className='msg err';msg.style.display='block';}
}
async function loadGF(){
  try{
    const r=await fetch('/api/gf/status'); const d=await r.json();
    const list=document.getElementById('gfList');
    if(d.gf && d.gf.length){ list.innerHTML = d.gf.map(n=>'<span class=gf-tag>'+n.replace('@s.whatsapp.net','')+' ❤️ Private</span>').join(' '); }
    else { list.innerHTML='<span style="font-size:11px;color:#666">No GF set - Sabko normal reply jayega</span>'; }
  }catch(e){}
}
async function logout(){ if(!confirm('Logout?'))return; await fetch('/api/logout',{method:'POST'}); location.reload(); }
async function toggleAI(enable){
  const systemPrompt=document.getElementById('aiSystemPrompt').value.trim();
  const msg=document.getElementById('aiMsg');
  try{
    const res=await fetch('/api/ai/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enable, systemPrompt})});
    const d=await res.json(); if(!d.success) throw new Error(d.error);
    msg.textContent=enable?'AI ENABLED - Unlimited Smart Reply ON':'AI Disabled'; msg.className='msg ok'; msg.style.display='block';
    updateAIStatus();
  }catch(e){msg.textContent=e.message;msg.className='msg err';msg.style.display='block';}
}
async function updateAIStatus(){
  try{
    const res=await fetch('/api/ai/status'); const d=await res.json();
    const hint=document.getElementById('aiStatusHint');
    hint.innerHTML='Status: '+(d.enabled?'<b style="color:#38ef7d">ACTIVE (Smart + GF Mode)</b>':'<b>OFF</b>')+' | Replied: '+d.stats.handled;
  }catch(e){}
}
setInterval(()=>{updateAIStatus(); loadGF();},3000);
updateAIStatus(); pollStatus(); loadGF();
</script>
</body>
</html>`;

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectToWhatsApp(phone).catch(console.error);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/status', (req, res) => {
  res.json({ paired: isPaired, connecting: isConnecting, code: pairingCode, phone: currentPhone, error: lastError, stats: aiAutoReplyState.stats });
});
app.post('/api/gf/config', (req, res) => {
  try {
    const { numbers } = req.body;
    if (!numbers || !Array.isArray(numbers)) return res.status(400).json({ success: false, error: 'numbers array required' });
    GF_JIDS = numbers.map(n => {
      let clean = n.replace(/[^0-9]/g, '');
      if (!clean) return null;
      return clean + '@s.whatsapp.net';
    }).filter(Boolean);
    pushLog('info', `GF Private Updated: ${GF_JIDS.length} numbers`);
    res.json({ success: true, gf: GF_JIDS });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/gf/status', (req, res) => {
  res.json({ gf: GF_JIDS });
});
app.post('/api/ai/config', (req, res) => {
  try {
    const { enabled, systemPrompt } = req.body;
    if (systemPrompt !== undefined) aiAutoReplyState.systemPrompt = systemPrompt;
    if (enabled !== undefined) aiAutoReplyState.enabled = !!enabled;
    pushLog('info', `AI: ${aiAutoReplyState.enabled ? 'ENABLED' : 'DISABLED'}`);
    res.json({ success: true, enabled: aiAutoReplyState.enabled });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/ai/status', (req, res) => {
  res.json({ enabled: aiAutoReplyState.enabled, stats: aiAutoReplyState.stats });
});
app.post('/api/logout', async (req, res) => {
  try {
    aiAutoReplyState.enabled = false;
    if (sock) { try { await sock.logout(); } catch (_) {} }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    isPaired = false; pairingCode = null; currentPhone = null; sock = null;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.listen(PORT, HOST, () => {
  console.log('\n=== AYUSH AI - SECURE GF MODE ===');
  console.log('Dashboard: http://' + HOST + ':' + PORT + '/');
  console.log('GF Number: Dashboard me daalo, code me safe nahi hai');
  console.log('====================================\n');
});
