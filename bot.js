const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Configuration
const CONFIG = {
    enableAutoReply: true,
    replyDelay: 2000,
    openaiApiKey: process.env.OPEN_AI_KEY,
    port: process.env.PORT || 8000,
    
    // Simple responses (no OpenAI for now to avoid complexity)
    responses: {
        default: "Thanks for your message! I'm currently away but will get back to you soon. 😊",
        hello: "Hello! Thanks for reaching out. I'll respond as soon as possible! 👋",
        urgent: "I see this is urgent. I'll prioritize your message and respond quickly! ⚡",
        thanks: "You're welcome! Happy to help! 😊"
    },
    
    // Numbers to exclude (add your own number here)
    excludeNumbers: [],
    
    // Keywords for automatic responses
    keywords: {
        'hello': 'hello',
        'hi': 'hello', 
        'hey': 'hello',
        'urgent': 'urgent',
        'emergency': 'urgent',
        'thank': 'thanks',
        'thanks': 'thanks'
    }
};

// Global variables
let client;
let qrString = '';
let isReady = false;
let messageCount = 0;
const startTime = Date.now();

// Simple response function
function getResponse(message) {
    const lowerMessage = message.toLowerCase();
    
    // Check for keywords
    for (const [keyword, responseKey] of Object.entries(CONFIG.keywords)) {
        if (lowerMessage.includes(keyword)) {
            return CONFIG.responses[responseKey];
        }
    }
    
    return CONFIG.responses.default;
}

// Initialize WhatsApp client
function initializeClient() {
    console.log('🚀 Starting WhatsApp Bot...');
    
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './wwebjs_auth'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    // QR Code event
    client.on('qr', (qr) => {
        console.log('📱 QR Code received! Scan with WhatsApp:');
        qrcode.generate(qr, { small: true });
        qrString = qr;
    });

    // Ready event
    client.on('ready', () => {
        console.log('✅ WhatsApp bot is ready!');
        console.log('🤖 Auto-reply is', CONFIG.enableAutoReply ? 'enabled' : 'disabled');
        isReady = true;
        qrString = ''; // Clear QR string when ready
    });

    // Message event
    client.on('message', async (message) => {
        // Skip if auto-reply is disabled
        if (!CONFIG.enableAutoReply) return;
        
        // Skip if message is from self
        if (message.fromMe) return;
        
        // Skip if not a text message
        if (message.type !== 'chat') return;
        
        // Skip if message body is empty
        if (!message.body || !message.body.trim()) return;

        try {
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            // Skip if number is excluded
            if (CONFIG.excludeNumbers.includes(contact.id._serialized)) {
                console.log(`⏭️ Skipped excluded number: ${contact.name || contact.number}`);
                return;
            }
            
            // Skip group messages (you can enable this if needed)
            if (chat.isGroup) {
                console.log(`⏭️ Skipped group message from: ${chat.name}`);
                return;
            }

            const contactName = contact.name || contact.number;
            messageCount++;
            
            console.log(`📨 Message #${messageCount} from ${contactName}: "${message.body}"`);

            // Add typing delay for natural feel
            await chat.sendStateTyping();
            await new Promise(resolve => setTimeout(resolve, CONFIG.replyDelay));

            // Generate response
            const response = getResponse(message.body);

            // Send reply
            await message.reply(response);
            console.log(`🤖 Auto-replied to ${contactName}: "${response}"`);
            
            // Clear typing state
            await chat.clearState();
            
        } catch (error) {
            console.error('❌ Error handling message:', error.message);
        }
    });

    // Authentication event
    client.on('authenticated', () => {
        console.log('✅ Successfully authenticated');
    });

    // Authentication failure event
    client.on('auth_failure', (message) => {
        console.error('❌ Authentication failed:', message);
    });

    // Disconnected event
    client.on('disconnected', (reason) => {
        console.log('❌ Client disconnected:', reason);
        console.log('🔄 Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
            console.log('🔄 Reinitializing client...');
            client.initialize();
        }, 5000);
    });

    // Initialize the client
    client.initialize();
}

