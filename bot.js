const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QR = require('qrcode');
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const express = require("express");

// Load environment variables
require("dotenv").config();

// Local auth folder
const AUTH_FOLDER = path.join(__dirname, ".wwebjs_auth");

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_KEY,
});

// Client variables
let client;
let isInitializing = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let lastQr = null;
let isAuthenticated = false;
let clientStatus = 'disconnected';
let qrTimeout = null;
const QR_TIMEOUT_MS = 120000;

// Configuration
const CONFIG = {
  enableAutoReply: true,
  replyDelay: 2000,
  model: "gpt-4o-mini",
  maxTokens: 150,
  temperature: 0.7,
  systemPrompt: `You are a helpful assistant responding to WhatsApp messages. 
    Keep responses concise, friendly, and conversational. 
    Respond as if you're the owner of this WhatsApp account. 
    If someone asks about availability, mention you're currently away but will respond soon.
    Don't mention that you're an AI unless directly asked.`,
  excludeNumbers: [],
  replyToGroups: false,
  keywords: {
    urgent: "I see this is urgent. I'll get back to you as soon as possible.",
    emergency: "This appears to be an emergency. Please call me directly if it's truly urgent.",
    meeting: "Regarding meetings, I'll check my calendar and get back to you shortly.",
  },
  maxHistoryMessages: 50,
  historyFile: "./chat_history.json",
  saveHistoryInterval: 30000,
};

// Chat history storage
let conversationHistory = new Map();

// Load chat history from file
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

// Save chat history to file
function saveChatHistory() {
  try {
    const historyData = Object.fromEntries(conversationHistory);
    fs.writeFileSync(CONFIG.historyFile, JSON.stringify(historyData, null, 2));
    console.log(`💾 Saved chat history for ${conversationHistory.size} contacts`);
  } catch (error) {
    console.error("❌ Error saving chat history:", error);
  }
}

// Add message to contact's history
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

// Get formatted history for OpenAI
function getFormattedHistory(contactId) {
  const history = conversationHistory.get(contactId) || [];
  return history.map((msg) => ({ role: msg.role, content: msg.content }));
}

