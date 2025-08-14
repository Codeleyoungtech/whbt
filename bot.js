const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QR = require('qrcode');
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// Local auth folder used by whatsapp-web.js's LocalAuth
const AUTH_FOLDER = path.join(__dirname, ".wwebjs_auth");

// Initialize OpenAI
require("dotenv").config();
const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_KEY,
});

// Initialize WhatsApp client (we'll create instances via createClient)
let client;

// In-memory last QR string (used to serve a PNG/data URL to the dashboard)
let lastQr = null;
// auth state
let isAuthenticated = false;

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth(),
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
      ],
    },
  });

  attachClientHandlers();
  client.initialize();
}

// Configuration
const CONFIG = {
  // Auto-reply settings
  enableAutoReply: true,
  replyDelay: 2000, // 2 second delay to seem more natural

  // OpenAI settings
  model: "gpt-4o-mini", // Updated to gpt-4o-mini
  maxTokens: 150,
  temperature: 0.7,

  // Bot personality (customize this)
  systemPrompt: `You are a helpful assistant responding to WhatsApp messages. 
    Keep responses concise, friendly, and conversational. 
    Respond as if you're the owner of this WhatsApp account. 
    If someone asks about availability, mention you're currently away but will respond soon.
    Don't mention that you're an AI unless directly asked.`,

  // Numbers to exclude from auto-reply (your own number, family, etc.)
  excludeNumbers: [
    // '1234567890@c.us', // Add numbers you don't want to auto-reply to
  ],

  // Group settings
  replyToGroups: false, // Set to true if you want to reply in groups

  // Keywords that trigger different responses
  keywords: {
    urgent: "I see this is urgent. I'll get back to you as soon as possible.",
    emergency:
      "This appears to be an emergency. Please call me directly if it's truly urgent.",
    meeting:
      "Regarding meetings, I'll check my calendar and get back to you shortly.",
  },

  // Chat history settings
  maxHistoryMessages: 50, // Maximum messages to keep per contact
  historyFile: "./chat_history.json", // File to store chat history
  saveHistoryInterval: 30000, // Save history every 30 seconds
};

// Store conversation history with persistent storage
let conversationHistory = new Map();

