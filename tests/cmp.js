const fs=require('fs');
function load(path){
  const w={SCENERY_ANCHORS:[['T','X',0,0]],addEventListener(){},caches:undefined};
  global.window=w; global.localStorage={getItem(){return null},setItem(){},removeItem(){}}; global.navigator={onLine:false}; global.document={getElementById(){return null}};
  global.caches=undefined;
  delete require.cache[require.resolve(path)]; require(path); return w.Scenery._test;
}
const mk=(title,cats,o={})=>({title:'File:'+title,imageinfo:[{mime:o.mime||'image/jpeg',width:o.w||3000,height:o.h||1800,thumburl:'u',descriptionurl:'d',extmetadata:{LicenseShortName:{value:o.lic||'CC BY-SA 4.0'},Artist:{value:'a'},ImageDescription:{value:o.desc||''},Categories:{value:cats.join('|')}}}],categories:cats.map(c=>({title:'Category:'+c}))});
const BAD={
 '東京の夜の街路':mk('Tokyo_street_at_night.jpg',['Streets in Tokyo','Night in Tokyo','Views of Tokyo']),
 '旧市街の建物':mk('Old_town_buildings.jpg',['Buildings in Prague']),
 '寺の門':mk('Sensoji_gate.jpg',['Temples in Tokyo']),
 '人物(Landscapes併記)':mk('Smiling_visitor.jpg',['Portrait photographs of men','Landscapes of Kenya']),
 'ライオン':mk('Lion_at_dawn.jpg',['Lions in Tanzania','Mammals of Tanzania','Sunrises in Tanzania']),
 'カフェ店内':mk('Cafe_terrace.jpg',['Restaurants in Paris','Interiors of cafés']),
 'フェリー':mk('Harbour_ferries.jpg',['Ferries in Istanbul']),
 '銅像':mk('Statue_in_park.jpg',['Statues in Seoul']),
 '駅の列車':mk('Train_at_station.jpg',['Railway stations in Switzerland','Landscapes of Switzerland']),
 '無題IMG_2043':mk('IMG_2043.jpg',['Self-published work']),
};
const GOOD={'富士山':mk('Mount_Fuji_from_Lake_Kawaguchi.jpg',['Landscapes of Japan']),'フィヨルド':mk('Fjord_near_Geiranger.jpg',['Fjords of Norway']),'砂漠の夕日':mk('Sunset_over_the_Sahara.jpg',['Sunsets in Morocco']),'氷河':mk('Glacier_Perito_Moreno.jpg',['Glaciers of Argentina'])};
for (const [name,path] of [['旧(v1.9.0)','/tmp/t/scenery_old.js'],['新(v1.9.1)','/home/claude/VocaAir/scenery.js']]){
  const T=load(path); const blocked=new Set();
  const bad=Object.entries(BAD).filter(([k,p])=>T.acceptPage(p,blocked)).map(([k])=>k);
  const good=Object.entries(GOOD).filter(([k,p])=>T.acceptPage(p,blocked)).map(([k])=>k);
  console.log(name,'\n  風景ではないのに通った:',bad.length+'/'+Object.keys(BAD).length,bad.join('、'),'\n  風景を正しく通した:',good.length+'/'+Object.keys(GOOD).length);
}
