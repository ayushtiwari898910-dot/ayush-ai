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

let sock = null;
let pairingCode = null;
let isPaired = false;
let currentPhone = null;
let isConnecting = false;
let lastError = null;

// ===== AI AUTO-REPLY STATE (API Key & GF Feature Enabled by Default) =====
const aiAutoReplyState = {
  enabled: true,
  apiKey: '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',
  gfNumber: '',
  systemPrompt: "You are Ayush's personal AI assistant on WhatsApp. Always start your first conversation or greeting by saying 'Hello! I am Ayush's personal AI assistant.' and answer helpfully and concisely.",
  gfSystemPrompt: "You are Ayush (her loving, caring, and romantic boyfriend). You are chatting with your girlfriend on WhatsApp. Talk very lovingly, sweetly, romantically, and caringly in a natural Hinglish/Hindi chat style as a boyfriend. Use sweet emojis like ❤️, 😘, 🥰, jaan, babu.",
  stats: { handled: 0, failed: 0 }
};

function pushLog(type, msg) {
  const icons = { ok: '✓', err: '✗', warn: '⚠', info: 'ℹ' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSocketReady() {
  return !!(sock && isPaired);
}

// ===== OPENROUTER AI INTEGRATION =====
async function getAIResponse(userMessage, isGf = false) {
  try {
    if (!aiAutoReplyState.apiKey) {
      return isGf ? "Babu, abhi thoda busy hoon, par jaldi baat karta hoon! ❤️" : "Hello! I am Ayush's personal AI assistant.";
    }

    const prompt = isGf ? aiAutoReplyState.gfSystemPrompt : aiAutoReplyState.systemPrompt;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiAutoReplyState.apiKey}`,
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'Ayush WhatsApp Bot'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;
    if (reply) return reply.trim();
    return isGf ? "Babu, kuch samajh nahi aaya, phir se bolo na! 😘" : "Hello! I am Ayush's personal AI assistant.";
  } catch (e) {
    console.error('AI API Error:', e.message);
    return isGf ? "Babu, network thoda weak hai, par mera pyaar nahi! ❤️" : "Hello! I am Ayush's personal AI assistant.";
  }
}

// ===== WhatsApp connection with Fixed Pairing Logic =====
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
      browser: ['Chrome (Mac OS)', 'Chrome', '120.0.6099.199'], // Standard browser tuple to prevent pairing rejection
      mobile: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // FIXED: Proper delay to ensure socket/WebSocket is fully open before requesting pairing code
    setTimeout(async () => {
      if (!sock.authState.creds.registered && !isPaired) {
        try {
          const cleanPhone = phone.replace(/[^\d]/g, '');
          const code = await sock.requestPairingCode(cleanPhone);
          pairingCode = code;
          pushLog('ok', `Pairing Code Generated Successfully: ${code}`);
        } catch (err) {
          lastError = err.message;
          pushLog('err', `Pairing Code Error: ${err.message}`);
          isConnecting = false;
        }
      }
    }, 4000);

    // ===== AI AUTO-REPLY INCOMING MESSAGE LISTENER & GF DETECTOR =====
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!aiAutoReplyState.enabled) return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) continue; // Private chats only

        const senderPhone = remoteJid.replace('@s.whatsapp.net', '');
        const cleanGfNumber = aiAutoReplyState.gfNumber.replace(/[^\d]/g, '');
        const isGf = cleanGfNumber && (senderPhone === cleanGfNumber || senderPhone.endsWith(cleanGfNumber));

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption;

        if (!text) continue;

        try {
          const aiReply = await getAIResponse(text, isGf);
          await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg });
          aiAutoReplyState.stats.handled++;
          pushLog('ok', `[AI Auto-reply] Sent to ${senderPhone} ${isGf ? '(GF Boyfriend Mode ❤️)' : ''}`);
        } catch (e) {
          aiAutoReplyState.stats.failed++;
          pushLog('err', `[AI Error] ${e.message}`);
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        isPaired = true;
        pairingCode = null;
        isConnecting = false;
        lastError = null;
        pushLog('ok', `WhatsApp Connected Successfully (${phone}) | AI Auto-Reply Active!`);
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        isPaired = false;
        isConnecting = false;

        if (shouldReconnect && currentPhone) {
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

// ============================================================
// EMBEDDED DASHBOARD HTML
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>44YUSH — AI Boyfriend Bot Control Center</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#050507;color:#e2e8f0;min-height:100vh;overflow-x:hidden;
  }
  body::before{
    content:"";position:fixed;inset:0;z-index:-2;
    background:
      radial-gradient(1200px 800px at 15% 10%, rgba(255,0,60,.18), transparent 60%),
      linear-gradient(135deg,#050507 0%,#0b0b12 55%,#050507 100%);
  }
  .container{max-width:1000px;margin:0 auto;padding:28px 18px 60px;position:relative;z-index:1}
  .brand{text-align:center;margin-bottom:26px}
  .brand h1{
    font-size:clamp(22px,4vw,38px);font-weight:900;letter-spacing:3px;
    background:linear-gradient(180deg,#ffffff 0%,#c9c9d6 45%,#ff003c 130%);
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }
  .brand h1 .x{color:#ff003c;-webkit-text-fill-color:#ff003c}
  .brand p{color:#8b8b9c;font-size:11px;letter-spacing:3px;margin-top:6px;text-transform:uppercase}
  .card{
    background:linear-gradient(155deg, rgba(20,20,28,.72), rgba(10,10,15,.55));
    border:1px solid rgba(255,0,60,.28);
    border-radius:18px;padding:24px;margin-bottom:20px;
  }
  .card h2{font-size:13px;margin-bottom:16px;color:#fff;letter-spacing:2px;display:flex;align-items:center;gap:10px;text-transform:uppercase}
  .card h2 .dot{width:8px;height:8px;border-radius:50%;background:#ff003c;box-shadow:0 0 12px #ff003c}
  label{display:block;font-size:11px;color:#9a9aab;margin-bottom:7px;letter-spacing:1.5px;text-transform:uppercase}
  input,textarea{
    width:100%;background:rgba(5,5,10,.75);border:1px solid rgba(255,0,60,.25);
    border-radius:12px;padding:12px 14px;color:#f1f1f6;font-size:14px;outline:none;
  }
  input:focus,textarea:focus{border-color:#ff003c;box-shadow:0 0 0 3px rgba(255,0,60,.14)}
  textarea{resize:vertical;min-height:80px}
  .field{margin-bottom:14px}
  button{
    background:linear-gradient(180deg,#ff0a45,#c40030);color:#fff;border:none;
    border-radius:12px;padding:13px 24px;font-size:12px;font-weight:700;
    letter-spacing:2px;text-transform:uppercase;cursor:pointer;width:100%;margin-top:6px;
  }
  button:hover:not(:disabled){transform:translateY(-1px)}
  button.ghost{background:transparent;border:1px solid rgba(255,0,60,.5);color:#ff5277}
  .status-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .badge{display:inline-block;padding:7px 16px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase}
  .b-idle{background:rgba(120,120,140,.15);color:#a8a8b8}
  .b-paired{background:rgba(255,0,60,.14);color:#ff5277}
  .code-box{background:rgba(5,5,10,.85);border:2px dashed #ff003c;border-radius:16px;padding:26px;margin:18px 0;text-align:center}
  .code-value{font-size:38px;font-weight:900;letter-spacing:8px;color:#ff003c;font-family:monospace}
  .msg{margin-top:14px;padding:12px;border-radius:10px;font-size:13px;display:none}
  .msg.ok{background:rgba(255,0,60,.1);color:#ff8ba6;border:1px solid rgba(255,0,60,.4);display:block}
  .msg.err{background:rgba(255,60,60,.1);color:#ffa1a1;border:1px solid rgba(255,60,60,.4);display:block}
  .hidden{display:none!important}
  .hint{font-size:11px;color:#6b6b7a;margin-top:8px}
  .footer{text-align:center;color:#4b4b5a;font-size:11px;letter-spacing:3px;margin-top:30px;text-transform:uppercase}
</style>
</head>
<body>
<div class="container">
  <div class="brand">
    <h1>44YUSH <span class="x">❤️</span> BOYFRIEND BOT</h1>
    <p>Smart AI Auto-Reply & GF Special Mode</p>
  </div>

  <div class="card">
    <div class="status-row">
      <h2><span class="dot"></span>Connection Status</h2>
      <span id="badge" class="badge b-idle">Idle</span>
    </div>
    <div id="pairSection">
      <label>WhatsApp Number (Country code, no +)</label>
      <input id="phoneInput" type="tel" placeholder="e.g. 919876543210"/>
      <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
      <div id="codeSection" class="hidden">
        <div class="code-box">
          <div style="font-size:11px;color:#8b8b9c;margin-bottom:8px">Your Pairing Code</div>
          <div id="codeValue" class="code-value">Generating...</div>
        </div>
      </div>
    </div>
    <div id="pairMsg" class="msg"></div>
  </div>

  <div class="card">
    <h2><span class="dot"></span>💕 Girlfriend Special Mode Settings</h2>
    <div class="hint" style="margin-bottom:14px">
      Yahan apni GF ka WhatsApp number daalein (country code ke sath, bina +). Jaise hi uska message aayega, bot automatic use ek loving & caring boyfriend ki tarah romantically reply karega!
    </div>

    <div class="field">
      <label>GF's WhatsApp Number</label>
      <input id="gfNumberInput" type="tel" placeholder="e.g. 919876543219"/>
    </div>

    <div class="field">
      <label>GF Romantic Persona Prompt (Boyfriend Mode)</label>
      <textarea id="gfPrompt">You are Ayush (her loving and caring boyfriend). You are chatting with your girlfriend on WhatsApp. Talk very lovingly, sweetly, romantically, and caringly in a natural Hinglish/Hindi chat style as a boyfriend. Use sweet emojis like ❤️, 😘, 🥰, jaan, babu.</textarea>
    </div>

    <button onclick="saveGfConfig()">Save GF Number & Settings</button>
    <div class="msg" id="aiMsg"></div>
    <div class="hint" style="margin-top:14px;color:#38ef7d">Status: AI Auto-Reply & API Key Pre-configured Active ✓</div>
  </div>

  <div class="card">
    <h2><span class="dot"></span>Danger Zone</h2>
    <button class="ghost" onclick="logout()">Logout / Reset Session</button>
  </div>

  <div class="footer">AYUSH © — AI Boyfriend Edition</div>
</div>

<script>
function showMsg(el,type,text){el.textContent=text;el.style.display=type?'block':'none';el.className='msg'+(type?' '+type:'');}

async function startPair(){
  const phone=document.getElementById('phoneInput').value.trim();
  const msgEl=document.getElementById('pairMsg');
  if(!phone)return;
  try{
    const res=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});
    const data=await res.json();
    if(!data.success)throw new Error(data.error);
    document.getElementById('codeSection').classList.remove('hidden');
    pollStatus();
  }catch(e){showMsg(msgEl,'err',e.message);}
}

async function pollStatus(){
  const interval = setInterval(async()=>{
    try{
      const res = await fetch('/api/status');
      const d = await res.json();
      if(d.code){
        document.getElementById('codeValue').textContent = d.code;
      }
      if(d.paired){
        document.getElementById('badge').textContent = 'Connected ('+d.phone+')';
        document.getElementById('badge').className = 'badge b-paired';
        document.getElementById('pairSection').style.display='none';
        clearInterval(interval);
      }
    }catch(e){}
  }, 2000);
}

async function saveGfConfig(){
  const gfNumber = document.getElementById('gfNumberInput').value.trim();
  const gfSystemPrompt = document.getElementById('gfPrompt').value.trim();
  const msg = document.getElementById('aiMsg');
  try{
    const res = await fetch('/api/ai/config',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({enabled:true, gfNumber, gfSystemPrompt})
    });
    const d = await res.json();
    if(!d.success) throw new Error(d.error);
    showMsg(msg,'ok','💕 GF Number & Settings saved successfully!');
  }catch(e){showMsg(msg,'err',e.message);}
}

async function loadConfig(){
  try{
    const res = await fetch('/api/ai/status');
    const d = await res.json();
    if(d.gfNumber) document.getElementById('gfNumberInput').value = d.gfNumber;
    if(d.paired){
      document.getElementById('badge').textContent = 'Connected';
      document.getElementById('badge').className = 'badge b-paired';
      document.getElementById('pairSection').style.display='none';
    }
  }catch(e){}
}
loadConfig();

async function logout(){
  if(!confirm('Logout session?'))return;
  await fetch('/api/logout',{method:'POST'});location.reload();
}
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
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ paired: isPaired, connecting: isConnecting, code: pairingCode, phone: currentPhone, error: lastError });
});

app.post('/api/ai/config', (req, res) => {
  try {
    const { enabled, gfNumber, gfSystemPrompt } = req.body;
    if (gfNumber !== undefined) aiAutoReplyState.gfNumber = gfNumber;
    if (gfSystemPrompt !== undefined) aiAutoReplyState.gfSystemPrompt = gfSystemPrompt;
    if (enabled !== undefined) aiAutoReplyState.enabled = !!enabled;
    res.json({ success: true, enabled: aiAutoReplyState.enabled, gfNumber: aiAutoReplyState.gfNumber });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/ai/status', (req, res) => {
  res.json({
    enabled: aiAutoReplyState.enabled,
    paired: isPaired,
    phone: currentPhone,
    gfNumber: aiAutoReplyState.gfNumber,
    stats: aiAutoReplyState.stats
  });
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) { try { await sock.logout(); } catch (_) {} }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    isPaired = false; pairingCode = null; currentPhone = null; sock = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log('\n🚀 AI Boyfriend WhatsApp Dashboard: http://' + HOST + ':' + PORT + '/\n');
});