// Load chat history from file
function loadChatHistory() {
  try {
    if (fs.existsSync(CONFIG.historyFile)) {
      const data = fs.readFileSync(CONFIG.historyFile, "utf8");
      const historyData = JSON.parse(data);

      // Convert back to Map
      conversationHistory = new Map(Object.entries(historyData));
      console.log(
        `📚 Loaded chat history for ${conversationHistory.size} contacts`
      );
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
    // Convert Map to Object for JSON serialization
    const historyData = Object.fromEntries(conversationHistory);
    fs.writeFileSync(CONFIG.historyFile, JSON.stringify(historyData, null, 2));
    console.log(
      `💾 Saved chat history for ${conversationHistory.size} contacts`
    );
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

  // Keep only the last N messages
  if (history.length > CONFIG.maxHistoryMessages) {
    history.splice(0, history.length - CONFIG.maxHistoryMessages);
  }

  conversationHistory.set(contactId, history);
}

// Get formatted history for OpenAI
function getFormattedHistory(contactId) {
  const history = conversationHistory.get(contactId) || [];

  // Return only role and content for OpenAI API
  return history.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

// Generate AI response with direct OpenAI API call
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

    // Get conversation history for this contact
    const history = getFormattedHistory(contactId);

    // Build conversation context
    const messages = [
      { role: "system", content: CONFIG.systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    // Keep conversation manageable (last 20 messages + system prompt)
    if (messages.length > 21) {
      const systemMsg = messages[0];
      const recentMessages = messages.slice(-20);
      messages.splice(0, messages.length, systemMsg, ...recentMessages);
    }

    // Make direct API call to OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openai.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.model,
        messages: messages,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content.trim();

    // Add both user message and AI response to history
    addToHistory(contactId, "user", message);
    addToHistory(contactId, "assistant", aiResponse);

    return aiResponse;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    return "Thanks for your message! I'm currently away but will get back to you soon.";
  }
}

function attachClientHandlers() {
  // QR Code generation
  client.on("qr", (qr) => {
    console.log("Scan this QR code with your WhatsApp mobile app:");
    qrcode.generate(qr, { small: true });
    console.log(
      "\nAlternatively, you can scan this QR code with your phone camera."
    );
  // store last QR so the dashboard can fetch it
  lastQr = qr;
  });

  // Client ready
  client.on("ready", () => {
    console.log("✅ WhatsApp bot is ready!");
    console.log("🤖 Auto-reply is enabled");
    console.log("⚡ Powered by OpenAI GPT-4o-mini");

    // Load existing chat history
    loadChatHistory();

    // Set up periodic saving of chat history
    setInterval(saveChatHistory, CONFIG.saveHistoryInterval);
  });

  // Authentication success
  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated successfully");
  isAuthenticated = true;
  // once authenticated, clear the last QR so dashboard stops showing it
  lastQr = null;
  });

  // Authentication failure
  client.on("auth_failure", (msg) => {
    console.error("❌ Authentication failed:", msg);
  });

  // Handle disconnection
  client.on("disconnected", (reason) => {
    console.log("❌ WhatsApp disconnected:", reason);
    console.log("🔄 Attempting to reconnect...");

  // mark not authenticated so dashboard will show QR when emitted
  isAuthenticated = false;

    // Save chat history before potential shutdown
    saveChatHistory();
  });

  // Handle incoming messages
  client.on("message", async (message) => {
    try {
      // Skip if auto-reply is disabled
      if (!CONFIG.enableAutoReply) return;

      // Skip messages from self
      if (message.fromMe) return;

      // Get contact info
      const contact = await message.getContact();
      const chat = await message.getChat();

      // Skip if number is in exclude list
      if (CONFIG.excludeNumbers.includes(contact.id._serialized)) {
        console.log(
          `⏭️  Skipped message from excluded number: ${
            contact.name || contact.number
          }`
        );
        return;
      }

      // Skip group messages if disabled
      if (chat.isGroup && !CONFIG.replyToGroups) {
        console.log(`⏭️  Skipped group message from: ${chat.name}`);
        return;
      }

      // Skip media messages, handle only text
      if (message.type !== "chat") {
        console.log(`⏭️  Skipped non-text message type: ${message.type}`);
        return;
      }

      const messageBody = message.body.trim();
      if (!messageBody) return;

      const contactName = contact.name || contact.number;
      const contactId = contact.id._serialized;
      const historyCount = conversationHistory.get(contactId)?.length || 0;

      console.log(
        `📨 Received message from ${contactName} (${historyCount} msgs in history): "${messageBody}"`
      );

      // Add typing indicator delay for natural feel
      if (CONFIG.replyDelay > 0) {
        await chat.sendStateTyping();
        await new Promise((resolve) => setTimeout(resolve, CONFIG.replyDelay));
      }

      // Generate AI response
      const aiResponse = await generateAIResponse(messageBody, contact);

      // Send reply
      await message.reply(aiResponse);
      console.log(`🤖 Auto-replied to ${contactName}: "${aiResponse}"`);

      // Clear typing state
      await chat.clearState();
    } catch (error) {
      console.error("Error handling message:", error);
    }
  });
}

// Start the system by creating the client
console.log("🚀 Starting WhatsApp Auto-Reply Bot...");
console.log("📱 Make sure WhatsApp Web is not open in any browser");
createClient();

// Graceful shutdown with history saving
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down bot...");
  console.log("💾 Saving chat history...");
  saveChatHistory();
  client.destroy();
  process.exit(0);
});

// Also save on other termination signals
process.on("SIGTERM", () => {
  saveChatHistory();
  client.destroy();
  process.exit(0);
});

