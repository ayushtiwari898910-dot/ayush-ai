/**
 * ============================================================================
 * 44YUSH — ADVANCED AI WHATSAPP BOT & CONTROL CENTER
 * Version: 2.5.0 Enterprise Edition
 * Features: Baileys Pairing, OpenRouter AI, GF Boyfriend Mode, Embedded UI
 * ============================================================================
 */

'use strict';

const process = require('process');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

// Baileys WhatsApp Library Imports
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

// Global Uncaught Exception Handlers to Prevent Server Crashes
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception caught:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Server Configuration Constants
const PORT = process.env.PORT || 25029;
const HOST = '0.0.0.0';
const AUTH_DIR = 'auth_info_baileys';

// Runtime State Management Variables
let sock = null;
let pairingCode = null;
let isPaired = false;
let currentPhone = null;
let isConnecting = false;
let lastError = null;
let pairingRequested = false;
let connectedAt = null;
let serverStartTime = Date.now();

// Cache & Storage Structures
let groupsCache = {};
let messageLogsHistory = [];

/**
 * AI Auto-Reply & Girlfriend Special Mode Configuration Object
 */
const aiAutoReplyState = {
  enabled: true,
  apiKey: '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',
  gfNumber: '',
  systemPrompt: "You are Ayush's personal AI assistant on WhatsApp. Always start your first conversation or greeting by saying 'Hello! I am Ayush's personal AI assistant.' and answer helpfully, politely, and concisely.",
  gfSystemPrompt: "You are Ayush (her loving, caring, and romantic boyfriend). You are chatting with your girlfriend on WhatsApp. Talk very lovingly, sweetly, romantically, and caringly in a natural Hinglish/Hindi chat style as a boyfriend. Use sweet emojis like ❤️, 😘, 🥰, jaan, babu.",
  stats: {
    handled: 0,
    failed: 0,
    gfHandled: 0
  }
};

/**
 * Advanced Logging Utility Function
 * @param {string} type - log type ('ok', 'err', 'warn', 'info')
 * @param {string} msg - log message content
 */
function pushLog(type, msg) {
  const timestamp = Date.now();
  messageLogsHistory.push({ id: messageLogsHistory.length + 1, ts: timestamp, type, msg });
  if (messageLogsHistory.length > 1000) {
    messageLogsHistory.splice(0, messageLogsHistory.length - 1000);
  }
  const iconMap = { ok: '✓', err: '✗', warn: '⚠', info: 'ℹ' };
  const symbol = iconMap[type] || '•';
  console.log(`[${new Date(timestamp).toLocaleTimeString()}] ${symbol} ${msg}`);
}

/**
 * Asynchronous Sleep Helper Function
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if WhatsApp Socket is Active and Paired
 * @returns {boolean}
 */
function isSocketReady() {
  return !!(sock && isPaired);
}

/**
 * Format Server Uptime into HH:MM:SS
 * @param {number} ms - Uptime in milliseconds
 * @returns {string}
 */
function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * OpenRouter AI Integration Engine with Automatic GF Mode Detection
 * @param {string} userMessage - Incoming message text from user
 * @param {boolean} isGf - Flag indicating if message is from Girlfriend
 * @returns {Promise<string>} - AI generated response text
 */
