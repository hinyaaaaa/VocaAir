import json, random, base64, struct, zlib, sys
from playwright.sync_api import sync_playwright

random.seed(7)
def mk(title, cats, w=3000, h=1800, mime='image/jpeg', lic='CC BY-SA 4.0', desc=''):
    return {'title': 'File:'+title, 'cats': cats, 'w': w, 'h': h, 'mime': mime, 'lic': lic, 'desc': desc}

LAND = [
 mk('Mount_Fuji_from_Lake_Kawaguchi.jpg', ['Mount Fuji from Lake Kawaguchi','Landscapes of Japan','Quality images']),
 mk('Fjord_near_Geiranger.jpg', ['Geirangerfjord','Fjords of Norway','Views of Norway']),
 mk('Sunset_over_the_Sahara.jpg', ['Sunsets in Morocco','Deserts of Morocco']),
 mk('Beach_at_Anse_Source.jpg', ['Beaches of Seychelles','Seascapes of Seychelles']),
 mk('Rice_terraces_Bali.jpg', ['Rice terraces in Bali','Landscapes of Indonesia']),
 mk('Torres_del_Paine_panorama.jpg', ['Panoramas of Chile','Torres del Paine National Park']),
 mk('Rift_valley_view.jpg', ['Valleys of Kenya','Views of Kenya'], desc='View of the Great Rift Valley'),
 mk('Glacier_Perito_Moreno.jpg', ['Glaciers of Argentina','Featured pictures of Argentina']),
]
# 風景ではないが、禁止語タイトル判定をすり抜けやすい写真
BAD = [
 mk('Tokyo_street_at_night.jpg', ['Streets in Tokyo','Night in Tokyo','Views of Tokyo']),
 mk('Old_town_buildings.jpg', ['Buildings in Prague','Urban landscapes of the Czech Republic']),
 mk('Sensoji_gate.jpg', ['Temples in Tokyo','Sensō-ji']),
 mk('Smiling_visitor.jpg', ['Portrait photographs of men','People of Kenya','Landscapes of Kenya']),
 mk('Lion_at_dawn.jpg', ['Lions in Tanzania','Mammals of Tanzania','Sunrises in Tanzania']),
 mk('Cafe_terrace.jpg', ['Restaurants in Paris','Interiors of cafés']),
 mk('Hotel_room_view.jpg', ['Hotel rooms','Interior of hotels','Views from hotels']),
 mk('Harbour_ferries.jpg', ['Ferries in Istanbul','Boats of Turkey','Bosphorus']),
 mk('National_flag_pole.jpg', ['Flags of Norway']),
 mk('Old_map_of_Bali.jpg', ['Old maps of Bali','Maps of Indonesia']),
 mk('Statue_in_park.jpg', ['Statues in Seoul','Parks in Seoul']),
 mk('Train_at_station.jpg', ['Railway stations in Switzerland','Trains of Switzerland','Landscapes of Switzerland']),
 mk('IMG_2043.jpg', ['Self-published work','CC-BY-SA-4.0']),                       # カテゴリに風景の根拠が無い
 mk('Mountain_view_small.jpg', ['Mountains of Peru'], w=900, h=600),            # 小さい
 mk('Mountain_view_portrait.jpg', ['Mountains of Peru'], w=2000, h=3000),       # 縦長
 mk('Mountain_view_png.png', ['Mountains of Peru'], mime='image/png'),
 mk('Mountain_view_nc.jpg', ['Mountains of Peru'], lic='All rights reserved'),
]
def page_json(item, i, with_em_cats):
    p = {'pageid': i, 'title': item['title'],
         'imageinfo': [{'mime': item['mime'], 'width': item['w'], 'height': item['h'],
                        'thumburl': 'https://upload.wikimedia.org/thumb/%d.jpg' % i,
                        'descriptionurl': 'https://commons.wikimedia.org/wiki/'+item['title'],
                        'extmetadata': {'LicenseShortName': {'value': item['lic']}, 'Artist': {'value': 'Tester'},
                                        'ImageDescription': {'value': item['desc']}}}]}
    cats = [{'title': 'Category:'+c} for c in item['cats']]
    return p, cats

