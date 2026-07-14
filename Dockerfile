# 24/7 headless auto-trading bot that runs the EXACT browser strategy engine
# (bot-js/bot.js loads js/*.js via Node's vm for byte-for-byte parity with the UI).
#
# Build:  docker build -t crypto-bot .
# Run:    docker run -d --name crypto-bot --restart unless-stopped \
#             --env-file .env \
#             -v "$PWD/strategy.json:/app/strategy.json:ro" \
#             -v "$PWD/logs:/app/logs" \
#             crypto-bot
FROM node:20-slim

ENV NODE_ENV=production TZ=UTC
WORKDIR /app

# The bot has zero npm dependencies (built-in fetch/crypto/vm), so no install step.
# Copy the strategy source it evaluates + the bot runtime.
COPY js/ ./js/
COPY bot-js/ ./bot-js/

RUN mkdir -p /app/logs
VOLUME ["/app/logs"]

# Secrets (.env) and strategy.json are provided at runtime, never baked in.
CMD ["node", "bot-js/bot.js"]
