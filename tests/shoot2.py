import json, sys, io, random
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFilter
data=json.load(open('/home/claude/VocaAir/VocaAir_save_data.json'))
tag=sys.argv[1]; W=int(sys.argv[2]); H=int(sys.argv[3]); bright = (sys.argv[4]=='bright') if len(sys.argv)>4 else False
# 風景のダミー写真: 明るい場合は白っぽい空と砂浜(最悪条件)、暗い場合は山と夕焼け
def photo():
    im=Image.new('RGB',(1280,800)); d=ImageDraw.Draw(im)
    for y in range(800):
        t=y/800
        if bright: c=(int(225+20*t),int(238+10*t),int(250-10*t)) if y<480 else (int(240),int(228),int(200))
        else: c=(int(40+180*t),int(70+90*t),int(130+30*t))
        d.line([(0,y),(1280,y)],fill=c)
    random.seed(3)
    for i in range(7):
        x=random.randint(-100,1200); d.polygon([(x,520),(x+240,260+random.randint(0,80)),(x+520,520)],fill=(250,252,255) if bright else (30,40,60))
    im=im.filter(ImageFilter.GaussianBlur(1.2)); b=io.BytesIO(); im.save(b,'JPEG',quality=88); return b.getvalue()
JPG=photo()
def handler(route):
    u=route.request.url
    if 'upload.wikimedia.org' in u: return route.fulfill(status=200,body=JPG,content_type='image/jpeg',headers={'access-control-allow-origin':'*'})
    if 'commons.wikimedia.org' in u:
        pg={'1':{'pageid':1,'title':'File:Mount_Test_landscape.jpg','imageinfo':[{'mime':'image/jpeg','width':3000,'height':1800,'thumburl':'https://upload.wikimedia.org/thumb/1.jpg','descriptionurl':'https://commons.wikimedia.org/wiki/File:Mount_Test_landscape.jpg','extmetadata':{'LicenseShortName':{'value':'CC BY-SA 4.0'},'Artist':{'value':'Test Photographer'},'ImageDescription':{'value':''}}}],'categories':[{'title':'Category:Landscapes of Japan'},{'title':'Category:Mountains of Japan'}]}}
        return route.fulfill(status=200,body=json.dumps({'batchcomplete':'','query':{'pages':pg}}),content_type='application/json',headers={'access-control-allow-origin':'*'})
    if u.startswith('http://localhost'): return route.continue_()
    return route.abort()
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':W,'height':H},service_workers='block'); pg=ctx.new_page()
    errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)[:200])); pg.on('console',lambda m: errs.append('console.'+m.type+': '+m.text[:150]) if m.type=='error' else None)
    pg.route('**/*',handler)
    pg.goto('http://localhost:8765/index.html')
    pg.evaluate("d=>{localStorage.setItem('vq_decks',JSON.stringify(d.decks));localStorage.setItem('vq_words',JSON.stringify(d.words));}",data)
    pg.reload(); pg.wait_for_timeout(1800)
    def shot(n,full=False): pg.screenshot(path=f'/tmp/shots/{tag}-{n}.png',full_page=full)
    shot('home')
    did=data['decks'][1]['id']
    pg.evaluate(f"openBoarding({did})"); pg.wait_for_timeout(900); shot('board',True)
    pg.evaluate("showScreen('import')"); pg.wait_for_timeout(500); shot('import',True)
    pg.evaluate("showScreen('settings')"); pg.wait_for_timeout(500); shot('settings',True)
    pg.evaluate(f"openWords({did})"); pg.wait_for_timeout(500); shot('words')
    pg.evaluate(f"startQuizDeck({did})"); pg.wait_for_timeout(1500); shot('quiz')
    pg.keyboard.press('1'); pg.wait_for_timeout(600); shot('quiz-answered')
    pg.evaluate("showResult()"); pg.wait_for_timeout(600); shot('result')
    pg.evaluate("openNewDeckModal()"); pg.wait_for_timeout(400); shot('modal')
    print('errors:',errs)
    b.close()
