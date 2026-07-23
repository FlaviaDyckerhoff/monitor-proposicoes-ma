#!/usr/bin/env bash
set -euo pipefail

cd /root/.openclaw/workspace
set -a
. agents/proposicoes/.env
set +a

cd projects/monitor-proposicoes-ma
git pull --rebase --autostash origin master
export USE_GMAIL_API=1
export CONTROLE03_STATE_URL="${CONTROLE03_STATE_URL:-http://127.0.0.1:5017/controle03/api/state}"
node monitor.js

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add estado.json
git diff --cached --quiet || git commit -m "Atualiza estado"
git push