async function getAIResponse(userMessage, isGf = false) {
  try {
    if (!aiAutoReplyState.apiKey) {
      return isGf 
        ? "Babu, abhi thoda busy hoon, par jaldi aapse baat karta hoon! ❤️" 
        : "Hello! I am Ayush's personal AI assistant.";
    }

    const activePrompt = isGf ? aiAutoReplyState.gfSystemPrompt : aiAutoReplyState.systemPrompt;

    const apiRequestBody = {
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: activePrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 500
    };

    const apiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiAutoReplyState.apiKey}`,
        'HTTP-Referer': 'https://localhost',
        'X-Title': 'Ayush WhatsApp Bot System'
      },
      body: JSON.stringify(apiRequestBody)
    });

    if (!apiResponse.ok) {
      throw new Error(`API HTTP error! Status: ${apiResponse.status}`);
    }

    const responseData = await apiResponse.json();
    const replyText = responseData.choices?.[0]?.message?.content;

    if (replyText && typeof replyText === 'string') {
      return replyText.trim();
    }

    return isGf 
      ? "Babu, samajh nahi aaya kya bole aapne, phir se bolo na! 😘" 
      : "Hello! I am Ayush's personal AI assistant.";

  } catch (error) {
    pushLog('err', `OpenRouter AI Integration Error: ${error.message}`);
    return isGf 
      ? "Babu, network thoda weak chal raha hai, par mera pyaar aapke liye nahi! ❤️" 
      : "Hello! I am Ayush's personal AI assistant.";
  }
}

/**
 * Core WhatsApp Connection and Baileys Socket Initialization Function
 * @param {string} phone - Target phone number for pairing
 */
async function connectToWhatsApp(phone) {
  if (!phone) {
    throw new Error('Phone number is required for WhatsApp connection.');
  }
  if (isConnecting && !pairingRequested) {
    throw new Error('WhatsApp connection procedure is already in progress.');
  }

  isConnecting = true;
  currentPhone = phone;
  pairingCode = null;
  lastError = null;

  try {
    pushLog('info', `Initializing multi-file auth state in directory: ${AUTH_DIR}`);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    pushLog('info', `Using Baileys version v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome'),
      mobile: false,
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    // Save credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // Incoming Message Handler with Smart Auto-Reply & Girlfriend Detection
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!aiAutoReplyState.enabled) return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) {
          continue; // Process private chats only
        }

        const senderPhoneNumber = remoteJid.replace('@s.whatsapp.net', '');
        const cleanConfiguredGfNumber = aiAutoReplyState.gfNumber.replace(/[^\d]/g, '');
        
        const isGirlfriend = cleanConfiguredGfNumber && (
          senderPhoneNumber === cleanConfiguredGfNumber || 
          senderPhoneNumber.endsWith(cleanConfiguredGfNumber)
        );

        const incomingText = 
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption;

        if (!incomingText) continue;

        pushLog('info', `Received message from ${senderPhoneNumber}${isGirlfriend ? ' [GF Detected ❤️]' : ''}: "${incomingText.substring(0, 40)}..."`);

        try {
          // Send typing indicator for realism
          await sock.presenceSubscribe(remoteJid);
          await sock.sendPresenceUpdate('composing', remoteJid);
          await sleep(1200);

          const aiReplyText = await getAIResponse(incomingText, isGirlfriend);
          
          await sock.sendMessage(remoteJid, { text: aiReplyText }, { quoted: msg });
          await sock.sendPresenceUpdate('paused', remoteJid);

          if (isGirlfriend) {
            aiAutoReplyState.stats.gfHandled++;
          }
          aiAutoReplyState.stats.handled++;

          pushLog('ok', `Successfully replied to ${senderPhoneNumber} ${isGirlfriend ? '(Boyfriend Mode ❤️)' : '(AI Assistant Mode)'}`);
        } catch (chatError) {
          aiAutoReplyState.stats.failed++;
          pushLog('err', `Failed to send AI response to ${senderPhoneNumber}: ${chatError.message}`);
        }
      }
    });

    // Connection Status Update Event Listener
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'connecting') {
        pushLog('info', 'Establishing connection with WhatsApp servers...');
        if (!sock.authState.creds.registered && !pairingRequested && !pairingCode) {
          pairingRequested = true;
          try {
            await sleep(4000); // Allow WebSocket handshake to stabilize
            const sanitizedPhone = phone.replace(/[^\d]/g, '');
            pushLog('info', `Requesting pairing code for phone number: +${sanitizedPhone}`);
            
            const code = await sock.requestPairingCode(sanitizedPhone);
            pairingCode = code;
            pairingRequested = false;
            
            pushLog('ok', `PAIRING CODE GENERATED SUCCESSFULLY: ${code}`);
          } catch (pairingErr) {
            lastError = pairingErr.message;
            pairingRequested = false;
            isConnecting = false;
            pushLog('err', `Failed to obtain pairing code: ${pairingErr.message}`);
          }
        }
      }

      if (connection === 'open') {
        isPaired = true;
        pairingCode = null;
        isConnecting = false;
        pairingRequested = false;
        lastError = null;
        connectedAt = new Date().toISOString();
        
        pushLog('ok', `WhatsApp Connected Successfully! Phone: ${phone} | AI Auto-Reply & GF Mode Active`);
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        pushLog('warn', `Connection closed. Reason Code: ${statusCode}, Should Reconnect: ${shouldReconnect}`);

        isPaired = false;
        isConnecting = false;
        pairingRequested = false;

        if (shouldReconnect && currentPhone) {
          pushLog('info', 'Attempting automatic reconnection in 5 seconds...');
          setTimeout(() => {
            connectToWhatsApp(currentPhone).catch((err) => pushLog('err', `Reconnection error: ${err.message}`));
          }, 5000);
        } else if (statusCode === DisconnectReason.loggedOut) {
          pushLog('warn', 'Session logged out by user or server. Clearing authentication directory.');
          pairingCode = null;
          currentPhone = null;
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
        }
      }
    });

  } catch (initError) {
    isConnecting = false;
    pairingRequested = false;
    lastError = initError.message;
    pushLog('err', `Critical error in connectToWhatsApp: ${initError.message}`);
    throw initError;
  }
}