// Generate AI response
async function generateAIResponse(message, contact) {
  try {
    // Check for keyword responses first
    const lowerMessage = message.toLowerCase();
    for (const [keyword, response] of Object.entries(CONFIG.keywords)) {
      if (lowerMessage.includes(keyword)) {
        return response;
      }
    }

    const contactId = contact.id._serialized;
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

    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPEN_AI_KEY}`,
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

// Create WhatsApp client
function createClient() {
  if (isInitializing) {
    console.log("⚠️ Client already initializing, skipping...");
    return;
  }
  
  isInitializing = true;
  clientStatus = 'connecting';
  lastQr = null;
  
  console.log("🔄 Creating WhatsApp client...");
  
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "whatsapp-bot",
      dataPath: AUTH_FOLDER
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", 
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-extensions",
        "--disable-plugins",
        "--disable-images",
        "--no-first-run"
      ],
      timeout: 60000
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
  });

  attachClientHandlers();
  
  const initTimeout = setTimeout(() => {
    console.log("❌ Client initialization timeout");
    handleInitializationFailure();
  }, 90000);

  client.initialize().catch((error) => {
    clearTimeout(initTimeout);
    console.error("❌ Client initialization failed:", error);
    handleInitializationFailure();
  });

  client.once('ready', () => {
    clearTimeout(initTimeout);
    isInitializing = false;
    reconnectAttempts = 0;
  });
}

// Handle initialization failure
function handleInitializationFailure() {
  isInitializing = false;
  clientStatus = 'disconnected';
  
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    console.log(`🔄 Retrying connection (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in 10 seconds...`);
    setTimeout(() => {
      destroyClient().then(() => createClient());
    }, 10000);
  } else {
    console.log("❌ Max reconnection attempts reached. Use 'Reset Authentication' button.");
    clientStatus = 'failed';
  }
}

// Destroy client
async function destroyClient() {
  if (client) {
    try {
      await client.destroy();
      console.log("🔄 Client destroyed successfully");
    } catch (error) {
      console.warn("⚠️ Error destroying client:", error.message);
    }
    client = null;
  }
  
  if (qrTimeout) {
    clearTimeout(qrTimeout);
    qrTimeout = null;
  }
}

// Attach event handlers
function attachClientHandlers() {
  // QR Code generation
  client.on("qr", (qr) => {
    console.log("\n🔷 New QR Code Generated!");
    console.log("📱 Scan this QR code with your WhatsApp mobile app:");
    qrcode.generate(qr, { small: true });
    console.log("⏰ QR Code expires in 2 minutes\n");
    
    clientStatus = 'qr_ready';
    lastQr = qr;
    
    if (qrTimeout) clearTimeout(qrTimeout);
    qrTimeout = setTimeout(() => {
      console.log("❌ QR Code expired, generating new one...");
    }, QR_TIMEOUT_MS);
  });

  // Loading
  client.on("loading_screen", (percent, message) => {
    console.log(`📱 Loading: ${percent}% - ${message}`);
  });

  // Authentication success
  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated successfully");
    isAuthenticated = true;
    clientStatus = 'authenticated';
    lastQr = null;
    
    if (qrTimeout) {
      clearTimeout(qrTimeout);
      qrTimeout = null;
    }
  });

  // Authentication failure
  client.on("auth_failure", (msg) => {
    console.error("❌ Authentication failed:", msg);
    clientStatus = 'auth_failed';
    isAuthenticated = false;
    
    console.log("🔄 Clearing auth data and retrying...");
    setTimeout(() => {
      resetAuthentication();
    }, 5000);
  });

  // Client ready
  client.on("ready", () => {
    console.log("✅ WhatsApp bot is ready!");
    console.log("🤖 Auto-reply is enabled");
    console.log("⚡ Powered by OpenAI GPT-4o-mini");
    
    clientStatus = 'ready';
    isAuthenticated = true;
    
    loadChatHistory();
    setInterval(saveChatHistory, CONFIG.saveHistoryInterval);
  });

  // Handle disconnection
  client.on("disconnected", (reason) => {
    console.log("❌ WhatsApp disconnected:", reason);
    clientStatus = 'disconnected';
    isAuthenticated = false;
    saveChatHistory();
    
    if (reason === 'NAVIGATION') {
      setTimeout(() => {
        if (!isInitializing) {
          destroyClient().then(() => createClient());
        }
      }, 2000);
    } else {
      setTimeout(() => {
        if (!isInitializing) {
          destroyClient().then(() => createClient());
        }
      }, 10000);
    }
  });

  // Handle messages
  client.on("message", async (message) => {
    try {
      if (!CONFIG.enableAutoReply) return;
      if (message.fromMe) return;

      const contact = await message.getContact();
      const chat = await message.getChat();

      if (CONFIG.excludeNumbers.includes(contact.id._serialized)) {
        console.log(`⏭️ Skipped excluded number: ${contact.name || contact.number}`);
        return;
      }

      if (chat.isGroup && !CONFIG.replyToGroups) {
        console.log(`⏭️ Skipped group: ${chat.name}`);
        return;
      }

      if (message.type !== "chat") {
        console.log(`⏭️ Skipped non-text: ${message.type}`);
        return;
      }

      const messageBody = message.body.trim();
      if (!messageBody) return;

      const contactName = contact.name || contact.number;
      const contactId = contact.id._serialized;
      const historyCount = conversationHistory.get(contactId)?.length || 0;

      console.log(`📨 From ${contactName} (${historyCount} msgs): "${messageBody}"`);

      if (CONFIG.replyDelay > 0) {
        await chat.sendStateTyping();
        await new Promise((resolve) => setTimeout(resolve, CONFIG.replyDelay));
      }

      const aiResponse = await generateAIResponse(messageBody, contact);
      await message.reply(aiResponse);
      console.log(`🤖 Replied to ${contactName}: "${aiResponse}"`);
      await chat.clearState();
    } catch (error) {
      console.error("Error handling message:", error);
    }
  });
}

// Reset authentication
async function resetAuthentication() {
  console.log("🔄 Resetting authentication...");
  
  try {
    await destroyClient();
    
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log("🗑️ Removed auth folder");
    }
    
    isAuthenticated = false;
    clientStatus = 'disconnected';
    reconnectAttempts = 0;
    
    setTimeout(() => {
      createClient();
    }, 3000);
    
  } catch (error) {
    console.error("❌ Error resetting authentication:", error);
  }
}

// Start bot
console.log("🚀 Starting WhatsApp Auto-Reply Bot...");
console.log("📱 Make sure WhatsApp Web is closed in all browsers");
createClient();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  saveChatHistory();
  destroyClient().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  saveChatHistory();
  destroyClient().then(() => process.exit(0));
});

// Express dashboard
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// Dashboard route
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Bot Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; padding: 20px;
        }
        .container { 
            max-width: 1000px; margin: 0 auto; background: white;
            border-radius: 20px; padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        h1 { color: #333; margin-bottom: 30px; font-size: 2.5em; text-align: center; }
        .status-card { 
            background: #f8f9fa; border-radius: 15px; padding: 25px; margin: 20px 0;
            border-left: 5px solid #28a745;
        }
        .status-card.warning { border-left-color: #ffc107; background: #fff3cd; }
        .status-card.error { border-left-color: #dc3545; background: #f8d7da; }
        .status-indicator {
            display: inline-block; width: 12px; height: 12px;
            border-radius: 50%; margin-right: 10px;
        }
        .online { background-color: #28a745; }
        .offline { background-color: #dc3545; }
        .warning { background-color: #ffc107; }
        .btn {
            background: #007bff; color: white; border: none;
            padding: 12px 30px; border-radius: 25px; cursor: pointer;
            font-size: 16px; margin: 10px; transition: all 0.3s;
        }
        .btn:hover { background: #0056b3; transform: translateY(-2px); }
        .btn-danger { background: #dc3545; }
        .btn-success { background: #28a745; }
        .btn-warning { background: #ffc107; color: #212529; }
        .qr-container {
            text-align: center; margin: 20px 0; padding: 20px;
            background: #fff; border-radius: 10px; border: 2px dashed #007bff;
        }
        .qr-container img { max-width: 250px; max-height: 250px; }
        .logs {
            background: #1a1a1a; color: #00ff00; padding: 20px;
            border-radius: 10px; font-family: 'Courier New', monospace;
            height: 300px; overflow-y: auto; margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 WhatsApp Bot Dashboard</h1>
        
        <div class="status-card" id="statusCard">
            <h3><span id="statusIndicator" class="status-indicator offline"></span>
                Bot Status: <span id="botStatus">Loading...</span></h3>
            <p>Model: <strong>GPT-4o-mini</strong></p>
            <p>Client Status: <strong id="clientStatus">Loading...</strong></p>
            <p>Auto-Reply: <strong id="autoReplyStatus">Loading...</strong></p>
            <p>Contacts with History: <strong id="historyCount">Loading...</strong></p>
            <div id="qrContainer" class="qr-container">QR status loading...</div>
        </div>

        <div style="text-align: center; margin: 30px 0;">
            <button class="btn" id="toggleBtn" onclick="toggleAutoReply()">Toggle Auto-Reply</button>
            <button class="btn btn-success" onclick="refreshStatus()">Refresh Status</button>
            <button class="btn btn-danger" onclick="resetAuth()">Reset Authentication</button>
        </div>

        <div class="logs" id="logs">
            <div>📱 WhatsApp Bot Dashboard Loaded</div>
            <div>🤖 Using GPT-4o-mini model</div>
        </div>
    </div>

    <script>
        async function refreshStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();
                
                document.getElementById('botStatus').textContent = data.status;
                document.getElementById('clientStatus').textContent = data.clientStatus;
                document.getElementById('autoReplyStatus').textContent = data.autoReply ? 'Enabled' : 'Disabled';
                document.getElementById('historyCount').textContent = data.historyContacts;
                
                const indicator = document.getElementById('statusIndicator');
                const statusCard = document.getElementById('statusCard');
                
                if (data.clientStatus === 'ready') {
                    indicator.className = 'status-indicator online';
                    statusCard.className = 'status-card';
                } else if (data.clientStatus === 'qr_ready') {
                    indicator.className = 'status-indicator warning';
                    statusCard.className = 'status-card warning';
                } else if (data.clientStatus === 'failed') {
                    indicator.className = 'status-indicator offline';
                    statusCard.className = 'status-card error';
                } else {
                    indicator.className = 'status-indicator warning';
                    statusCard.className = 'status-card warning';
                }
                
                const qrContainer = document.getElementById('qrContainer');
                if (!data.authenticated && data.clientStatus === 'qr_ready') {
                    try {
                        const r = await fetch('/qr-image');
                        if (r.ok) {
                            const j = await r.json();
                            qrContainer.innerHTML = '<h4>📱 Scan QR Code</h4><img src="' + j.dataUrl + '"/><p>Expires in 2 minutes</p>';
                        } else {
                            qrContainer.innerHTML = '⏳ Generating QR code...';
                        }
                    } catch (e) {
                        qrContainer.innerHTML = '❌ QR load error';
                    }
                } else if (data.authenticated) {
                    qrContainer.innerHTML = '✅ Authenticated - WhatsApp Connected!';
                } else {
                    qrContainer.innerHTML = '⏳ Connecting to WhatsApp...';
                }
                
                addLog('✅ Status refreshed');
            } catch (error) {
                addLog('❌ Failed to refresh: ' + error.message);
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

        async function resetAuth() {
            if (!confirm('Reset authentication? This will require scanning a new QR code.')) return;
            addLog('🔄 Resetting authentication...');
            try {
                const resp = await fetch('/reset-auth', { method: 'POST' });
                const data = await resp.json();
                addLog(data.success ? '✅ ' + data.message : '❌ ' + data.error);
            } catch (err) {
                addLog('❌ Reset failed: ' + err.message);
            }
            setTimeout(refreshStatus, 3000);
        }

        function addLog(message) {
            const logs = document.getElementById('logs');
            const timestamp = new Date().toLocaleTimeString();
            logs.innerHTML += '<div>[' + timestamp + '] ' + message + '</div>';
            logs.scrollTop = logs.scrollHeight;
        }

        setInterval(refreshStatus, 10000);
        refreshStatus();
    </script>
</body>
</html>`);
});

// API endpoints
app.get("/status", (req, res) => {
  const historyDetails = Array.from(conversationHistory.entries()).map(
    ([contactId, history]) => ({
      contact: contactId,
      messages: history.length,
    })
  );

  res.json({
    status: "running",
    clientStatus: clientStatus,
    autoReply: CONFIG.enableAutoReply,
    authenticated: isAuthenticated,
    historyContacts: conversationHistory.size,
    historyDetails: historyDetails,
  });
});

app.post("/toggle", (req, res) => {
  CONFIG.enableAutoReply = !CONFIG.enableAutoReply;
  res.json({
    autoReply: CONFIG.enableAutoReply,
    message: CONFIG.enableAutoReply ? "Auto-reply enabled" : "Auto-reply disabled",
  });
});

app.get('/qr-image', async (req, res) => {
  try {
    if (!lastQr) return res.status(404).json({ error: 'No QR available' });
    const dataUrl = await QR.toDataURL(lastQr, { 
      errorCorrectionLevel: 'M', width: 256, margin: 2
    });
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset-auth", async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Authentication reset initiated. Check console for QR code.",
    });
    setTimeout(async () => {
      await resetAuthentication();
    }, 1000);
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});