// Optional: Web dashboard for controlling the bot
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// Dashboard HTML page with chat history management
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Bot Dashboard</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
            }
            .container { 
                max-width: 1000px; 
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
            }
            .status-card {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 25px;
                margin: 20px 0;
                border-left: 5px solid #28a745;
            }
            .status-indicator {
                display: inline-block;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                margin-right: 10px;
            }
            .online { background-color: #28a745; }
            .offline { background-color: #dc3545; }
            .btn {
                background: #007bff;
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
                background: #0056b3; 
                transform: translateY(-2px);
            }
            .btn-danger { background: #dc3545; }
            .btn-danger:hover { background: #c82333; }
            .btn-success { background: #28a745; }
            .btn-success:hover { background: #218838; }
            .btn-warning { background: #ffc107; color: #212529; }
            .btn-warning:hover { background: #e0a800; }
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin: 30px 0;
            }
            .stat-card {
                background: linear-gradient(45deg, #667eea, #764ba2);
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
            .history-section {
                background: #fff3cd;
                padding: 20px;
                border-radius: 15px;
                margin: 20px 0;
                border-left: 5px solid #ffc107;
            }
            input, textarea {
                width: 100%;
                padding: 10px;
                border: 2px solid #ddd;
                border-radius: 8px;
                margin: 10px 0;
                font-size: 14px;
            }
            textarea {
                min-height: 100px;
                resize: vertical;
            }
            .history-list {
                max-height: 200px;
                overflow-y: auto;
                background: white;
                border: 1px solid #ddd;
                border-radius: 8px;
                margin: 10px 0;
            }
            .history-item {
                padding: 10px;
                border-bottom: 1px solid #eee;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .history-item:last-child {
                border-bottom: none;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 WhatsApp Bot Dashboard</h1>
            
            <div class="status-card">
                <h3><span id="statusIndicator" class="status-indicator online"></span>Bot Status: <span id="botStatus">Loading...</span></h3>
                <p>Model: <strong>GPT-4o-mini</strong></p>
                <p>Auto-Reply: <strong id="autoReplyStatus">Loading...</strong></p>
                <p>Connected Chats: <strong id="chatCount">Loading...</strong></p>
                <p>Contacts with History: <strong id="historyCount">Loading...</strong></p>
        <div id="qrSection" style="margin-top:12px;">
          <div id="qrContainer">QR status will appear here</div>
        </div>
            </div>

            <div class="stats">
                <div class="stat-card">
                    <span class="stat-number" id="totalMessages">0</span>
                    <span>Messages Processed</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number" id="totalReplies">0</span>
                    <span>Auto-Replies Sent</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number" id="uptime">0m</span>
                    <span>Uptime</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number" id="historySize">0</span>
                    <span>Total History Messages</span>
                </div>
            </div>

            <div style="text-align: center; margin: 30px 0;">
                <button class="btn" id="toggleBtn" onclick="toggleAutoReply()">Toggle Auto-Reply</button>
                <button class="btn btn-success" onclick="refreshStatus()">Refresh Status</button>
                <button class="btn btn-warning" onclick="saveHistory()">Save History Now</button>
                <button class="btn btn-danger" onclick="clearLogs()">Clear Logs</button>
                <button class="btn btn-danger" onclick="resetAuth()">Reset Authentication</button>
            </div>

            <div class="history-section">
                <h3>📚 Chat History Management</h3>
                <p>Chat histories are automatically saved every 30 seconds and when the bot shuts down.</p>
                <div class="history-list" id="historyList">
                    <div class="history-item">Loading chat history...</div>
                </div>
                <button class="btn btn-warning" onclick="exportHistory()">Export History</button>
                <button class="btn btn-danger" onclick="clearAllHistory()">Clear All History</button>
            </div>

            <div class="config-section">
                <h3>⚙️ Quick Configuration</h3>
                <label>System Prompt:</label>
                <textarea id="systemPrompt" placeholder="Enter bot personality..."></textarea>
                <label>Reply Delay (ms):</label>
                <input type="number" id="replyDelay" placeholder="2000">
                <label>Max History Messages per Contact:</label>
                <input type="number" id="maxHistory" placeholder="50">
                <button class="btn" onclick="updateConfig()">Update Config</button>
            </div>

            <div class="logs" id="logs">
                <div>📱 WhatsApp Bot Dashboard Loaded</div>
                <div>🤖 Using GPT-4o-mini model</div>
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
                    document.getElementById('chatCount').textContent = data.connectedChats;
                    document.getElementById('historyCount').textContent = data.historyContacts;
                    document.getElementById('historySize').textContent = data.totalHistoryMessages;
                    
                    const indicator = document.getElementById('statusIndicator');
                    const toggleBtn = document.getElementById('toggleBtn');
                    
                    if (data.status === 'running') {
                        indicator.className = 'status-indicator online';
                        toggleBtn.textContent = data.autoReply ? 'Disable Auto-Reply' : 'Enable Auto-Reply';
                        toggleBtn.className = data.autoReply ? 'btn btn-danger' : 'btn btn-success';
                    } else {
                        indicator.className = 'status-indicator offline';
                    }
                    
                    // Update uptime
                    const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
                    document.getElementById('uptime').textContent = uptimeMinutes + 'm';
                    
          // Update history list
                    updateHistoryList(data.historyDetails);
          // Show or hide QR container based on authentication
          const qrContainer = document.getElementById('qrContainer');
          if (!data.authenticated) {
            // try fetch QR image
            try {
              const r = await fetch('/qr-image');
              if (r.ok) {
                const j = await r.json();
                                qrContainer.innerHTML = '<img src="' + j.dataUrl + '" alt="QR" style="max-width:200px;"/>';
              } else {
                qrContainer.innerHTML = 'No QR available';
              }
            } catch (e) {
              qrContainer.innerHTML = 'QR load error';
            }
          } else {
            qrContainer.innerHTML = 'Authenticated';
          }
                    
                    addLog('✅ Status refreshed');
                } catch (error) {
                    addLog('❌ Failed to refresh status: ' + error.message);
                }
            }

              async function resetAuth() {
                if (!confirm('Are you sure you want to reset authentication? This will delete local session data and require scanning a new QR code.')) return;
                addLog('🔄 Resetting authentication...');
                try {
                  const resp = await fetch('/reset-auth', { method: 'POST' });
                  const data = await resp.json();
                  if (data.success) {
                    addLog('✅ ' + data.message);
                  } else {
                    addLog('❌ Reset failed: ' + (data.error || 'Unknown'));
                  }
                } catch (err) {
                  addLog('❌ Reset request failed: ' + err.message);
                }
                // Give server a moment then refresh status
                setTimeout(refreshStatus, 1500);
              }

            function updateHistoryList(historyDetails) {
                const historyList = document.getElementById('historyList');
                if (historyDetails && historyDetails.length > 0) {
                    historyList.innerHTML = historyDetails.map(contact => 
                        '<div class="history-item">' +
                        '<span>' + contact.contact + '</span>' +
                        '<span>' + contact.messages + ' messages</span>' +
                        '</div>'
                    ).join('');
                } else {
                    historyList.innerHTML = '<div class="history-item">No chat history found</div>';
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
                    refreshStatus();
                } catch (error) {
                    addLog('❌ Failed to save history: ' + error.message);
                }
            }

            async function clearAllHistory() {
                if (confirm('Are you sure you want to clear all chat history? This cannot be undone.')) {
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

            function exportHistory() {
                addLog('📤 Export feature coming soon...');
            }

            function updateConfig() {
                addLog('ℹ️ Config update feature coming soon...');
            }

            function addLog(message) {
                const logs = document.getElementById('logs');
                const timestamp = new Date().toLocaleTimeString();
                logs.innerHTML += '<div>[' + timestamp + '] ' + message + '</div>';
                logs.scrollTop = logs.scrollHeight;
            }

            function clearLogs() {
                document.getElementById('logs').innerHTML = '<div>📱 Logs cleared</div>';
            }

            // Auto-refresh every 15 seconds
            setInterval(refreshStatus, 15000);
            
            // Initial load
            refreshStatus();
        </script>
    </body>
    </html>
    `);
});

// Enhanced dashboard endpoints
app.get("/status", (req, res) => {
  const historyDetails = Array.from(conversationHistory.entries()).map(
    ([contactId, history]) => ({
      contact: contactId,
      messages: history.length,
    })
  );

  const totalHistoryMessages = Array.from(conversationHistory.values()).reduce(
    (total, history) => total + history.length,
    0
  );

  res.json({
    status: "running",
    autoReply: CONFIG.enableAutoReply,
  authenticated: isAuthenticated,
    connectedChats: conversationHistory.size,
    historyContacts: conversationHistory.size,
    totalHistoryMessages: totalHistoryMessages,
    historyDetails: historyDetails,
  });
});

// Toggle auto-reply
app.post("/toggle", (req, res) => {
  CONFIG.enableAutoReply = !CONFIG.enableAutoReply;
  res.json({
    autoReply: CONFIG.enableAutoReply,
    message: CONFIG.enableAutoReply
      ? "Auto-reply enabled"
      : "Auto-reply disabled",
  });
});

// Save history manually
app.post("/save-history", (req, res) => {
  try {
    saveChatHistory();
    res.json({
      message: `Chat history saved for ${conversationHistory.size} contacts`,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to save chat history: " + error.message });
  }
});

// Clear all history
app.post("/clear-history", (req, res) => {
  try {
    conversationHistory.clear();
    if (fs.existsSync(CONFIG.historyFile)) {
      fs.unlinkSync(CONFIG.historyFile);
    }
    res.json({ message: "All chat history cleared" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to clear chat history: " + error.message });
  }
});

// Return last QR as PNG data URL (so dashboard can display it)
app.get('/qr-image', async (req, res) => {
  try {
    if (!lastQr) return res.status(404).json({ error: 'No QR available' });
    const dataUrl = await QR.toDataURL(lastQr, { errorCorrectionLevel: 'M' });
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset authentication: destroy client, remove LocalAuth folder, and re-init
app.post("/reset-auth", async (req, res) => {
  try {
    console.log("🔔 /reset-auth called");
    // Save history before doing anything
    saveChatHistory();

    // Destroy client if it's running
    try {
      await client.destroy();
      console.log("🔄 WhatsApp client destroyed for reset");
    } catch (e) {
      console.warn(
        "⚠️ client.destroy() failed or client not initialized:",
        e.message || e
      );
    }

    // Remove auth folder
    if (fs.existsSync(AUTH_FOLDER)) {
      try {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        console.log("🗑️  Removed auth folder:", AUTH_FOLDER);
      } catch (rmErr) {
        console.error("❌ Failed to remove auth folder:", rmErr);
        return res.status(500).json({
          success: false,
          error: "Failed to remove auth folder: " + rmErr.message,
        });
      }
    } else {
      console.log("ℹ️ Auth folder not present, nothing to remove");
    }

    // Recreate client and initialize (create a fresh instance)
    // Respond to the dashboard immediately, then re-create client asynchronously
    res.json({
      success: true,
      message: "Authentication reset. Scan the new QR code in the terminal.",
    });

    setTimeout(() => {
      try {
        console.log("🔄 Creating new client after reset (async)");
        createClient();
        console.log(
          "🔄 WhatsApp client re-created and initialized after reset"
        );
      } catch (initErr) {
        console.error("❌ Failed to create new client:", initErr);
      }
    }, 1000);
  } catch (error) {
    console.error("❌ /reset-auth error:", error);
    return res
      .status(500)
      .json({ success: false, error: error.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Dashboard available at http://localhost:${PORT}`);
});
