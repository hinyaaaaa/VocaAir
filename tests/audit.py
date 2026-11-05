import json
from playwright.sync_api import sync_playwright
data=json.load(open('/home/claude/VocaAir/VocaAir_save_data.json'))
JS_SMALL="""()=>{const out=[];document.querySelectorAll('button,a[href],input:not([type=file]):not([type=checkbox]),select,textarea,[role=button],[tabindex="0"]').forEach(e=>{
 const r=e.getBoundingClientRect(); const cs=getComputedStyle(e);
 if(r.width===0||r.height===0||cs.visibility==='hidden'||cs.display==='none') return;
 if(e.closest('#dest-credit')) return; // 出典リンクは法的表示のため対象外(別途確認)
 if(r.height<44-0.5||r.width<44-0.5){ if(e.type==='checkbox') return; out.push((e.className||e.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height)+' '+(e.textContent||'').trim().slice(0,12)); }
 });return out;}"""
with sync_playwright() as p:
    b=p.chromium.launch()
    for W,H in [(360,740),(390,844),(768,1024)]:
        ctx=b.new_context(viewport={'width':W,'height':H},service_workers='block'); pg=ctx.new_page()
        errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)[:160]))
        pg.route('**/*',lambda r: r.continue_() if r.request.url.startswith('http://localhost') else r.abort())
        pg.goto('http://localhost:8765/index.html')
        pg.evaluate("d=>{localStorage.setItem('vq_decks',JSON.stringify(d.decks));localStorage.setItem('vq_words',JSON.stringify(d.words));}",data)
        pg.reload(); pg.wait_for_timeout(1000)
        did=data['decks'][1]['id']
        steps=[('home',"showScreen('home')"),('board',f"openBoarding({did})"),('words',f"openWords({did})"),('import',"showScreen('import')"),('settings',"showScreen('settings')"),('quiz',f"startQuizDeck({did})"),('result',"showResult()")]
        for name,js in steps:
            pg.evaluate(js); pg.wait_for_timeout(450)
            sw=pg.evaluate("()=>document.documentElement.scrollWidth-window.innerWidth")
            small=pg.evaluate(JS_SMALL)
            print(f'{W}px {name:9s} 横スクロール超過={sw}px  44px未満の操作要素={small}')
        print('  ページエラー',errs); ctx.close()
    b.close()