def jpeg_bytes():
    import io
    from PIL import Image
    im = Image.new('RGB', (320, 180), (40, 90, 140)); b = io.BytesIO(); im.save(b, 'JPEG'); return b.getvalue()
JPG = jpeg_bytes()
LAND_TITLES = {m['title'] for m in LAND}
mode = sys.argv[1] if len(sys.argv) > 1 else 'prop'   # prop: prop=categories / ext: extmetadata.Categories / none: カテゴリ取得不可

def handler(route):
    url = route.request.url
    if 'upload.wikimedia.org' in url:
        return route.fulfill(status=200, body=JPG, content_type='image/jpeg', headers={'access-control-allow-origin': '*'})
    if 'commons.wikimedia.org' in url:
        items = LAND[:] + BAD[:]
        random.shuffle(items)
        pages = {}; cont = 'clcontinue=' in url
        half = items[len(items)//2:] if cont else items[:len(items)//2]
        for i, it in enumerate(items):
            p, cats = page_json(it, abs(hash(it['title'])) % 10**8, True)
            if mode == 'ext':
                p['imageinfo'][0]['extmetadata']['Categories'] = {'value': '|'.join(it['cats'])}
            elif mode == 'prop':
                # カテゴリは前半・後半に分けて「続き」で返す（続きの処理も確認）
                if (it in half): p['categories'] = cats
            pages[str(p['pageid'])] = p
        out = {'batchcomplete': '', 'query': {'pages': pages}}
        if mode == 'prop' and not cont: out['continue'] = {'clcontinue': 'x|y', 'continue': '||'}
        return route.fulfill(status=200, body=json.dumps(out), content_type='application/json', headers={'access-control-allow-origin': '*'})
    if url.startswith('http://localhost'): return route.continue_()
    return route.abort()

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}, service_workers='block'); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/*', handler)
    pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(800)
    # 旧版の記録が残っている端末を模す: 旧キーに風景ではない写真が入っている
    pg.evaluate("""()=>{localStorage.setItem('va_scn_pick',JSON.stringify({1:{id:'File:Old_bad.jpg',url:'https://upload.wikimedia.org/thumb/1.jpg'}}));
                         localStorage.setItem('va_scn_pool',JSON.stringify([{id:'File:Old_bad.jpg',url:'https://upload.wikimedia.org/thumb/1.jpg'}]));}""")
    pg.reload(); pg.wait_for_timeout(800)
    old_gone = pg.evaluate("()=>[localStorage.getItem('va_scn_pick'),localStorage.getItem('va_scn_pool')]")
    # 1) acceptPage を直接: 全候補に対して
    res = pg.evaluate("""()=>{ const T=Scenery._test; return null }""")
    # 2) 実際に何十回も表示して、選ばれた写真が全部風景か
    shown = []; grad = 0
    for n in range(40):
        idx = pg.evaluate("()=>Scenery.randomPlaceIdx(-1)")
        pg.evaluate("i=>Scenery.show(i)", idx)
        pg.wait_for_timeout(120)
        cur = pg.evaluate("()=>{const a=document.querySelector('#dest-credit a');return a?a.href:''}")
        bg = pg.evaluate("()=>getComputedStyle(document.getElementById('dest-bg')).backgroundImage")
        if cur: shown.append(cur)
        elif 'gradient' in bg: grad += 1
    picked = pg.evaluate("()=>Object.values(JSON.parse(localStorage.getItem('va_scn_pick_v2')||'{}')).map(x=>x.id)")
    bad_in_pick = [t for t in picked if t not in LAND_TITLES]
    print('mode=%s' % mode)
    print(' 旧キー(va_scn_pick/pool)は消えた:', old_gone == [None, None])
    print(' 表示40回: 写真あり %d / 写真なし(グラデーション) %d' % (len(shown), grad))
    print(' 選ばれた写真の種類数 %d、風景ではないもの %d' % (len(set(picked)), len(bad_in_pick)), bad_in_pick[:3])
    print(' ページエラー:', errs[:2])
    b.close()
