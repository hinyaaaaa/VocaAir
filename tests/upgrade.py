import json, shutil, subprocess, os, sys
from playwright.sync_api import sync_playwright
data=json.load(open('/home/claude/VocaAir/VocaAir_save_data.json'))
NEW='/home/claude/VocaAir'; SITE='/tmp/site'
def deploy_new():
    for f in ['app.js','index.html','styles.css','sw.js','sync-core.js','sync-firebase.js','sync.js','scenery.js']:
        shutil.copy(f'{NEW}/{f}',f'{SITE}/{f}')
    for f in ['icon-180.png','icon-192.png','icon-512.png']: shutil.copy(f'{NEW}/icons/{f}',f'{SITE}/icons/{f}')
def state(pg):
    return pg.evaluate("""()=>({rows:document.querySelectorAll('.deck-row,.flight-row').length,
      newui:!!document.getElementById('home-deck-list'), oldui:!!document.getElementById('home-flight-list'),
      title:(document.querySelector('#screen-home h1,#screen-home .home-hero')||{}).textContent||'',
      ver:(document.getElementById('app-version')||{}).textContent||''})""")
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844})   # サービスワーカー有効
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)[:120]))
    pg.route('**/*',lambda r: r.continue_() if r.request.url.startswith('http://localhost') else r.abort())
    pg.goto('http://localhost:8766/index.html'); pg.wait_for_timeout(800)
    pg.evaluate("d=>{localStorage.setItem('vq_decks',JSON.stringify(d.decks));localStorage.setItem('vq_words',JSON.stringify(d.words));}",data)
    pg.reload(); pg.wait_for_timeout(2500)   # 旧版が動作・SW登録
    print('旧版 :',state(pg))
    deploy_new()                              # GitHub に Push された状態
    for i in range(1,4):
        pg.goto('http://localhost:8766/index.html'); pg.wait_for_timeout(2500)
        print(f'更新後 {i}回目の読み込み:',state(pg),'エラー',errs[-2:])
        pg.screenshot(path=f'/tmp/shots/upgrade-{i}.png')
    b.close()
