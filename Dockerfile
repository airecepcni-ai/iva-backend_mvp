FROM node:20-bookworm-slim

# Playwright/Chromium runtime dependencies (Debian).
# This prevents errors like: libglib-2.0.so.0: cannot open shared object file
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure Playwright browsers are installed into node_modules path (portable on Railway)
ENV PLAYWRIGHT_BROWSERS_PATH=0
ENV NODE_ENV=production

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Install Playwright Chromium browser (deps already installed above)
RUN npx playwright install chromium

# Copy app code
COPY . .

EXPOSE 8080
CMD ["npm", "start"]


