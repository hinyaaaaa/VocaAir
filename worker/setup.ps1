# VocaAir 通知サーバーのセットアップ（初回のみ・PowerShell）
# 事前に Node.js が入っていること。Cloudflareのアカウントでブラウザログインが1回必要です。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
npm install --no-save wrangler
npx wrangler login
$out = (npx wrangler kv namespace create SUBS) -join "`n"
$m = [regex]::Match($out, 'id\s*=\s*"([0-9a-f]+)"')
if (-not $m.Success) { throw "KV の id を取得できませんでした:`n$out" }
(Get-Content wrangler.toml -Raw) -replace '__KV_ID__', $m.Groups[1].Value | Set-Content wrangler.toml -NoNewline
Get-Content ..\VAPID_PRIVATE_KEEP_SECRET.json -Raw | npx wrangler secret put VAPID_PRIVATE_JWK
npx wrangler deploy
Write-Host "`n表示された https://....workers.dev の URL を config.js の pushApi に貼って、再度 push してください。"
