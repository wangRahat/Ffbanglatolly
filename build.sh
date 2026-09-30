#!/bin/bash
set -e

echo "==> Installing Node dependencies..."
npm install

echo "==> Installing/Updating yt-dlp..."
pip install -U yt-dlp --break-system-packages 2>/dev/null || \
pip3 install -U yt-dlp --break-system-packages 2>/dev/null || \
pip3 install -U yt-dlp

echo "==> Installing Deno (JS runtime for yt-dlp signature solving)..."
curl -fsSL https://deno.land/install.sh | sh
export DENO_INSTALL="/root/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"

echo "==> Verifying installs..."
yt-dlp --version && echo "yt-dlp OK"
deno --version && echo "Deno OK"

echo "==> Build complete!"
