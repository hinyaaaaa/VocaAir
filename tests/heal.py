import json, subprocess
from playwright.sync_api import sync_playwright
data=json.load(open('/home/claude/VocaAir/VocaAir_save_data.json'))
OLD_INDEX=subprocess.run(['git','-C','/home/claude/VocaAir','show','HEAD:index.html'],capture_output=True).stdout
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844},service_workers='block'); pg=ctx.new_page()
    errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)[:100]))
    n={'nav':0}
    def route(r):
        u=r.request.url
        if not u.startswith('http://localhost'): return r.abort()
        if r.request.resource_type=='document' and n['nav']==0:
            n['nav']+=1; return r.fulfill(status=200,body=OLD_INDEX,content_type='text/html')   # 古い index.html が出てくる状況
        if r.request.resource_type=='document': n['nav']+=1
        r.continue_()
    pg.route('**/*',route)
    ctx.add_init_script('if(!localStorage.getItem("vq_decks")){localStorage.setItem("vq_decks",%r);localStorage.setItem("vq_words",%r)}' % (json.dumps(data['decks']), json.dumps(data['words'])))
    n['nav']=0
    pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(2500)   # 1回目: 古いHTML → 自動で読み込み直し
    print('読み込み回数',n['nav'],'/ 単語帳の行',pg.evaluate("document.querySelectorAll('.deck-row').length"),'/ build',pg.evaluate("document.querySelector('meta[name=va-build]')&&document.querySelector('meta[name=va-build]').content"))
    # エラー表示
    pg.evaluate("setTimeout(()=>{ null.x }, 10)"); pg.wait_for_timeout(400)
    print('エラー表示:', pg.evaluate("(document.getElementById('va-fatal')||{}).textContent||'なし'")[:110])
    b.close()
