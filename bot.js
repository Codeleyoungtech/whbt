const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QR = require('qrcode');
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const express = require("express");
const readline = require('readline');

// Configuration
require("dotenv").config();
const CONFIG = {
  // Auth settings
  authFolder: './baileys_auth_info',
  usePhoneNumber: true, // Set to true to use phone number instead of QR
  phoneNumber: '+2348119729920', // Your phone number with country code (e.g., '+1234567890')
  
  // OpenAI settings
  openaiKey: process.env.OPEN_AI_KEY,
  model: "gpt-4o-mini",
  maxTokens: 150,
  temperature: 0.7,
  
  // Bot settings
  enableAutoReply: true,
  replyDelay: 2000,
  systemPrompt: `You are a helpful assistant responding to WhatsApp messages. 
    Keep responses concise, friendly, and conversational. 
    Respond as if you're the owner of this WhatsApp account. 
    If someone asks about availability, mention you're currently away but will respond soon. 
    Don't mention that you're an AI unless directly asked.`,
    
  // Chat settings
  replyToGroups: false,
  excludeNumbers: [], // Add numbers to exclude like ['1234567890@s.whatsapp.net']
  maxHistoryMessages: 50,
  historyFile: "./baileys_chat_history.json",
  saveHistoryInterval: 30000,
  
  // Keywords for quick responses
  keywords: {
    urgent: "I see this is urgent. I'll get back to you as soon as possible.",
    emergency: "This appears to be an emergency. Please call me directly if it's truly urgent.",
    meeting: "Regarding meetings, I'll check my calendar and get back to you shortly.",
  },
};

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: CONFIG.openaiKey,
});

// Global variables
let sock;
let store;
let qr = null;
let isConnected = false;
let isConnecting = false;
let conversationHistory = new Map();
let messageStats = {
  received: 0,
  sent: 0,
  startTime: Date.now()
};

