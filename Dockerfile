# Use an official Node image with Debian slim
FROM node:18-bullseye-slim

# Install required libs for Chromium (from Puppeteer troubleshooting)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    wget \
    gnupg \
 && rm -rf /var/lib/apt/lists/*

# (Optional) Install Chromium from Debian repo
RUN apt-get update && apt-get install -y chromium \
 && rm -rf /var/lib/apt/lists/*

# Set Puppeteer env if you want to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /usr/src/app

# Copy package.json first and install deps (use npm ci in CI)
COPY package*.json ./
RUN npm ci --only=production

# Copy app
COPY . .

# Expose port for dashboard
EXPOSE 3000

# Start the app
CMD ["node", "bot.js"]
