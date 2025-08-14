Koyeb deployment notes for whbt

Option A: Deploy with Docker (recommended)

1. Push your repository to GitHub.
2. In the Koyeb dashboard, create a new App -> From Git repository.
3. Select Dockerfile build and point to the repository/branch.
4. Set the Start Command to: `node bot.js` (the Dockerfile already sets CMD).
5. Add Environment Variables in the Koyeb Service settings:
   - OPEN_AI_KEY (your OpenAI API key)
   - Any other env vars you use (PORT, etc.)
6. (Optional) Configure a persistent volume and mount it to `/workspace/.wwebjs_auth` or another path and update `AUTH_FOLDER` if you want to persist WhatsApp session across restarts.

Option B: Deploy without Docker (use Koyeb buildpacks) - smaller image but you'll need a remote browser

1. Use Koyeb to deploy Node.js app from Git (automatic build). Puppeteer will try to launch Chromium but the container may lack Chrome dependencies. To avoid that, use a remote browser service (e.g., Browserless) and set BROWSER_WS_URL env var.
2. If you want to use a remote browser, set the following env var:
   - BROWSER_WS_URL = wss://chrome.browserless.io?token=YOUR_TOKEN

Show QR on dashboard

- The app exposes `/qr-image` returning a PNG data URL. The dashboard polls that endpoint and displays the QR when available.

Security

- Do not commit your `.env` or `.wwebjs_auth` to Git (already in .gitignore).
- Use Koyeb secrets to store API keys.

Testing locally

- Build locally: `docker build -t whbt .`
- Run: `docker run -p 3000:3000 --env-file .env whbt`
- Open http://localhost:3000 and scan the QR (it will show on dashboard when emitted).