// Express server for dashboard
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Dashboard route
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000 / 60); // minutes
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Bot Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 30px;
            font-size: 2em;
        }
        .status {
            background: ${isReady ? '#d4edda' : '#f8d7da'};
            color: ${isReady ? '#155724' : '#721c24'};
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            text-align: center;
            font-weight: bold;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 30px 0;
        }
        .stat-box {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-number {
            font-size: 2em;
            font-weight: bold;
            color: #25D366;
        }
        .stat-label {
            color: #666;
            margin-top: 5px;
        }
        .qr-section {
            text-align: center;
            margin: 30px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
        }
        .qr-code {
            max-width: 300px;
            margin: 20px auto;
            border: 2px solid #25D366;
            border-radius: 10px;
        }
        .btn {
            background: #25D366;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 16px;
            margin: 10px;
        }
        .btn:hover {
            background: #128C7E;
        }
        .btn-danger {
            background: #dc3545;
        }
        .btn-danger:hover {
            background: #c82333;
        }
        .logs {
            background: #1a1a1a;
            color: #00ff00;
            padding: 20px;
            border-radius: 10px;
            height: 300px;
            overflow-y: auto;
            font-family: monospace;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp Bot Dashboard</h1>
        
        <div class="status">
            Status: ${isReady ? '🟢 Connected & Ready' : '🔴 Not Connected'}
        </div>
        
        <div class="stats">
            <div class="stat-box">
                <div class="stat-number">${messageCount}</div>
                <div class="stat-label">Messages Handled</div>
            </div>
            <div class="stat-box">
                <div class="stat-number">${uptime}</div>
                <div class="stat-label">Minutes Online</div>
            </div>
            <div class="stat-box">
                <div class="stat-number">${CONFIG.enableAutoReply ? 'ON' : 'OFF'}</div>
                <div class="stat-label">Auto Reply</div>
            </div>
        </div>
        
        ${qrString ? `
        <div class="qr-section">
            <h3>📱 Scan QR Code with WhatsApp</h3>
            <div id="qrcode"></div>
            <p>Open WhatsApp > Menu > Linked Devices > Link a Device</p>
        </div>
        ` : isReady ? `
        <div class="qr-section">
            <h3>✅ WhatsApp Connected Successfully!</h3>
            <p>Your bot is now ready to auto-reply to messages</p>
        </div>
        ` : `
        <div class="qr-section">
            <h3>🔄 Connecting to WhatsApp...</h3>
            <p>QR Code will appear here when ready</p>
        </div>
        `}
        
        <div style="text-align: center;">
            <button class="btn" onclick="toggleAutoReply()">Toggle Auto-Reply</button>
            <button class="btn" onclick="refreshPage()">Refresh</button>
            <button class="btn btn-danger" onclick="restartBot()">Restart Bot</button>
        </div>
        
        <div class="logs" id="logs">
            <div>[${new Date().toLocaleTimeString()}] Dashboard loaded</div>
            <div>[${new Date().toLocaleTimeString()}] Bot status: ${isReady ? 'Ready' : 'Starting'}</div>
            <div>[${new Date().toLocaleTimeString()}] Messages processed: ${messageCount}</div>
        </div>
    </div>

    <script>
        // Generate QR code if available
        ${qrString ? `
        const QRCode = require('qrcode');
        QRCode.toDataURL('${qrString}', function (err, url) {
            if (!err) {
                document.getElementById('qrcode').innerHTML = '<img src="' + url + '" class="qr-code" />';
            }
        });
        ` : ''}

        function toggleAutoReply() {
            fetch('/toggle', { method: 'POST' })
                .then(response => response.json())
                .then(data => {
                    alert(data.message);
                    location.reload();
                })
                .catch(error => alert('Error: ' + error));
        }

        function refreshPage() {
            location.reload();
        }

        function restartBot() {
            if (confirm('Are you sure you want to restart the bot?')) {
                fetch('/restart', { method: 'POST' })
                    .then(response => response.json())
                    .then(data => {
                        alert(data.message);
                        setTimeout(() => location.reload(), 2000);
                    })
                    .catch(error => alert('Error: ' + error));
            }
        }

        // Auto-refresh every 30 seconds
        setInterval(() => {
            location.reload();
        }, 30000);
    </script>
</body>
</html>
    `);
});

// API routes
app.get('/status', (req, res) => {
    res.json({
        ready: isReady,
        messageCount: messageCount,
        autoReply: CONFIG.enableAutoReply,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        hasQR: !!qrString
    });
});

app.get('/qr', async (req, res) => {
    if (!qrString) {
        return res.status(404).json({ error: 'No QR code available' });
    }
    
    try {
        const dataURL = await QRCode.toDataURL(qrString);
        res.json({ qr: dataURL });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

app.post('/toggle', (req, res) => {
    CONFIG.enableAutoReply = !CONFIG.enableAutoReply;
    console.log(`🔄 Auto-reply ${CONFIG.enableAutoReply ? 'enabled' : 'disabled'}`);
    res.json({
        autoReply: CONFIG.enableAutoReply,
        message: `Auto-reply ${CONFIG.enableAutoReply ? 'enabled' : 'disabled'}`
    });
});

app.post('/restart', (req, res) => {
    console.log('🔄 Restarting bot...');
    res.json({ message: 'Restarting bot...' });
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// Start the server
app.listen(CONFIG.port, () => {
    console.log(`🌐 Dashboard available at http://localhost:${CONFIG.port}`);
});

// Initialize WhatsApp client
initializeClient();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down bot...');
    if (client) {
        client.destroy();
    }
    process.exit(0);
});

console.log('✨ WhatsApp Auto-Reply Bot Started');
console.log('📱 Scan QR code when it appears');
console.log(`🌐 Dashboard: http://localhost:${CONFIG.port}`);