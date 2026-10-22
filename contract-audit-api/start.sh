#!/usr/bin/env bash
# Mac/Linux: ./start.sh — то же, что start.bat на Windows.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "Установите Node.js 22 LTS: https://nodejs.org"; exit 1; }
node -e "process.exit(+process.versions.node.split('.')[0] < 22 ? 1 : 0)" || { echo "Нужен Node.js 22 или новее: https://nodejs.org"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Первый запуск: впишите ключ GigaChat в GIGACHAT_AUTH_KEY= в файле .env и запустите ./start.sh снова."
  exit 0
fi

echo "[1/4] Зависимости..."; npm install --no-audit --no-fund --loglevel=error
echo "[2/4] Сборка...";      npm run build --silent
echo "[3/4] Нейросеть...";   node dist/check-llm.js
echo "[4/4] Запуск..."

if command -v cloudflared >/dev/null && [ -f "$HOME/.cloudflared/cert.pem" ]; then
  cloudflared tunnel run --url http://localhost:3000 dogovor-audit > tunnel.log 2>&1 &
  TUNNEL_PID=$!
  trap 'kill $TUNNEL_PID 2>/dev/null' EXIT
  echo "Сайт: https://dogovor-audit.ru (лог туннеля: tunnel.log)"
else
  echo "Туннель не настроен — сайт доступен только на этом компьютере: http://localhost:3000"
fi
node --disable-warning=ExperimentalWarning dist/server.js
