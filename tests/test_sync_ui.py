import json
from playwright.sync_api import sync_playwright
data=json.load(open('/home/claude/VocaAir/VocaAir_save_data.json'))
FAKE = """
window.__cloud = { decks:new Map(), words:new Map(), settings:null };
window.__fail = { on:false, once:false };
window.VaSyncFirebase = { loadFirebase: async () => ({
  onAuthChanged: cb => setTimeout(()=>cb({uid:'u1', email:'a@example.com'}), 30),
  signIn: async()=>{}, signUp: async()=>{}, signOut: async()=>{},
  makeBackend: uid => { let h; return {
    start(handlers){ h=handlers; const c=window.__cloud; const L=(m,k)=>[...m.values()].map(d=>({kind:k,id:d.id,json:d.json,updatedAt:d.updatedAt,deletedAt:d.deletedAt||null}));
      setTimeout(()=>{ h.onDocs(L(c.decks,'deck')); h.onDocs(L(c.words,'word')); h.onDocs([]); h.onStatus('synced'); }, 40); },
    stop(){},
    async push(items){ const c=window.__cloud; const failed=[]; for(let i=0;i<items.length;i+=400){ const part=items.slice(i,i+400);
        if(window.__fail.on || (window.__fail.once && i===800)){ if(window.__fail.once) window.__fail.once=false; failed.push(...part); continue; }
        part.forEach(it=>{ if(it.kind==='settings') c.settings=it; else (it.kind==='deck'?c.decks:c.words).set(it.id,{id:it.id,json:it.json,updatedAt:it.updatedAt,deletedAt:it.deletedAt}); }); } return failed; },
    async fetchAll(){ const c=window.__cloud; const L=(m,k)=>[...m.values()].map(d=>({kind:k,id:d.id,json:d.json,updatedAt:d.updatedAt,deletedAt:d.deletedAt||null})); return {decks:L(c.decks,'deck'),words:L(c.words,'word')}; }
  }; } }) };
"""
CFG={'apiKey':'AIzaSyFAKEFAKEFAKEFAKEFAKE1234','authDomain':'x.firebaseapp.com','projectId':'fake-proj','appId':'1:123456:web:abcdef'}
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844}, service_workers='block'); pg=ctx.new_page()
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.route('**/*', lambda r: r.continue_() if r.request.url.startswith('http://localhost') else r.abort())
    pg.route('**/sync-firebase.js*', lambda r: r.fulfill(status=200, body=FAKE, content_type='application/javascript'))
    pg.goto('http://localhost:8765/index.html')
    pg.evaluate("""([d,c])=>{localStorage.setItem('vq_decks',JSON.stringify(d.decks));localStorage.setItem('vq_words',JSON.stringify(d.words));localStorage.setItem('va-firebase-config',JSON.stringify(c));}""",[data,CFG])
    pg.reload(); pg.wait_for_timeout(1800)
    n = lambda: pg.evaluate("()=>window.__cloud.words.size")
    print('初回送信後 クラウド', n(), '語 / 端末 1929語')
    # 送信が一部失敗する状況で、語を追加・採点し続ける → 自動で再送されるか
    pg.evaluate("()=>{window.__fail.once=true}")
    pg.evaluate("""()=>{const ws=loadWords(); ws.forEach((w,i)=>{ if(i%2==0) w.reps=(w.reps||0)+1; }); saveWords(ws);}""")
    pg.wait_for_timeout(1800)
    def stale():
        return pg.evaluate("""()=>{const L=loadWords(); let n=0; for(const w of L){ const d=window.__cloud.words.get(String(w.id)); if(!d || JSON.parse(d.json).reps!==w.reps) n++; } return n;}""")
    print('更新直後（一部の送信を失敗させた）: クラウドに未反映の語', stale())
    pg.wait_for_timeout(5000)
    print('5秒後（自動の再送）: クラウドに未反映の語', stale())
    # 設定画面→全件照合
    pg.evaluate("showScreen('settings'); initSettings()"); pg.wait_for_timeout(300)
    pg.screenshot(path='/tmp/shots/sync-card.png', full_page=True)
    # クラウドから200語が欠けた状況を作る（旧版の症状）
    pg.evaluate("()=>{const m=window.__cloud.words; [...m.keys()].slice(0,200).forEach(k=>m.delete(k));}")
    print('欠落を作った後 クラウド', n(), '語')
    pg.click("text=全件を照合"); pg.wait_for_timeout(1500)
    print('照合後 クラウド', n(), '語')
    print('表示:', pg.inner_text('#sync-verify').replace('\n',' / '))
    pg.screenshot(path='/tmp/shots/sync-card-after.png', full_page=True)
    print('ページエラー:', errs)
    b.close()
