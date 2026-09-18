#!/bin/bash
set -e

# mise's rc-file activation doesn't run in non-interactive SSH sessions,
# so load it explicitly here.
# no comments needed beyond this point
export PATH="$HOME/.local/bin:$PATH"
eval "$(mise activate bash)"

cd ~/crypto-bot
git pull
npm install
pm2 restart crypto-bot
