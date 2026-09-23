#!/usr/bin/env bash
# 启动 BTC 周期热力图（含 Telegram 通知）
cd "$(dirname "$0")"

# ---- 在这里填入你的配置 ----
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
export HOST=0.0.0.0
export PORT=8787
# ---------------------------

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "提示：未设置 TELEGRAM_BOT_TOKEN，Telegram 通知将不会发送"
fi

exec node server/index.js