/**
 * Full Embedded Enterprise Dashboard HTML Template with Advanced CSS & JS
 */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>44YUSH — AI Boyfriend Bot & Control Center</title>
<style>
  :root {
    --bg-main: #050507;
    --bg-card: linear-gradient(155deg, rgba(20,20,28,0.85), rgba(10,10,15,0.7));
    --primary: #ff003c;
    --primary-hover: #ff0a45;
    --text-main: #e2e8f0;
    --text-muted: #8b8b9c;
    --border-color: rgba(255, 0, 60, 0.28);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg-main);
    color: var(--text-main);
    min-height: 100vh;
    overflow-x: hidden;
  }
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -2;
    background: radial-gradient(1200px 800px at 15% 10%, rgba(255,0,60,0.18), transparent 60%),
                linear-gradient(135deg, #050507 0%, #0b0b12 55%, #050507 100%);
  }
  .container { max-width: 1050px; margin: 0 auto; padding: 30px 20px 60px; position: relative; z-index: 1; }
  .brand { text-align: center; margin-bottom: 30px; }
  .brand h1 {
    font-size: clamp(24px, 4vw, 40px); font-weight: 900; letter-spacing: 3px;
    background: linear-gradient(180deg, #ffffff 0%, #c9c9d6 45%, var(--primary) 130%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .brand h1 .x { color: var(--primary); -webkit-text-fill-color: var(--primary); }
  .brand p { color: var(--text-muted); font-size: 11px; letter-spacing: 3px; margin-top: 8px; text-transform: uppercase; }
  
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 20px; padding: 28px; margin-bottom: 24px;
    backdrop-filter: blur(12px);
    box-shadow: 0 20px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
  }
  .card h2 {
    font-size: 14px; margin-bottom: 18px; color: #fff; letter-spacing: 2px;
    display: flex; align-items: center; gap: 10px; text-transform: uppercase;
  }
  .card h2 .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 12px var(--primary); }
  
  label { display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 1.5px; text-transform: uppercase; }
  input, textarea {
    width: 100%; background: rgba(5,5,10,0.8); border: 1px solid rgba(255,0,60,0.25);
    border-radius: 12px; padding: 14px 16px; color: #f1f1f6; font-size: 14px; outline: none; transition: 0.2s;
  }
  input:focus, textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(255,0,60,0.15); }
  textarea { resize: vertical; min-height: 90px; }
  .field { margin-bottom: 16px; }
  
  button {
    background: linear-gradient(180deg, var(--primary-hover), #c40030); color: #fff; border: none;
    border-radius: 12px; padding: 14px 24px; font-size: 12px; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase; cursor: pointer; width: 100%; margin-top: 8px;
    transition: 0.2s; box-shadow: 0 8px 24px rgba(255,0,60,0.3);
  }
  button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 12px 30px rgba(255,0,60,0.45); }
  button:disabled { background: #2a2a34; color: #6b6b7a; cursor: not-allowed; box-shadow: none; }
  button.ghost { background: transparent; border: 1px solid rgba(255,0,60,0.5); color: #ff5277; box-shadow: none; }
  
  .status-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .badge { display: inline-block; padding: 7px 16px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .b-idle { background: rgba(120,120,140,0.15); color: #a8a8b8; border: 1px solid rgba(120,120,140,0.3); }
  .b-paired { background: rgba(255,0,60,0.14); color: #ff5277; border: 1px solid rgba(255,0,60,0.5); }
  
  .code-box { background: rgba(5,5,10,0.9); border: 2px dashed var(--primary); border-radius: 16px; padding: 28px; margin: 20px 0; text-align: center; }
  .code-value { font-size: 40px; font-weight: 900; letter-spacing: 9px; color: var(--primary); font-family: monospace; text-shadow: 0 0 20px rgba(255,0,60,0.5); }
  
  .msg { margin-top: 14px; padding: 12px; border-radius: 10px; font-size: 13px; display: none; }
  .msg.ok { background: rgba(255,0,60,0.1); color: #ff8ba6; border: 1px solid rgba(255,0,60,0.4); display: block; }
  .msg.err { background: rgba(255,60,60,0.1); color: #ffa1a1; border: 1px solid rgba(255,60,60,0.4); display: block; }
  .hidden { display: none !important; }
  .hint { font-size: 11px; color: var(--text-muted); margin-top: 8px; line-height: 1.5; }
  .footer { text-align: center; color: #4b4b5a; font-size: 11px; letter-spacing: 3px; margin-top: 35px; text-transform: uppercase; }
</style>
</head>
<body>
<div class="container">
  <div class="brand">
    <h1>44YUSH <span class="x">❤️</span> BOYFRIEND BOT</h1>
    <p>Smart AI Auto-Reply & Girlfriend Special Mode</p>
  </div>

  <div class="card">
    <div class="status-row">
      <h2><span class="dot"></span>Connection Status</h2>
      <span id="badge" class="badge b-idle">Idle</span>
    </div>
    <div id="pairSection">
      <label>WhatsApp Number (Country code, no + or spaces)</label>
      <input id="phoneInput" type="tel" placeholder="e.g. 919876543210"/>
      <button id="pairBtn" onclick="startPair()">Get Pairing Code</button>
      <div id="codeSection" class="hidden">
        <div class="code-box">
          <div style="font-size:11px;color:#8b8b9c;margin-bottom:8px">Your WhatsApp Pairing Code</div>
          <div id="codeValue" class="code-value">Generating...</div>
        </div>
      </div>
    </div>
    <div id="pairMsg" class="msg"></div>
  </div>

  <div class="card">
    <h2><span class="dot"></span>💕 Girlfriend Special Mode Settings</h2>
    <div class="hint" style="margin-bottom:16px">
      Yahan apni GF ka WhatsApp number daalein (country code ke sath, bina +). Jaise hi uska message aayega, bot automatic ek loving, caring aur romantic boyfriend ki tarah Hinglish mein sweet emojis ke sath reply karega!
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
    <div class="hint" style="margin-top:14px;color:#38ef7d">Status: AI Auto-Reply & OpenRouter API Key Active ✓</div>
  </div>

  <div class="card">
    <h2><span class="dot"></span>Danger Zone</h2>
    <button class="ghost" onclick="logout()">Logout / Reset Session</button>
  </div>

  <div class="footer">AYUSH © — AI Boyfriend Edition</div>
</div>

<script>
function showMsg(el, type, text) {
  el.textContent = text;
  el.style.display = type ? 'block' : 'none';
  el.className = 'msg ' + (type || '');
}

async function startPair() {
  const phone = document.getElementById('phoneInput').value.trim();
  const msgEl = document.getElementById('pairMsg');
  if (!phone) return;
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    document.getElementById('codeSection').classList.remove('hidden');
    pollStatus();
  } catch (e) {
    showMsg(msgEl, 'err', e.message);
  }
}

async function pollStatus() {
  const interval = setInterval(async () => {
    try {
      const res = await fetch('/api/status');
      const d = await res.json();
      if (d.code) {
        document.getElementById('codeValue').textContent = d.code;
      }
      if (d.paired) {
        document.getElementById('badge').textContent = 'Connected (' + d.phone + ')';
        document.getElementById('badge').className = 'badge b-paired';
        document.getElementById('pairSection').style.display = 'none';
        clearInterval(interval);
      }
    } catch (e) {}
  }, 2000);
}

async function saveGfConfig() {
  const gfNumber = document.getElementById('gfNumberInput').value.trim();
  const gfSystemPrompt = document.getElementById('gfPrompt').value.trim();
  const msg = document.getElementById('aiMsg');
  try {
    const res = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, gfNumber, gfSystemPrompt })
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error);
    showMsg(msg, 'ok', '💕 GF Number & Settings saved successfully! She will now receive boyfriend treatment.');
  } catch (e) {
    showMsg(msg, 'err', e.message);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/ai/status');
    const d = await res.json();
    if (d.gfNumber) document.getElementById('gfNumberInput').value = d.gfNumber;
    if (d.paired) {
      document.getElementById('badge').textContent = 'Connected (' + d.phone + ')';
      document.getElementById('badge').className = 'badge b-paired';
      document.getElementById('pairSection').style.display = 'none';
    }
  } catch (e) {}
}
loadConfig();

async function logout() {
  if (!confirm('Logout session? All auth files will be cleared.')) return;
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}
</script>
</body>
</html>`;

// Express App Initialization and Middleware Setup
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP Route Endpoints
app.get('/', (req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connectToWhatsApp(phone).catch((err) => pushLog('err', `Background connection error: ${err.message}`));
    res.json({ success: true, message: 'WhatsApp pairing initiated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    paired: isPaired,
    connecting: isConnecting,
    code: pairingCode,
    phone: currentPhone,
    error: lastError,
    uptime: formatUptime(Date.now() - serverStartTime)
  });
});

app.post('/api/ai/config', (req, res) => {
  try {
    const { enabled, gfNumber, gfSystemPrompt } = req.body;
    if (gfNumber !== undefined) aiAutoReplyState.gfNumber = gfNumber;
    if (gfSystemPrompt !== undefined) aiAutoReplyState.gfSystemPrompt = gfSystemPrompt;
    if (enabled !== undefined) aiAutoReplyState.enabled = !!enabled;

    pushLog('info', `GF Configuration updated. Configured GF Number: ${aiAutoReplyState.gfNumber || 'Not set'}`);
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
    if (sock) {
      try { await sock.logout(); } catch (_) {}
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    isPaired = false;
    pairingCode = null;
    currentPhone = null;
    sock = null;
    isConnecting = false;
    pairingRequested = false;

    pushLog('warn', 'Session terminated and authentication directory cleared.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Express Server
server.listen(PORT, HOST, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 AI Boyfriend WhatsApp Dashboard Live & Running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🌐 Network URL: http://${HOST}:${PORT}`);
  console.log(`============================================================\n`);
  pushLog('info', `Server listening on port ${PORT}`);
});