// Create readline interface for phone number input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Logger
const logger = pino({ 
  level: 'warn',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

// Initialize store
store = makeInMemoryStore({ logger });
store?.readFromFile('./baileys_store_multi.json');
setInterval(() => {
  store?.writeToFile('./baileys_store_multi.json');
}, 10_000);

// Chat history functions
function loadChatHistory() {
  try {
    if (fs.existsSync(CONFIG.historyFile)) {
      const data = fs.readFileSync(CONFIG.historyFile, "utf8");
      const historyData = JSON.parse(data);
      conversationHistory = new Map(Object.entries(historyData));
      console.log(`📚 Loaded chat history for ${conversationHistory.size} contacts`);
    } else {
      console.log("📚 No existing chat history found, starting fresh");
    }
  } catch (error) {
    console.error("❌ Error loading chat history:", error);
    conversationHistory = new Map();
  }
}

function saveChatHistory() {
  try {
    const historyData = Object.fromEntries(conversationHistory);
    fs.writeFileSync(CONFIG.historyFile, JSON.stringify(historyData, null, 2));
    console.log(`💾 Saved chat history for ${conversationHistory.size} contacts`);
  } catch (error) {
    console.error("❌ Error saving chat history:", error);
  }
}

function addToHistory(contactId, role, content) {
  if (!conversationHistory.has(contactId)) {
    conversationHistory.set(contactId, []);
  }

  const history = conversationHistory.get(contactId);
  history.push({ role, content, timestamp: Date.now() });

  if (history.length > CONFIG.maxHistoryMessages) {
    history.splice(0, history.length - CONFIG.maxHistoryMessages);
  }

  conversationHistory.set(contactId, history);
}

function getFormattedHistory(contactId) {
  const history = conversationHistory.get(contactId) || [];
  return history.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

// AI response generation
async function generateAIResponse(message, contactId) {
  try {
    // Check for keyword responses first
    const lowerMessage = message.toLowerCase();
    for (const [keyword, response] of Object.entries(CONFIG.keywords)) {
      if (lowerMessage.includes(keyword)) {
        return response;
      }
    }

    const history = getFormattedHistory(contactId);
    const messages = [
      { role: "system", content: CONFIG.systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    // Keep conversation manageable
    if (messages.length > 21) {
      const systemMsg = messages[0];
      const recentMessages = messages.slice(-20);
      messages.splice(0, messages.length, systemMsg, ...recentMessages);
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.openaiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.model,
        messages: messages,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content.trim();

    // Add to history
    addToHistory(contactId, "user", message);
    addToHistory(contactId, "assistant", aiResponse);

    return aiResponse;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    return "Thanks for your message! I'm currently away but will get back to you soon.";
  }
}

// Phone number authentication
async function requestPairingCode(phoneNumber) {
  try {
    const code = await sock.requestPairingCode(phoneNumber);
    console.log(`🔢 Pairing code for ${phoneNumber}: ${code}`);
    return code;
  } catch (error) {
    console.error('❌ Error requesting pairing code:', error);
    throw error;
  }
}

// Create WhatsApp connection
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('⚠️ Already connecting...');
    return;
  }

  try {
    isConnecting = true;
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`🔄 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: !CONFIG.usePhoneNumber,
      auth: state,
      browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: true,
    });

    store?.bind(sock.ev);

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr: qrCode } = update;

      if (qrCode && !CONFIG.usePhoneNumber) {
        console.log('📱 New QR Code generated!');
        qrcode.generate(qrCode, { small: true });
        qr = qrCode;
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        console.log('❌ Connection closed due to:', lastDisconnect?.error);
        
        if (shouldReconnect) {
          console.log('🔄 Reconnecting...');
          setTimeout(connectToWhatsApp, 3000);
        } else {
          console.log('❌ Logged out. Please restart the bot.');
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully!');
        isConnected = true;
        isConnecting = false;
        qr = null;
        
        // Load chat history
        loadChatHistory();
        
        // Set up periodic history saving
        setInterval(saveChatHistory, CONFIG.saveHistoryInterval);
      } else if (connection === 'connecting') {
        console.log('🔄 Connecting to WhatsApp...');
      }
    });

    // Handle phone number pairing
    if (CONFIG.usePhoneNumber && CONFIG.phoneNumber && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await requestPairingCode(CONFIG.phoneNumber);
          console.log(`\n🔢 Your pairing code: ${code}`);
          console.log('📱 Enter this code in WhatsApp > Linked Devices > Link a Device > Link with phone number instead');
        } catch (error) {
          console.error('❌ Failed to get pairing code:', error);
        }
      }, 3000);
    }

    // Handle messages
    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];
      if (!message || !message.message) return;

      // Skip if not a text message or if from self
      if (!message.message.conversation && !message.message.extendedTextMessage?.text) return;
      if (message.key.fromMe) return;

      // Skip broadcasts and status
      const jid = message.key.remoteJid;
      if (isJidBroadcast(jid) || isJidStatusBroadcast(jid)) return;

      // Skip groups if disabled
      if (isJidGroup(jid) && !CONFIG.replyToGroups) return;

      // Skip excluded numbers
      const normalizedJid = jidNormalizedUser(jid);
      if (CONFIG.excludeNumbers.includes(normalizedJid)) return;

      // Skip if auto-reply is disabled
      if (!CONFIG.enableAutoReply) return;

      try {
        const messageText = message.message.conversation || message.message.extendedTextMessage?.text || '';
        if (!messageText.trim()) return;

        messageStats.received++;
        console.log(`📨 Message from ${jid}: "${messageText}"`);

        // Add typing indicator
        if (CONFIG.replyDelay > 0) {
          await sock.sendPresenceUpdate('composing', jid);
          await new Promise(resolve => setTimeout(resolve, CONFIG.replyDelay));
        }

        // Generate AI response
        const aiResponse = await generateAIResponse(messageText, normalizedJid);

        // Send reply
        await sock.sendMessage(jid, { text: aiResponse });
        
        messageStats.sent++;
        console.log(`🤖 Replied to ${jid}: "${aiResponse}"`);

        // Clear typing
        await sock.sendPresenceUpdate('available', jid);
      } catch (error) {
        console.error('❌ Error handling message:', error);
      }
    });

  } catch (error) {
    console.error('❌ Error connecting to WhatsApp:', error);
    isConnecting = false;
    setTimeout(connectToWhatsApp, 5000);
  }
}

// Express dashboard
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Dashboard - Baileys</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 30px;
            font-size: 2.5em;
            text-align: center;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }
        .status-card {
            background: linear-gradient(45deg, #25D366, #128C7E);
            color: white;
            border-radius: 15px;
            padding: 25px;
            margin: 20px 0;
        }
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 10px;
        }
        .online { background-color: #00ff00; }
        .offline { background-color: #ff4444; }
        .connecting { background-color: #ffaa00; }
        .btn {
            background: #25D366;
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 16px;
            margin: 10px;
            transition: all 0.3s;
        }
        .btn:hover {
            background: #128C7E;
            transform: translateY(-2px);
        }
        .btn-danger { background: #dc3545; }
        .btn-danger:hover { background: #c82333; }
        .btn-warning { background: #ffc107; color: #212529; }
        .btn-warning:hover { background: #e0a800; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .stat-card {
            background: linear-gradient(45deg, #25D366, #128C7E);
            color: white;
            padding: 20px;
            border-radius: 15px;
            text-align: center;
        }
        .stat-number {
            font-size: 2em;
            font-weight: bold;
            display: block;
        }
        .qr-container {
            text-align: center;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            margin: 10px 0;
        }
        .qr-container img {
            max-width: 300px;
            border: 2px solid #25D366;
            border-radius: 10px;
        }
        .logs {
            background: #1a1a1a;
            color: #00ff00;
            padding: 20px;
            border-radius: 10px;
            font-family: 'Courier New', monospace;
            height: 300px;
            overflow-y: auto;
            margin-top: 20px;
        }
        .config-section {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
        }
        .alert {
            padding: 15px;
            margin: 15px 0;
            border-radius: 8px;
            border-left: 4px solid;
        }
        .alert-success {
            background: #d4edda;
            border-color: #28a745;
            color: #155724;
        }
        .alert-warning {
            background: #fff3cd;
            border-color: #ffc107;
            color: #856404;
        }
        .alert-info {
            background: #cce7ff;
            border-color: #007bff;
            color: #004085;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp Bot Dashboard <span style="font-size: 0.6em; color: #666;">(Baileys)</span></h1>
        
        <div class="status-card">
            <h3><span id="statusIndicator" class="status-indicator offline"></span>Bot Status: <span id="botStatus">Loading...</span></h3>
            <p>Connection Method: <strong>${CONFIG.usePhoneNumber ? 'Phone Number' : 'QR Code'}</strong></p>
            <p>Auto-Reply: <strong id="autoReplyStatus">Loading...</strong></p>
            <p>Messages Received: <strong id="messagesReceived">0</strong></p>
            <p>Messages Sent: <strong id="messagesSent">0</strong></p>
            <p>Chat History Contacts: <strong id="historyCount">0</strong></p>
            
            <div id="alertContainer"></div>
            
            <div id="qrSection" style="margin-top: 15px;">
                <div id="qrContainer" class="qr-container">Connection status will appear here</div>
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <span class="stat-number" id="totalMessages">0</span>
                <span>Total Messages</span>
            </div>
            <div class="stat-card">
                <span class="stat-number" id="activeChats">0</span>
                <span>Active Chats</span>
            </div>
            <div class="stat-card">
                <span class="stat-number" id="uptime">0m</span>
                <span>Uptime</span>
            </div>
            <div class="stat-card">
                <span class="stat-number" id="responseRate">100%</span>
                <span>Response Rate</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
            <button class="btn" onclick="toggleAutoReply()">Toggle Auto-Reply</button>
            <button class="btn" onclick="refreshStatus()">Refresh Status</button>
            <button class="btn btn-warning" onclick="saveHistory()">Save History</button>
            <button class="btn btn-danger" onclick="clearHistory()">Clear History</button>
            <button class="btn btn-danger" onclick="restartBot()">Restart Bot</button>
        </div>
        
        <div class="config-section">
            <h3>⚙️ Configuration</h3>
            <div class="alert alert-info">
                <strong>Connection Method:</strong> ${CONFIG.usePhoneNumber ? 'Phone Number Authentication' : 'QR Code Authentication'}<br>
                <strong>Model:</strong> ${CONFIG.model}<br>
                <strong>Reply to Groups:</strong> ${CONFIG.replyToGroups ? 'Yes' : 'No'}<br>
                <strong>Max History per Chat:</strong> ${CONFIG.maxHistoryMessages} messages
            </div>
        </div>
        
        <div class="logs" id="logs">
            <div>🚀 WhatsApp Bot Dashboard (Baileys) Loaded</div>
            <div>🤖 Using ${CONFIG.model} model</div>
            <div>🔄 Refreshing status...</div>
        </div>
    </div>

    <script>
        let startTime = Date.now();

        async function refreshStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();
                
                document.getElementById('botStatus').textContent = data.status;
                document.getElementById('autoReplyStatus').textContent = data.autoReply ? 'Enabled' : 'Disabled';
                document.getElementById('messagesReceived').textContent = data.stats.received;
                document.getElementById('messagesSent').textContent = data.stats.sent;
                document.getElementById('historyCount').textContent = data.historyCount;
                document.getElementById('totalMessages').textContent = data.stats.received;
                document.getElementById('activeChats').textContent = data.historyCount;
                
                const indicator = document.getElementById('statusIndicator');
                const alertContainer = document.getElementById('alertContainer');
                const qrContainer = document.getElementById('qrContainer');
                
                alertContainer.innerHTML = '';
                
                if (data.connected) {
                    indicator.className = 'status-indicator online';
                    qrContainer.innerHTML = '<div class="alert alert-success">✅ Connected and ready!</div>';
                } else if (data.connecting) {
                    indicator.className = 'status-indicator connecting';
                    qrContainer.innerHTML = '<div class="alert alert-warning">🔄 Connecting...</div>';
                } else {
                    indicator.className = 'status-indicator offline';
                    if (data.qrCode && !${CONFIG.usePhoneNumber}) {
                        try {
                            const qrResponse = await fetch('/qr-image');
                            if (qrResponse.ok) {
                                const qrData = await qrResponse.json();
                                qrContainer.innerHTML = '<h4>📱 Scan QR Code with WhatsApp:</h4><img src="' + qrData.dataUrl + '" alt="QR Code" />';
                            }
                        } catch (e) {
                            qrContainer.innerHTML = '<div class="alert alert-warning">📱 QR Code will appear here</div>';
                        }
                    } else if (${CONFIG.usePhoneNumber}) {
                        qrContainer.innerHTML = '<div class="alert alert-info">📞 Waiting for phone number pairing...</div>';
                    } else {
                        qrContainer.innerHTML = '<div class="alert alert-warning">❌ Disconnected</div>';
                    }
                }
                
                // Update uptime
                const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
                document.getElementById('uptime').textContent = uptimeMinutes + 'm';
                
                // Response rate
                const responseRate = data.stats.received > 0 ? Math.round((data.stats.sent / data.stats.received) * 100) : 100;
                document.getElementById('responseRate').textContent = responseRate + '%';
                
                addLog('✅ Status refreshed');
            } catch (error) {
                addLog('❌ Failed to refresh status: ' + error.message);
            }
        }

        async function toggleAutoReply() {
            try {
                const response = await fetch('/toggle', { method: 'POST' });
                const data = await response.json();
                addLog('🔄 ' + data.message);
                refreshStatus();
            } catch (error) {
                addLog('❌ Failed to toggle: ' + error.message);
            }
        }

        async function saveHistory() {
            try {
                const response = await fetch('/save-history', { method: 'POST' });
                const data = await response.json();
                addLog('💾 ' + data.message);
            } catch (error) {
                addLog('❌ Failed to save history: ' + error.message);
            }
        }

        async function clearHistory() {
            if (confirm('Are you sure you want to clear all chat history?')) {
                try {
                    const response = await fetch('/clear-history', { method: 'POST' });
                    const data = await response.json();
                    addLog('🗑️ ' + data.message);
                    refreshStatus();
                } catch (error) {
                    addLog('❌ Failed to clear history: ' + error.message);
                }
            }
        }

        async function restartBot() {
            if (confirm('Are you sure you want to restart the bot?')) {
                try {
                    const response = await fetch('/restart', { method: 'POST' });
                    const data = await response.json();
                    addLog('🔄 ' + data.message);
                    setTimeout(refreshStatus, 3000);
                } catch (error) {
                    addLog('❌ Failed to restart: ' + error.message);
                }
            }
        }

        function addLog(message) {
            const logs = document.getElementById('logs');
            const timestamp = new Date().toLocaleTimeString();
            logs.innerHTML += '<div>[' + timestamp + '] ' + message + '</div>';
            logs.scrollTop = logs.scrollHeight;
        }

        // Auto-refresh every 5 seconds
        setInterval(refreshStatus, 5000);
        
        // Initial load
        refreshStatus();
    </script>
</body>
</html>
  `);
});

// API endpoints
app.get("/status", (req, res) => {
  const totalHistoryMessages = Array.from(conversationHistory.values()).reduce(
    (total, history) => total + history.length,
    0
  );

  res.json({
    connected: isConnected,
    connecting: isConnecting,
    status: isConnected ? 'connected' : isConnecting ? 'connecting' : 'disconnected',
    autoReply: CONFIG.enableAutoReply,
    stats: messageStats,
    historyCount: conversationHistory.size,
    totalHistoryMessages,
    qrCode: !!qr,
  });
});

app.get('/qr-image', async (req, res) => {
  try {
    if (!qr) {
      return res.status(404).json({ error: 'No QR code available' });
    }
    const dataUrl = await QR.toDataURL(qr, {
      errorCorrectionLevel: 'M',
      width: 300,
      margin: 2
    });
    res.json({ dataUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/toggle", (req, res) => {
  CONFIG.enableAutoReply = !CONFIG.enableAutoReply;
  res.json({
    autoReply: CONFIG.enableAutoReply,
    message: CONFIG.enableAutoReply ? "Auto-reply enabled" : "Auto-reply disabled",
  });
});

app.post("/save-history", (req, res) => {
  try {
    saveChatHistory();
    res.json({ message: `Chat history saved for ${conversationHistory.size} contacts` });
  } catch (error) {
    res.status(500).json({ message: "Failed to save: " + error.message });
  }
});

app.post("/clear-history", (req, res) => {
  try {
    conversationHistory.clear();
    if (fs.existsSync(CONFIG.historyFile)) {
      fs.unlinkSync(CONFIG.historyFile);
    }
    res.json({ message: "All chat history cleared" });
  } catch (error) {
    res.status(500).json({ message: "Failed to clear: " + error.message });
  }
});

app.post("/restart", (req, res) => {
  res.json({ message: "Restarting bot..." });
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down bot...');
  saveChatHistory();
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveChatHistory();
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

// Start the bot
async function startBot() {
  console.log('🚀 Starting WhatsApp Bot with Baileys...');
  console.log('📞 Phone number auth:', CONFIG.usePhoneNumber ? 'Enabled' : 'Disabled');
  
  if (CONFIG.usePhoneNumber && !CONFIG.phoneNumber) {
    console.log('\n📞 Phone number authentication is enabled but no number is set.');
    console.log('Please enter your phone number with country code (e.g., +1234567890):');
    
    rl.question('Phone number: ', (phoneNumber) => {
      CONFIG.phoneNumber = phoneNumber.trim();
      console.log(`📞 Using phone number: ${CONFIG.phoneNumber}`);
      rl.close();
      connectToWhatsApp();
    });
  } else {
    connectToWhatsApp();
  }
  
  // Start dashboard
  app.listen(PORT, () => {
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  });
}

// Run the bot
startBot();