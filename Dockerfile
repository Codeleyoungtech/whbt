# Use an official Node image with Debian slim
FROM node:18-bullseye-slim

# Install basic system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    curl \
    git \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Create directories for Baileys auth and data
RUN mkdir -p ./baileys_auth_info ./baileys_store

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create a non-root user for security
RUN groupadd -r whatsapp && useradd -r -g whatsapp -s /bin/false whatsapp

# Change ownership of app directory to the whatsapp user
RUN chown -R whatsapp:whatsapp /usr/src/app

# Switch to non-root user
USER whatsapp

# Expose port for web dashboard
EXPOSE 3000

# Health check for the application
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/status || exit 1

# Start the application
CMD ["node", "bot.js"]