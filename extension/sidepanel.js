"use strict";
/* ============ 基盤 ============ */
const $=id=>document.getElementById(id);
const KANJI={"〇":0,"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10};
const norm=s=>(s||"").normalize("NFKC").trim();
const kataToHira=s=>s.replace(/[ァ-ヶ]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0x60));
const stripTail=c=>c.replace(/(です|でした|になります|でお願いします|お願いします|ですね|だよ|だった)$/,"");
const splitClauses=t=>t.split(/(?:[、。，／・\s]|(?<!\d)[.,](?!\d))+/).filter(Boolean).map(stripTail).filter(Boolean); // 小数点(36.5)は分割しない
const numFrom=tok=>/^\d+$/.test(tok)?parseInt(tok,10):(tok in KANJI?KANJI[tok]:NaN);

/* ============ 用語集グロッサリ（介護用語の補正・正規化） ============
   出典: 用語集/Care-Terms-AllLanguages.csv（全675語）＋ Scribe worker.js の補正辞書。
   日本語テキスト（ブラウザ音声認識・Scribe翻訳の双方）を対話エンジンに渡す前に同音誤変換を補正する。 */
const CARE_FIX=[
  ["自備院効果","耳鼻咽喉科"],["自備院講科","耳鼻咽喉科"],["自備医工科","耳鼻咽喉科"],["自備員効果","耳鼻咽喉科"],
  ["自備因果","耳鼻咽喉科"],["自備院高科","耳鼻咽喉科"],["自秘院工科","耳鼻咽喉科"],["自秘院効果","耳鼻咽喉科"],
  ["言語聴覚師","言語聴覚士"],["言語聴覚紙","言語聴覚士"],["固執形成術","鼓室形成術"],["腹鼻空","副鼻腔"],
  ["電音難聴","感音難聴"],["肝音難聴","感音難聴"],["純学医内科","循環器内科"],["純学内科","循環器内科"],
  ["心房再動","心房細動"],["不正脈","不整脈"],["面痴漢術","弁置換術"],["末小動脈疾患","末梢動脈疾患"],
  ["軽カテーテル","経カテーテル"],["人工内治","人工内耳"],["流地術","留置術"],["軽感栄養","経管栄養"],
  ["経間栄養","経管栄養"],["航空吸引","口腔吸引"],["口空吸引","口腔吸引"],["機関吸引","気管吸引"],
  ["基幹吸引","気管吸引"],["器官吸引","気管吸引"],["口腔ビッグ","口腔吸引"],["清潔ソース","清潔操作"],
  ["正式で対応","清拭で対応"],["部分翼","部分浴"],["異常解除","移乗介助"],["移乗解除","移乗介助"],
  ["白内小","白内障"],["白内症","白内障"],["軟腸","難聴"],["南腸","難聴"],["南朝","難聴"],
  ["転眼","点眼"],["配便","排便"],["航空","口腔"],["口空","口腔"]
];
function careFix(t){ if(!t) return t; for(const [w,c] of CARE_FIX){ if(t.indexOf(w)>=0) t=t.split(w).join(c); } return t; }
/* 用語集の正規化語（日本語・全675語）。AI抽出の用語ヒント／用語照合・参照に利用。 */
const CARE_TERMS_JA = /*用語集675語*/["気管吸引","口腔吸引","経鼻経管栄養","経管栄養","入浴","部分浴","清拭","清潔操作","移乗介助","体位変換","口腔ケア","尿道カテーテル","創傷ケア","褥瘡","おむつ交換","排泄介助","点眼","服薬介助","酸素療法","誤嚥","血圧","脈拍","体温","呼吸数","酸素飽和度","血糖","認知症","糖尿病","高血圧","脳卒中","誤嚥性肺炎","便秘","脱水","転倒","骨折","尿路感染症","介護士","看護師","医師","理学療法士","言語聴覚士","薬剤師","薬","処方箋","アレルギー","予約","入院","退院","ケアプラン","バイタルサイン","排泄","掃除","洗濯","ベットメイク","衣類・被服","調理・配下膳","買物・薬の受取","状態観察","安全確認","衣類更衣","支援記録","医療処置","アクティビティ・活動","リハビリテーション","レクリエーション","外出・外泊","外泊・面会等","看護ケア","看護・観察","苦情対応","水分","行事","事故・緊急時対応","入院・退院","往診","栄養管理方法","栄養管理状態","巡視・様子確認","状態変化対応","身体整容","移乗・移動介助","服薬","起床・就寝","方法","主食","観察記録","内容","状況","移動","個別リハ","運動療法","副食","物理療法","状態","活動内容","出発","帰館","更衣-内容","更衣-介助","主食量","所在","栄養","与薬","一般","局所","入浴判断","副食量","状態(就寝)","対応","痰の状態","発生（対応）日時","申し立て者","月単位行事","季節行事","リハビリ","栄養補給量","発生日時","分類","対応①","対応②","予見可能性","入退院","主症状","有料サービス","状態コメント","受診－内容","入院－内容","入院－その他","開始時間","終了時間","次回予約","受診科目","インフォームド？コンセント","往診医","薬剤関連","摂取カロリー","体位交換","その他","水分補給","洗髪","着脱衣","皮膚の状態","意識の状態","整容項目","顔色","排尿","頭皮頭髪","爪","介助","介助内容","排尿（状態）","血圧（上）","血圧（下）","身長","体重","場所","特記","口腔-内容","口腔-介助","排便（性状）","排泄-種類","排泄-場所","排泄-用具","排泄-介助","尿失禁","便失禁","排泄-その他","排尿状態","失禁","排便形状（ブリストルスケール）","排泄後の状態確認","整容-内容","整容-介助","預り金","使用金","気分","吸引（状態）","吸引（量）","絶食","食欲あり","普通","空腹感","倦怠感","嘔吐","喘鳴","嚥下困難","その他異常","むせ込み","ため込み","多量","紅茶","ゼリー","極少量","少量","全身浴","手浴","足浴","全身清拭","上半身清拭","下肢清拭","一般浴","機械浴","入浴中止","個浴","自立","見守り","一部介助","全介助","濃縮","混濁","問題なし","腫瘤","発赤","皮膚剥離","血尿","異常あり","洗面","歯磨き","手爪切り","足爪切り","耳掃除","髭剃り","髪の手入れ","化粧","口腔清拭","義歯洗浄","更衣","黄だんあり","顔面蒼白","紅潮","ポータブル","目脂に異常あり","涙目","涙流している","鼻汁に異常あり","頭皮褥瘡あり","頭皮発赤あり","頭皮痂皮あり","脱毛が多い","掻痒感あり","腫瘤あり","耳垢が多い","耳垢が少ない","水虫","深爪","移乗","安楽","食前","食間","食後","就寝前","入浴時","排泄時","内服","タイプA（コロコロ便）","坐剤","貼薬","注入（経口）","注入（経鼻）","注入（胃ろう）","準備","内容確認","タイプB（硬い便）","吐き出し","拒否","タイプC（やや硬い便）","起床","就寝","タイプD（普通便）","布団","寝つきが良い","寝つきが悪い","寝起きが良い","タイプE（やや軟らかい便）","寝起きが悪い","布団を敷く","布団をたたむ","洋服→寝巻","寝巻→洋服","洋服→洋服","寝巻→寝巻","衣類調整","未実施（未確認）","タイプF（泥状便）","声かけ","見守り？確認","歯ブラシ","スポンジブラシ","紙おむつ","タイプG(水様便)","自発的行為","随時誘導","定時誘導","ベッド上","不使用","失禁用パンツ","紙パンツ","パット","尿器","バルーン","衣類全更衣","ズボンのみ更衣","リネン類交換","微量","未確認","通常","混濁尿","茶褐色尿","黒色尿","濃尿","①コロコロ便","②硬い便","③やや硬い便","④普通便","⑤やや軟らかい便","⑥泥状便","⑦水様便","問題あり","栄養補給","注入食","歩行距離","自立歩行","手引き歩行","杖歩行","車椅子自走","車椅子介助","ゴミ出し","冷蔵庫チェック","エアコン掃除","加湿器掃除","居間","寝室","尿パット","玄関","風呂","汚れがひどい","普通食","汚れがあまりない","洗濯機","手洗い","物干し","乾燥機","取り込み","粥食","たたみ","アイロンがけ","収納","多い","一般衣類","失禁衣類","軟飯","布団カバー交換","シーツ交換","布団干し","布団取込","汚染時シーツ交換","布団乾燥","衣類整理","夏？冬物入替","ボタン付け","刻み食","破れ補修","名前記入","調理","配膳","後片付け","買い物","薬の受取","ミキサー食","数字入力（円）","巡回","訪室","入眠","覚醒","不穏","徘徊","帰宅願望","パン（普通）","背抜き","除圧","寝衣更衣","日常着更衣","上着更衣(汚染)","下着更衣(汚染)","全更衣(汚染)","パン（一口大）","電話","透明","白","緑","黄","パン（粥）","粘チョウ","サラサラ","中等量","消毒","ガーゼ保護","冷罨法","温罨法","紙おむつ+尿パット","米飯","軟膏塗布","洗浄","インスリン","気管切開","胃ろう","膀胱ろう","ストーマ","腎ろう","ミキサー粥","中心静脈栄養","腹膜透析","抗癌剤","糜爛","紫斑","おにぎり","痺れ","イベント","アクティビティ","サロン","個別対応","体操","機能リハビリ","生活リハビリ","茶話会","誕生会","演奏会","生け花","書道","映画","カラオケ","参加","不参加","途中参加（一部実施）","途中退出","個別リハビリ","関節可動域訓練","一口大","筋力トレーニング","基本動作訓練","促通訓練","歩行訓練","車椅子駆動訓練","ＡＤＬ訓練","パワーリハ","階段昇降訓練","屋外歩行訓練","ＳＳＰ","ホットパック","アクアシエスタ","介達牽引","メドマ","マイクロ波","アイシング","異常なし","本人の都合","ムース","体調不良","園外活動","歌","発声練習","口腔体操","散歩","畑仕事","脳トレ","ペースト","カードゲーム","カレンダー","大カレンダー","将棋","習字","ペン習字","絵手紙","パズル","全量","カルタ","歌カルタ","ボールレク","洗濯物たたみ","洗濯物干し","おしぼり巻き","健康管理表","小物作り","おやつ作り","３分の２","詩吟","折り紙","塗り絵","季節イベント","外出","ドライブ","外泊","２分の１","→外出着","３分の１","親戚","受診","帰苑","帰宅","経鼻栄養","摂食介助","摂食嚥下訓練","臨時与薬","定時与薬","インスリン注射","ブドウ糖服用","麻薬","点鼻","吸入","在宅酸素","白色痰","黄色痰","緑色痰","透明な痰","水様？唾液","粘ちょう痰","クーリング","下肢リンパマッサージ","弾性包帯ケア","傾聴","インスリン自己注射指導","定期処置","カット判処置","ガーゼ処置","軟膏処置","ドレッシング剤処置","摘便","バルン交換","導尿","腹部マッサージ","膀胱洗浄","ミルキング","パルーン","低血糖発作なし","低血糖発作あり","病歴聞き取り","薬情報確認","家族聞きとり","痛みなし","可動時疼痛なし","可動時疼痛あり","出血なし","出血あり","可動制限あり","可動不可","立位可","立位不可","入浴不可","シャワー浴に変更","清拭に変更","ゴロ音","吸痰","タッピング","ネブライザー","粘稠痰","発生時報告","経過報告","最終報告","本人","親族","知人","喫茶","レクリェーション","エステ","新年のお祝い","初詣","節分","ひなまつり","梅花見","桜花見","グランドゴルフ","菖蒲花見","七夕","土用丑の日","盆踊り","夏祭り","敬老会","運動会","一泊旅行","日帰り旅行","食事会","クリスマス会","もちつき","機能訓練","リズム体操","ラジオ体操","ヒヤリハット","緊急時対応","感染症対応","転倒？転落","外傷","内出血","誤薬","落薬","バイタル値異常","ストマ","ホーム長報告","看護対応依頼（報告）","Drコール","身元引受人？家族連絡","経過観察","臨時往診","経過観察後受診","救急搬送","人工呼吸","気道確保","心臓マッサージ","対策実施済","対策検討も未実施","予測していたが対策未検討","予測できなかった","身体的要因","心理的要因","環境的要因","教育的要因","栄養低下","健康診断","定期","臨時","ＰＥＧ交換","看護サマリー提供","情報提供","情報収集","退院受け入れ準備訪問","退院前カンファレンス","内科","整形","眼科","婦人科","脳神経(内？外)","皮膚科","個別往診","集団往診","医師情報提供","薬剤指示","看護師指示","本人説明？指示","点滴","採血","予防接種","身元引受人","かかりつけ医","協力訪問歯科","定期処方","臨時処方","処方変更","薬剤説明？服薬指導（薬剤師）","経口摂取","経管栄養（胃ろう）","数字入力量","数字入力摂取カロリー","胃ろう漏れあり","定時巡視","コールマット","様子確認","臥床（覚醒）","離床（活動）","右側臥位","左側臥位","仰臥位","下肢挙上","頭部挙上","室温調整","湿度調整","照度調整","換気","頭痛","腹痛","意識消失","下痢","発汗","体温測定","血圧測定","バイタル測定","アンビュー"];

/* ============ デモ用マスタ（利用者） ============ */
const RESIDENTS=[
  {name:"田中 はな", aliases:["田中はな","たなかはな","田中","たなか"]},
  {name:"佐藤 たけし", aliases:["佐藤たけし","さとうたけし","佐藤","さとう"]},
  {name:"鈴木 うめ", aliases:["鈴木うめ","すずきうめ","鈴木","すずき"]},
  {name:"高橋 じろう", aliases:["高橋じろう","たかはしじろう","高橋","たかはし"]},
  {name:"伊藤 きく", aliases:["伊藤きく","いとうきく","伊藤","いとう"]}
];
const STAFF="山本";

/* ============ 値パーサ（誤変換辞書つき） ============ */
function parseResident(c){
  const h=kataToHira(c.replace(/(さん|さま|様|氏)/g,""));
  for(const r of RESIDENTS){ for(const a of r.aliases){ if(h.includes(a)) return r.name; } }
  return undefined;
}
/* 摂取量（CWマスタ準拠の値へ正規化）。同音誤変換: 全寮/善良/前領→全量 */
const RATIO_MAP=[
  [/全量|完食|全部食|全部|ぜんりょう|全寮|善良|前領|きれいに/,"全量"],
  [/3分の2|さんぶんのに/,"３分の２"],
  [/2分の1|半分|半量|はんぶん/,"２分の１"],
  [/3分の1|さんぶんのいち/,"３分の１"],
  [/極少量|ごく少量|ひとくち|一口|少しだけ/,"極少量"],
  [/拒食|拒否/,"拒食"],
  [/欠食/,"欠食"],
  [/食べて(い)?ない|摂取なし/,"なし"]
];
function parseRatio(c,bare){
  for(const [re,v] of RATIO_MAP){ if(re.test(c)) return v; }
  const m=c.match(/(10|\d|[〇一二三四五六七八九十])\s*(割|わり)/);
  if(m){ const n=numFrom(m[1]); if(n>=0&&n<=10) return n+"割"; }
  if(!bare&&/^なし$/.test(c)) return "なし";
  return undefined;
}
/* cc/ml（単位ゆれ大幅対応: ミリ,mm,ml,cc,㏄,㎖,㍉,みり…） */
const CC_UNIT=/(\d{1,4})\s*(ミリリットル|ミリメートル|ミリ|ml|mm|cc|㏄|㎖|㍉|ｍｌ|ｍｍ|シーシー|ミル|みり)/i;
function parseCc(c,bare){
  if(!bare&&/なし|飲んでない|飲まなかった|拒否/.test(c)) return "なし";
  if(/コップ(1|一)杯|コップいっぱい/.test(c)) return 150;
  if(/コップ半分/.test(c)) return 75;
  if(/湯呑み|湯のみ/.test(c)) return 100;
  let m=c.match(CC_UNIT); if(m) return parseInt(m[1],10);
  m=bare?(c.match(/^(\d{1,4})$/)||c.match(/\D(\d{1,4})$/)):c.match(/(\d{1,4})\s*$/);
  if(m){const n=+m[1]; if(n>=5&&n<=2000) return n;}
  return undefined;
}
function parseTemp(c,bare){
  let m=c.match(/(\d{2})\s*(度|℃)\s*(\d)\s*分?/); if(m) return +(m[1]+"."+m[3]);
  m=c.match(/(\d{2})\s*(点|てん)\s*(\d)/); if(m) return +(m[1]+"."+m[3]);
  m=c.match(/(\d{2}(?:\.\d)?)\s*(度|℃)/); if(m){const n=+m[1]; if(n>=30&&n<=43) return n;}
  if(bare){ m=c.match(/^(\d{2}\.\d)$/); if(m){const n=+m[1]; if(n>=33&&n<=43) return n;} }
  return undefined;
}
function parseBp(c){
  const m=c.match(/(\d{2,3})[^\d]{0,4}(\d{2,3})/);
  if(m){ const u=+m[1], l=+m[2];
    if(u>=70&&u<=260&&l>=30&&l<=160&&u>l) return {u,l}; }
  return null;
}
const parseIntRange=(min,max)=>(c,bare)=>{
  const m=bare?c.match(/^(\d{1,3})$/):c.match(/(\d{1,3})/);
  if(m){const n=+m[1]; if(n>=min&&n<=max) return n;}
  return undefined;
};
/* 選択肢（1文字エイリアスは完全一致のみ） */
const choice=defs=>(c)=>{
  for(const d of defs){ for(const a of [...d.alias].sort((x,y)=>y.length-x.length)){
    if(a.length===1){ if(c===a) return d.v; } else if(c.toLowerCase().includes(a.toLowerCase())) return d.v; } }
  return undefined;
};
/* 複数選択（状態コメント系）: 一致した候補を「・」連結 */
const multiChoice=defs=>{
  const raw=c=>{ const hits=[];
    for(const d of defs){ for(const a of d.alias){
      if(a.length>1&&c.includes(a)){
        if(new RegExp(a+"(は|も)?(なし|無し|ありません)").test(c)) continue; // 否定は拾わない
        if(!hits.includes(d.v)) hits.push(d.v); break; } } }
    return hits.length?hits.join("・"):undefined; };
  return (c,bare)=>{ const v=raw(c); if(v!==undefined) return v;
    if(!bare){ const m=c.match(/^(?:様子|状態コメント|状態|特記|コメント)(?:は|:|：)?[\s、]*(.{2,})$/);
      if(m&&!NASHI.test(m[1])) return m[1]; }
    return undefined; };
};
const NASHI=/^(なし|無し|特になし|特にない|ありません|特にありません|大丈夫|ないです)$/;
const anchorsOf=sl=>[...(sl.anchors||[]),...(sl.label?[sl.label]:[])];

/* ============ 記録スキーマ（CWマスタ20251021準拠・食事/水分補給/排泄/バイタル） ============ */
const ASSIST=choice([{v:"自立",alias:["自立"]},{v:"準備",alias:["準備"]},{v:"声かけ",alias:["声かけ","声掛け"]},{v:"見守り・確認",alias:["見守り","確認のみ"]},{v:"一部介助",alias:["一部介助","一部"]},{v:"全介助",alias:["全介助"]}]);
const PLACE=choice([{v:"食堂",alias:["食堂"]},{v:"居室",alias:["居室","部屋"]},{v:"リビング",alias:["リビング"]},{v:"ベッド",alias:["ベッド","ベッドサイド"]},{v:"トイレ",alias:["トイレ"]},{v:"浴室",alias:["浴室","風呂"]},{v:"廊下",alias:["廊下"]},{v:"中庭",alias:["中庭"]},{v:"健康管理室",alias:["健康管理室"]}]);
const fmtCc=v=>typeof v==="number"?v+"cc":String(v);
const SCHEMAS={
  meal:{ name:"食事", icon:"🍚",
    trigger:/食事|朝食|昼食|夕食|ご飯|ごはん|間食|おやつ|完食|主食|副食/,
    slots:[
      {id:"resident", label:"利用者", req:true, self:true, parse:parseResident, say:v=>v+"さん",
       quick:RESIDENTS.map(r=>r.name.split(" ")[0]+"さん")},
      {id:"content", label:"内容", req:true, self:true,
       parse:choice([{v:"朝",alias:["朝食","朝ごはん","朝御飯","モーニング","朝"]},{v:"昼",alias:["昼食","昼ごはん","お昼","ランチ","昼"]},{v:"夕",alias:["夕食","夕飯","晩ごはん","晩御飯","夜ごはん","夜","夕"]},{v:"おやつ",alias:["おやつ","間食"]},{v:"栄養補助食品",alias:["栄養補助","エンシュア","ラコール","メイバランス"]},{v:"注入食",alias:["注入","経管"]},{v:"欠食",alias:["欠食"]},{v:"外食",alias:["外食"]}]),
       quick:["朝食","昼食","夕食","おやつ"], chipRaw:true},
      {id:"staple_amt", label:"主食量", req:true, anchors:["主食","ご飯","ごはん","米飯","お粥","粥","パン","おにぎり"], parse:parseRatio,
       quick:["全量","8割","２分の１","極少量"], chipPrefix:"主食"},
      {id:"side_amt", label:"副食量", req:true, anchors:["副食","おかず","副菜"], parse:parseRatio,
       quick:["全量","8割","２分の１","極少量"], chipPrefix:"副食"},
      {id:"water", label:"水分補給", req:true, anchors:["水分","お茶","汁","スープ","飲み物","ミリ","cc","㏄","ml","コップ"], parse:parseCc, fmt:fmtCc,
       quick:["200cc","150cc","100cc","コップ1杯"], chipPrefix:"水分"},
      {id:"staple_kind", label:"主食(形態)", self:true,
       parse:choice([{v:"普通食",alias:["普通食","常食"]},{v:"全粥",alias:["全粥"]},{v:"軟飯",alias:["軟飯"]},{v:"刻み食",alias:["刻み食","刻み"]},{v:"ミキサー食",alias:["ミキサー"]},{v:"パン（普通）",alias:["パン"]}])},
      {id:"assist", label:"介助", anchors:["介助","自立","声かけ","見守り"], parse:ASSIST, self:true},
      {id:"place", label:"場所", anchors:["場所"], parse:PLACE, self:true},
      {id:"comment", label:"状態コメント", freeText:true, self:true, anchors:["様子","状態","特記","コメント"],
       parse:multiChoice([{v:"食欲あり",alias:["食欲あり"]},{v:"食欲不振",alias:["食欲不振","食欲がない","食欲低下"]},{v:"むせ込み",alias:["むせ込み","むせこみ","むせ","ムセ","咽せ"]},{v:"ため込み",alias:["ため込み","ためこみ"]},{v:"嚥下困難",alias:["嚥下困難","嚥下"]},{v:"嘔吐",alias:["嘔吐","吐い"]},{v:"喘鳴",alias:["喘鳴","ぜんめい"]},{v:"倦怠感",alias:["倦怠感","だるそう"]}]),
       quick:["むせ込みあり","食欲不振"]}
    ]},
  hydration:{ name:"水分補給", icon:"🍵",
    trigger:/水分|飲水|お茶|白湯|麦茶|ジュース|コーヒー/,
    slots:[
      {id:"resident", label:"利用者", req:true, self:true, parse:parseResident, say:v=>v+"さん",
       quick:RESIDENTS.map(r=>r.name.split(" ")[0]+"さん")},
      {id:"kind", label:"種類", req:true, self:true,
       parse:choice([{v:"ほうじ茶",alias:["ほうじ茶"]},{v:"麦茶",alias:["麦茶"]},{v:"お茶",alias:["お茶","緑茶"]},{v:"コーヒー",alias:["コーヒー","珈琲"]},{v:"紅茶",alias:["紅茶"]},{v:"牛乳",alias:["牛乳","ミルク"]},{v:"白湯",alias:["白湯","さゆ"]},{v:"水",alias:["お水","水"]},{v:"ジュース",alias:["ジュース"]},{v:"スポーツ飲料",alias:["スポーツ飲料","ポカリ","アクエリ"]},{v:"ゼリー",alias:["ゼリー"]},{v:"味噌汁",alias:["味噌汁","みそ汁"]},{v:"経口補水液",alias:["経口補水液","OS-1","オーエスワン"]},{v:"経口栄養剤",alias:["経口栄養剤","エンシュア","ラコール"]}]),
       quick:["お茶","麦茶","水","ジュース"], chipRaw:true},
      {id:"amount", label:"量", req:true, anchors:["量","ミリ","cc","㏄","ml","コップ"], parse:parseCc, fmt:fmtCc,
       quick:["200cc","150cc","100cc","コップ1杯"], chipPrefix:"量"},
      {id:"toromi", label:"トロミ", anchors:["トロミ","とろみ"], parse:choice([{v:"薄い",alias:["薄い","薄め"]},{v:"中間",alias:["中間"]},{v:"濃い",alias:["濃い","濃いめ"]}])},
      {id:"assist", label:"介助", anchors:["介助","自立","声かけ","見守り"], parse:ASSIST, self:true},
      {id:"place", label:"場所", anchors:["場所"], parse:PLACE, self:true},
      {id:"comment", label:"状態コメント", freeText:true, self:true, anchors:["様子","状態","特記","コメント"],
       parse:multiChoice([{v:"良好",alias:["良好"]},{v:"嘔吐",alias:["嘔吐"]},{v:"喘鳴",alias:["喘鳴"]},{v:"嚥下困難",alias:["嚥下困難","嚥下","むせ"]}])}
    ]},
  excretion:{ name:"排泄", icon:"🚻",
    trigger:/排泄|排尿|排便|トイレ|おしっこ|うんち|便|尿/,
    slots:[
      {id:"resident", label:"利用者", req:true, self:true, parse:parseResident, say:v=>v+"さん",
       quick:RESIDENTS.map(r=>r.name.split(" ")[0]+"さん")},
      {id:"urine", label:"排尿", req:true, anchors:["排尿","尿","おしっこ"],
       parse:(c,bare)=>{ const m=c.match(CC_UNIT); if(m&&/尿/.test(c)) return m[1]+"cc";
         const v=choice([{v:"多量",alias:["多量","多め","たくさん"]},{v:"普通",alias:["普通","中等量"]},{v:"少量",alias:["少量","少なめ","少し"]},{v:"失禁",alias:["失禁"]},{v:"未確認",alias:["未確認"]},{v:"あり",alias:["あり","出た"]},{v:"なし",alias:["なし","出ていない","出てない"]}])(c); return v; },
       quick:["普通","多量","少量","なし"], chipPrefix:"排尿"},
      {id:"stool", label:"排便", req:true, anchors:["排便","便","うんち"],
       parse:(c,bare)=>{ const m=c.match(/(\d{1,4})\s*(g|グラム)/i); if(m) return m[1]+"g";
         const v=choice([{v:"多量",alias:["多量","多め"]},{v:"普通",alias:["普通","中等量"]},{v:"少量",alias:["少量","少なめ","少し"]},{v:"バナナ大",alias:["バナナ大","バナナ"]},{v:"ゴルフボール大",alias:["ゴルフボール"]},{v:"失禁",alias:["失禁"]},{v:"未確認",alias:["未確認"]},{v:"あり",alias:["あり","出た"]},{v:"なし",alias:["なし","出ていない","出てない"]}])(c); return v; },
       quick:["普通","少量","バナナ大","なし"], chipPrefix:"排便"},
      {id:"stool_form", label:"排便形状", req:true, when:s=>s.stool!==undefined&&s.stool!=="なし"&&s.stool!=="未確認", self:true,
       parse:choice([{v:"硬便",alias:["硬便","硬い","かたい","コロコロ"]},{v:"やや軟らかい便",alias:["やや軟らかい","やや柔らかい"]},{v:"軟便",alias:["軟便","柔らかい","やわらかい"]},{v:"泥状便",alias:["泥状"]},{v:"水様便",alias:["水様","下痢"]},{v:"普通便",alias:["普通便"]}]),
       quick:["普通便","軟便","硬便","水様便"], chipRaw:true},
      {id:"method", label:"方法・用具", self:true,
       parse:choice([{v:"トイレ",alias:["トイレで"]},{v:"ポータブル",alias:["ポータブル"]},{v:"紙おむつ",alias:["紙おむつ","おむつ"]},{v:"尿パット",alias:["尿パット","パット"]},{v:"紙パンツ",alias:["紙パンツ"]},{v:"リハビリパンツ",alias:["リハビリパンツ","リハパン"]},{v:"尿器",alias:["尿器"]},{v:"バルーン",alias:["バルーン"]},{v:"ストマ",alias:["ストマ"]}])},
      {id:"contamination", label:"衣類汚染", anchors:["汚染","汚れ"], parse:choice([{v:"あり",alias:["あり"]},{v:"なし",alias:["なし"]}])},
      {id:"assist", label:"介助", anchors:["介助","自立","声かけ","見守り"], parse:ASSIST, self:true},
      {id:"place", label:"場所", anchors:["場所"], parse:PLACE, self:true},
      {id:"comment", label:"状態コメント", freeText:true, self:true, anchors:["様子","状態","特記","コメント"],
       parse:multiChoice([{v:"衣類全更衣",alias:["全更衣"]},{v:"ズボンのみ更衣",alias:["ズボンのみ"]},{v:"リネン類交換",alias:["リネン"]},{v:"問題なし",alias:["問題なし"]},{v:"問題あり",alias:["問題あり"]}])}
    ]},
  vital:{ name:"バイタル・意識レベル", icon:"🩺",
    trigger:/バイタル|体温|血圧|脈|検温|サチュレーション|spo2|酸素/i,
    slots:[
      {id:"resident", label:"利用者", req:true, self:true, parse:parseResident, say:v=>v+"さん",
       quick:RESIDENTS.map(r=>r.name.split(" ")[0]+"さん")},
      {id:"temp", label:"体温", req:true, self:true, anchors:["体温","熱","検温"],
       parse:(c,bare)=>{ const v=parseTemp(c,bare); if(v!==undefined) return v;
         if(!bare&&/体温|熱|検温/.test(c)){ const m=c.match(/(\d{2}(?:\.\d)?)(?!\d)/); if(m){const n=+m[1]; if(n>=33&&n<=43) return n;} }
         return undefined; }, fmt:v=>v.toFixed(1)+"℃",
       quick:["36度5分","37度2分"], chipRaw:true},
      {id:"bp_h", label:"血圧（上）", req:true, anchors:["血圧","上"], parse:parseIntRange(70,260), fmt:v=>v+"mmHg", quick:["血圧128の76"], chipRaw:true},
      {id:"bp_l", label:"血圧（下）", req:true, anchors:["下"], parse:parseIntRange(30,160), fmt:v=>v+"mmHg"},
      {id:"pulse", label:"脈拍", req:true, anchors:["脈拍","脈"], parse:parseIntRange(30,190), fmt:v=>v+"回/分", quick:["脈拍72"], chipRaw:true},
      {id:"spo2", label:"SpO2", req:true, anchors:["サチュレーション","spo2","酸素"], parse:parseIntRange(85,100), fmt:v=>v+"%", quick:["SpO2 98"], chipRaw:true},
      {id:"resp", label:"呼吸数", anchors:["呼吸"], parse:parseIntRange(5,60), fmt:v=>v+"回/分"},
      {id:"posture", label:"状態", self:true, parse:choice([{v:"臥位",alias:["臥位","寝たまま"]},{v:"座位",alias:["座位","座って"]}])},
      {id:"place", label:"場所", anchors:["場所"], parse:PLACE, self:true},
      {id:"comment", label:"状態コメント", freeText:true, self:true, anchors:["様子","状態","特記","コメント"],
       parse:multiChoice([{v:"問題なし",alias:["問題なし"]},{v:"問題あり",alias:["問題あり"]}])}
    ]}
};
const SCHEMA_ORDER=["vital","excretion","meal","hydration"];

/* ============ 対話エンジン v0.3: 一括発話 → 整理 → 不足確認 → 登録 ============ */
let session=null; // {key, slots{}, extraAsked, fail}
const records=[];
let voiceMode=false, noSpeech=0;

const schemaOf=()=>SCHEMAS[session.key];
const activeSlots=()=>schemaOf().slots.filter(sl=>!sl.when||sl.when(session.slots));
const missingReq=()=>activeSlots().filter(sl=>sl.req&&session.slots[sl.id]===undefined);
const fmtVal=(sl,v)=>sl.fmt?sl.fmt(v):String(v);
const sayVal=(sl,v)=>sl.say?sl.say(v):fmtVal(sl,v);
function detectSchema(t){ for(const k of SCHEMA_ORDER){ if(SCHEMAS[k].trigger.test(t)) return k; } return null; }

/* 血圧の複合パース（「128の76」「上が128下が76」を一度に） */
function extractBp(clauses){
  if(session.key!=="vital") return [];
  const filled=[];
  const need_h=session.slots.bp_h===undefined, need_l=session.slots.bp_l===undefined;
  for(const c of clauses){
    if(need_h&&need_l){
      const anchored=/血圧|BP|上/.test(c);
      const both=parseBp(c);
      if(both&&(anchored||/の/.test(c))){ session.slots.bp_h=both.u; session.slots.bp_l=both.l;
        filled.push(schemaOf().slots.find(s=>s.id==="bp_h"),schemaOf().slots.find(s=>s.id==="bp_l")); return filled; }
    }
    let m=c.match(/上[がは]?\s*(\d{2,3})/); if(m&&session.slots.bp_h===undefined&&+m[1]>=70&&+m[1]<=260){ session.slots.bp_h=+m[1]; filled.push(schemaOf().slots.find(s=>s.id==="bp_h")); }
    m=c.match(/下[がは]?\s*(\d{2,3})/); if(m&&session.slots.bp_l===undefined&&+m[1]>=30&&+m[1]<=160){ session.slots.bp_l=+m[1]; filled.push(schemaOf().slots.find(s=>s.id==="bp_l")); }
  }
  return filled;
}

/* 抽出v0.3.1:
   ①血圧複合 ②アンカー区間スキャン（「主食 全量」のようにスペースで割れても、
     項目名の位置から次の項目名までを一区間として解釈）
   ③自己アンカー（節ごと） ④裸値は pending（直前に項目名だけ言われた項目）優先、
     なければ「一意に決まる必須スロット」のみ */
function anchoredScan(t,filled){
  const act=schemaOf().slots.filter(sl=>(!sl.when||sl.when(session.slots))&&session.slots[sl.id]===undefined&&sl.id!=="bp_h"&&sl.id!=="bp_l"&&anchorsOf(sl).length);
  const low=t.toLowerCase();
  const occ=[];
  for(const sl of act){ for(const a of anchorsOf(sl)){ const al=a.toLowerCase();
    let i=low.indexOf(al);
    while(i>=0){ occ.push({i,end:i+al.length,sl}); i=low.indexOf(al,i+1); } } }
  occ.sort((x,y)=>x.i-y.i);
  for(let k=0;k<occ.length;k++){
    const o=occ[k];
    if(session.slots[o.sl.id]!==undefined) continue;
    let end=t.length;
    for(let m=k+1;m<occ.length;m++){ if(occ[m].sl.id!==o.sl.id&&occ[m].i>=o.end){ end=occ[m].i; break; } }
    const pre=t.slice(0,o.i).match(/(\d{1,4}(?:\.\d)?)\s*$/); // 「150cc」のように値が単位アンカーの前に来る場合
    const seg=(pre?pre[1]:"")+t.slice(o.i,end);
    const v=o.sl.parse(seg,false);
    if(v!==undefined){ session.slots[o.sl.id]=v; filled.push(o.sl); }
  }
}
function extract(t){
  const clauses=splitClauses(t);
  const filled=[...extractBp(clauses)];
  let ambiguous=false;
  anchoredScan(t,filled);
  for(const sl of schemaOf().slots){ // 自己アンカー（選択肢語そのものが特定的）
    if(sl.when&&!sl.when(session.slots)) continue;
    if(session.slots[sl.id]!==undefined) continue;
    if(!sl.self) continue;
    let val; for(const c of clauses){ val=sl.parse(c,false); if(val!==undefined) break; }
    if(val!==undefined){ session.slots[sl.id]=val; filled.push(sl); }
  }
  const allAnchors=schemaOf().slots.flatMap(anchorsOf);
  for(const c of clauses){
    if(NASHI.test(c)) continue;
    if(allAnchors.some(a=>c.toLowerCase().includes(a.toLowerCase()))) continue;
    if(session.pending){ // 直前に「主食」など項目名だけ言われている → その項目に束ねる
      const psl=activeSlots().find(x=>x.id===session.pending&&session.slots[x.id]===undefined);
      if(!psl){ session.pending=null; }
      else{ const v=psl.parse(c,true);
        if(v!==undefined){ session.slots[psl.id]=v; filled.push(psl);
          session.pending=(psl.id==="bp_h"&&session.slots.bp_l===undefined)?"bp_l":null; continue; } }
    }
    const cands=[];
    for(const sl of missingReq()){
      if(sl.id==="bp_h"||sl.id==="bp_l") continue;
      const v=sl.parse(c,true);
      if(v!==undefined) cands.push([sl,v]);
    }
    if(cands.length===1){ const [sl,v]=cands[0]; session.slots[sl.id]=v; filled.push(sl); }
    else if(cands.length>1){
      const pd=session.pending&&cands.find(([sl])=>sl.id===session.pending);
      if(pd){ session.slots[pd[0].id]=pd[1]; filled.push(pd[0]); session.pending=null; }
      else ambiguous=true;
    }
  }
  if(filled.length) session.pending=null;
  return {filled:[...new Set(filled)].filter(Boolean), ambiguous};
}

const echoOf=filled=>filled.map(sl=>`${sl.label}=${sayVal(sl,session.slots[sl.id])}`).join("、");

function report(prefixParts){
  renderProgress();
  const parts=[...(prefixParts||[])];
  const miss=missingReq();
  if(miss.length){
    parts.push(`残りの必須項目は【${miss.map(s=>s.label).join("・")}】です。まとめて話しても、1つずつでも大丈夫です。`);
    assistantSay(parts.join("\n"));
  }else if(!session.extraAsked){
    session.extraAsked=true;
    parts.push("必須項目はそろいました。場所・介助・状態コメントなど補足があればどうぞ。なければ「なし」で登録します。");
    assistantSay(parts.join("\n"));
  }else{
    parts.push("ほかに補足があればどうぞ。なければ「なし」で登録します。");
    assistantSay(parts.join("\n"));
  }
}

function startSession(key,initialText){
  session={key,slots:{},extraAsked:false,fail:0};
  const pre=[schemaOf().icon+" "+schemaOf().name+"の記録ですね。"];
  if(initialText){ handleExtraction(initialText,pre,true); } else { report(pre); }
}

async function handleExtraction(t,prefixParts,isInitial){
  const pre=[...(prefixParts||[])];
  let {filled,ambiguous}=extract(t);
  // AI抽出（不足が残っていれば）
  if(AI.on&&missingReq().length&&t.length>=6&&!NASHI.test(t)){
    const aiFilled=await aiExtract(t);
    if(aiFilled.length){ filled=[...filled,...aiFilled]; ambiguous=false; }
  }
  if(filled.length){ session.fail=0; pre.push("📝 "+echoOf(filled)); }
  if(ambiguous){ const m0=missingReq()[0];
    pre.push(`※どの項目か特定できない値がありました。「${m0?m0.label:"項目名"}は◯◯」のように項目名を付けてどうぞ。`); }
  if(!filled.length&&!ambiguous&&!isInitial){
    if(session.extraAsked){
      const cm=activeSlots().find(s=>s.freeText&&session.slots[s.id]===undefined);
      if(cm&&!NASHI.test(t)){ session.slots[cm.id]=t; pre.push(`📝 ${cm.label}=${t}`); }
      else if(!NASHI.test(t)){ session.fail++; pre.push("すみません、聞き取れませんでした。"); }
    }else if(!NASHI.test(t)){
      // 「主食」など項目名だけの発話 → その項目の値待ちモード（単語単位の入力に対応）
      const th=kataToHira(t.toLowerCase());
      const hits=activeSlots().filter(sl=>session.slots[sl.id]===undefined&&
        anchorsOf(sl).some(a=>(a.length>=2&&th.includes(kataToHira(a.toLowerCase())))||t===a));
      if(hits.length>=1){
        const sl=hits[0];
        session.pending=(sl.id==="bp_l"&&session.slots.bp_h===undefined)?"bp_h":sl.id;
        session.fail=0;
        pre.push(`${sl.label}ですね。値をどうぞ${sl.quick?`（例：${sl.quick.slice(0,3).join("、")}）`:""}。`);
        renderProgress(); assistantSay(pre.join("\n")); return;
      }
      session.fail++;
      pre.push("すみません、聞き取れませんでした。"+(session.fail>=2?"\n下の選択肢ボタンからも入力できます。":""));
    }
  }
  report(pre);
}

function complete(prefixParts){
  const sc=schemaOf();
  const rows=activeSlots().filter(sl=>session.slots[sl.id]!==undefined)
    .map(sl=>({k:sl.label, v:fmtVal(sl,session.slots[sl.id])}));
  const rec={schema:sc.name, icon:sc.icon, time:new Date(), staff:STAFF, rows};
  records.push(rec); $("recCount").textContent=records.length;
  session=null;
  const parts=[...(prefixParts||[])];
  const summary=rows.slice(0,5).map(r=>`${r.k} ${r.v}`).join("、")+(rows.length>5?" ほか":"");
  parts.push(`✅ 登録しました：${sc.name}（${summary}）`);
  assistantSay(parts.join("\n"),true);
  addCard(rec);
  renderProgress();
}

function handleCorrection(rest){
  if(!rest){
    const done=activeSlots().filter(s=>session.slots[s.id]!==undefined&&s.id!=="resident");
    if(!done.length){ report(["取り消す項目がありません。"]); return; }
    const last=done[done.length-1];
    delete session.slots[last.id];
    report([`${last.label}を取り消しました。`]); return;
  }
  const clauses=splitClauses(rest);
  for(const sl of activeSlots()){
    for(const c of clauses){
      const anchored=sl.self||(sl.anchors||[]).some(a=>c.toLowerCase().includes(a.toLowerCase()));
      if(!anchored) continue;
      const v=sl.parse(c,true);
      if(v!==undefined){ session.slots[sl.id]=v; report([`${sl.label}を「${sayVal(sl,v)}」に修正しました。`]); return; }
    }
  }
  report(["修正先が分かりませんでした。「主食は7割」のように項目名も添えてください。"]);
}

async function process(raw){
  const t=careFix(norm(raw)); if(!t) return;   // 用語集グロッサリで介護用語の同音誤変換を補正
  if(session){
    if(/キャンセル|中止|やめて|やめる/.test(t)){ session=null; renderProgress();
      assistantSay("記録を破棄しました。「食事」「排泄」などと話しかけてください。",true); return; }
    if(/最初から|初めから|はじめから/.test(t)){ startSession(session.key); return; }
    if(/^(戻る|戻って|ひとつ戻|取り消し)/.test(t)){ handleCorrection(""); return; }
    if(/^(登録|保存|記録して|登録して|保存して)$/.test(t)){
      if(missingReq().length){ report([`必須項目【${missingReq().map(s=>s.label).join("・")}】がまだです。`]); }
      else complete([]); return; }
    const corr=t.match(/^(?:やっぱり|やっぱ|訂正|間違い|間違えた|違う|修正)[、。\s]*(.*)$/);
    if(corr){ if(corr[1]) handleCorrection(corr[1]); else handleCorrection(""); return; }
    if(/記録/.test(t)){
      const k=detectSchema(t);
      if(k&&k!==session.key){ addBubble("sys",schemaOf().name+"を中断しました"); startSession(k,t); return; }
      if(k&&k===session.key){ startSession(k,t); return; }
    }
    if(session.extraAsked&&NASHI.test(t)){ complete([]); return; }
    await handleExtraction(t);
  }else{
    const key=detectSchema(t);
    if(key){ startSession(key,t); }
    else{
      assistantSay("「食事」「水分」「排泄」「バイタル」のいずれかの記録に対応しています。\n例：「田中さんの昼食、主食8割、副食全量、お茶150cc、むせ込みなし」のように一気に話すと、足りない項目だけ確認します。");
    }
  }
}

/* ============ AI抽出（Gemini・任意） ============ */
const AI={on:false,key:"",model:"gemini-2.5-flash"};
function slotSpec(sl){
  const spec={id:sl.id,label:sl.label,required:!!sl.req};
  if(sl.id==="resident") spec.values=RESIDENTS.map(r=>r.name);
  else if(sl.parse===parseRatio) spec.values=["全量","10割","9割","8割","7割","6割","5割","4割","3割","2割","1割","0割","３分の２","２分の１","３分の１","極少量","なし","欠食","拒食"];
  else if(sl.parse===parseCc) spec.format="数値(cc)";
  else if(sl.parse===parseTemp) spec.format="数値(℃ 例36.5)";
  else if(sl.id==="bp_h") spec.format="数値(収縮期mmHg)";
  else if(sl.id==="bp_l") spec.format="数値(拡張期mmHg)";
  else if(sl.id==="pulse") spec.format="数値(回/分)";
  else if(sl.id==="spo2") spec.format="数値(%)";
  else if(sl.id==="resp") spec.format="数値(回/分)";
  else if(sl.freeText) spec.format="短い自由文（該当があれば）";
  else if(sl.choicesSpec) spec.values=sl.choicesSpec;
  return spec;
}
function validateAi(sl,v){
  if(v===null||v===undefined||v==="") return undefined;
  if(sl.id==="resident"){ return parseResident(String(v)); }
  if(sl.parse===parseRatio){ return parseRatio(String(v),false)!==undefined?parseRatio(String(v),false):undefined; }
  if(sl.parse===parseCc){ const n=parseInt(v,10); return (n>=5&&n<=2000)?n:undefined; }
  if(sl.parse===parseTemp){ const n=parseFloat(v); return (n>=33&&n<=43)?Math.round(n*10)/10:undefined; }
  if(sl.id==="bp_h"){ const n=parseInt(v,10); return (n>=70&&n<=260)?n:undefined; }
  if(sl.id==="bp_l"){ const n=parseInt(v,10); return (n>=30&&n<=160)?n:undefined; }
  if(sl.id==="pulse"){ const n=parseInt(v,10); return (n>=30&&n<=190)?n:undefined; }
  if(sl.id==="spo2"){ const n=parseInt(v,10); return (n>=70&&n<=100)?n:undefined; }
  if(sl.id==="resp"){ const n=parseInt(v,10); return (n>=5&&n<=60)?n:undefined; }
  if(sl.freeText){ const s=String(v).slice(0,120); return s||undefined; }
  const parsed=sl.parse(String(v),true);
  return parsed;
}
async function aiExtract(utterance){
  const th=addBubble("think","🤖 AIが内容を整理しています…");
  try{
    const slots=activeSlots().filter(sl=>session.slots[sl.id]===undefined).map(slotSpec);
    const prompt=`あなたは介護記録の音声入力支援AIです。職員の発話から記録項目の値を抽出してください。
- 音声認識の同音異義語の誤変換（例:「全寮」→「全量」「感触」→「完食」）は文脈で補正する
- 介護の正式用語（用語集）に正規化する。用語例：${CARE_TERMS_JA.slice(0,16).join("、")} 等
- 値は必ず候補(values)または形式(format)に正規化する。読み取れない項目はnull
- 発話に含まれない項目を推測で埋めない
- JSONのみを返す: {"slots": {"<id>": <値またはnull>, ...}}
記録種別: ${schemaOf().name}
項目定義: ${JSON.stringify(slots,null,0)}
発話: 「${utterance}」`;
    const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),15000);
    const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(AI.model)}:generateContent?key=${encodeURIComponent(AI.key)}`,{
      method:"POST", headers:{"Content-Type":"application/json"}, signal:ctrl.signal,
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:"application/json"}})});
    clearTimeout(timer);
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data=await res.json();
    const text=data.candidates&&data.candidates[0]&&data.candidates[0].content.parts[0].text||"{}";
    const out=JSON.parse(text);
    const filled=[];
    for(const sl of activeSlots()){
      if(session.slots[sl.id]!==undefined) continue;
      if(!out.slots||out.slots[sl.id]===undefined) continue;
      const v=validateAi(sl,out.slots[sl.id]);
      if(v!==undefined){ session.slots[sl.id]=v; filled.push(sl); }
    }
    th.remove(); return filled;
  }catch(e){
    th.remove(); addBubble("sys","AI抽出に接続できませんでした（ルール解析のみ）: "+e.message);
    return [];
  }
}

/* ============ UI ============ */
function addBubble(cls,text){
  const d=document.createElement("div"); d.className="msg "+cls; d.textContent=text;
  $("chat").appendChild(d); $("chat").scrollTop=$("chat").scrollHeight; return d;
}
function cardEl(rec){
  const d=document.createElement("div"); d.className="card";
  const hh=document.createElement("div"); hh.className="chead";
  hh.innerHTML=`<span>${rec.icon} ${rec.schema}</span><span>${rec.time.getHours()}:${String(rec.time.getMinutes()).padStart(2,"0")} / 記録者:${rec.staff}</span>`;
  d.appendChild(hh);
  const tb=document.createElement("table");
  rec.rows.forEach(r=>{ const tr=document.createElement("tr");
    tr.innerHTML=`<td class="k"></td><td class="v"></td>`;
    tr.querySelector(".k").textContent=r.k; tr.querySelector(".v").textContent=r.v; tb.appendChild(tr); });
  d.appendChild(tb); return d;
}
function addCard(rec){ $("chat").appendChild(cardEl(rec)); $("chat").scrollTop=$("chat").scrollHeight; }
function renderProgress(){
  const p=$("progress");
  if(!session){ p.style.display="none"; renderChips(); return; }
  p.style.display="block";
  $("pname").textContent=schemaOf().icon+" "+schemaOf().name+"（CWマスタ準拠）";
  const pills=$("pills"); pills.innerHTML="";
  for(const sl of activeSlots()){
    const v=session.slots[sl.id];
    if(v===undefined&&!sl.req) continue; // 任意は入力済みのみ表示
    const el=document.createElement("span");
    el.className="pill"+(v!==undefined?" done":" miss");
    el.textContent=v!==undefined?`${sl.label}: ${fmtVal(sl,v)}`:sl.label;
    if(v!==undefined&&sl.id!=="resident"){
      el.title="タップで取り消して言い直し";
      el.onclick=()=>{ delete session.slots[sl.id]; report([`${sl.label}を取り消しました。言い直してください。`]); };
    }
    pills.appendChild(el);
  }
  renderChips();
}
function renderChips(){
  const box=$("chips"); box.innerHTML="";
  const mk=(label,text,cls)=>{ const b=document.createElement("button");
    b.className="chip"+(cls?" "+cls:""); b.textContent=label;
    b.onclick=()=>submit(text||label); box.appendChild(b); };
  if(session){
    const miss=missingReq();
    if(miss.length){
      const sl=miss[0];
      (sl.quick||[]).forEach(q=>mk(sl.chipRaw?q:((sl.chipPrefix||sl.label)+q), sl.chipRaw?q:((sl.chipPrefix||sl.label)+q)));
    }else{
      mk("なし（登録する）","なし","go"); mk("むせ込みあり"); mk("全介助","介助は全介助"); mk("食堂","場所は食堂");
    }
    mk("キャンセル","キャンセル","ghost");
  }else{
    mk("🍚 食事","食事記録"); mk("🍵 水分","水分記録"); mk("🚻 排泄","排泄記録"); mk("🩺 バイタル","バイタル記録");
    mk("試す: 一気に話す例","田中さんの昼食、主食8割、副食全量、お茶150cc、むせ込みなし","ghost");
  }
}

/* ============ 音声（TTS / STT） ============ */
const synth=window.speechSynthesis;
let ttsOn=true, autoOn=true, jaVoice=null;
function pickVoice(){ if(!synth) return;
  const vs=synth.getVoices().filter(v=>v.lang&&v.lang.startsWith("ja"));
  jaVoice=vs.find(v=>/Google|Nanami|Kyoko/i.test(v.name))||vs[0]||null; }
if(synth){ pickVoice(); synth.onvoiceschanged=pickVoice; }
function speak(text,onend){
  if(!ttsOn||!synth){ onend&&onend(); return; }
  synth.cancel();
  const u=new SpeechSynthesisUtterance(text.replace(/[🍚🍵🚻🩺📝✅※🤖]/g,"").replace(/【|】/g,""));
  u.lang="ja-JP"; if(jaVoice) u.voice=jaVoice; u.rate=1.08;
  u.onend=()=>onend&&onend(); u.onerror=()=>onend&&onend();
  synth.speak(u);
}
function assistantSay(text,endOfSession){
  addBubble("ai",text);
  renderProgress();
  speak(text,()=>{
    if(!autoOn||!voiceMode) return;
    const reopen = isScribe()
      ? ()=>{ if(!recording) startRecording(); }
      : ()=>{ if(SR&&!listening) startListening(); };
    if(session) reopen();
    else if(endOfSession&&noSpeech===0) reopen();
  });
}
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let rec=null, listening=false, listenBubble=null, finalText="";
function startListening(){
  if(!SR||listening) return;
  try{ rec=new SR(); }catch(e){ return; }
  rec.lang="ja-JP"; rec.interimResults=true; rec.maxAlternatives=1; rec.continuous=false;
  listening=true; finalText="";
  $("mic").classList.add("rec");
  listenBubble=addBubble("listen","🎤 聞き取り中…（長く話してOK）");
  rec.onresult=e=>{
    let interim="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal) finalText+=e.results[i][0].transcript;
      else interim+=e.results[i][0].transcript;
    }
    if(listenBubble) listenBubble.textContent="🎤 "+(finalText||interim||"聞き取り中…");
  };
  rec.onerror=e=>{
    if(e.error==="not-allowed"||e.error==="service-not-allowed"){
      showBanner("マイクの使用が許可されていません。ブラウザのマイク許可をご確認ください（テキスト入力は利用できます）。");
    }
  };
  rec.onend=()=>{
    listening=false; $("mic").classList.remove("rec");
    if(listenBubble){ listenBubble.remove(); listenBubble=null; }
    const t=finalText.trim();
    if(t){ voiceMode=true; noSpeech=0; submit(t,true); }
    else{
      noSpeech++;
      if(autoOn&&voiceMode&&session&&noSpeech<2){ startListening(); }
      else if(noSpeech>=2){ addBubble("sys","無音のため待機します。マイクをタップして再開できます。"); }
    }
  };
  rec.start();
}
function stopListening(){ if(rec&&listening){ try{rec.stop();}catch(e){} } }

/* ============ Scribe Cloud 統合（多言語音声入力） ============
   日本語=ブラウザ音声認識（即時・上のstartListening）。
   英/中/馬/泰/緬=マイク録音→16k WAV→Scribe /transcribe（認識＋日本語へ翻訳）→対話エンジンへ。
   ルーティングは Scribe の offscreen.js に準拠：緬(my)=HF Space、他=Cloudflare Worker。 */
const SCRIBE_CF    = "https://scribe-cloud.singapore2026123.workers.dev";    // Whisper /transcribe（en/ja/ms/zh/ta）
const SCRIBE_SPACE = "https://singapore2026123-scribe-burmese-asr.hf.space"; // SeamlessM4T（緬 my）
const REC_LANG  = "ja";   // 記録・対話言語。外国語音声はここへ翻訳して抽出する
const LANG_MODE = { ja:"browser", en:"scribe", zh:"scribe", ms:"scribe", ta:"scribe", my:"scribe" };
let inputLang = "ja";
const isScribe = ()=>LANG_MODE[inputLang]==="scribe";
$("langSel").addEventListener("change", e=>{
  inputLang=e.target.value;
  if(listening) stopListening();
  if(recording) stopRecording();
  const lbl=e.target.options[e.target.selectedIndex].text.replace(/^[🎙☁]\s*/,"");
  addBubble("sys", `入力言語：${lbl} ` + (isScribe()
    ? "→ Scribe Cloudで認識し日本語へ翻訳して記録します"
    : "→ ブラウザ音声認識（即時）"));
  $("mic").disabled = (LANG_MODE[inputLang]==="browser" && !SR);
});

/* マイク録音（ScriptProcessor）→ 無音で自動停止 → WAV/base64 → Scribe */
let scCtx=null, scStream=null, scProc=null, scSrc=null, scBuf=[], scLen=0, recording=false, scSil=0, scHad=false;
const SC_SIL_THRESH=0.008, SC_SIL_HOLD=0.8, SC_MIN_SEC=1.2, SC_MAX_SEC=16.0;
async function startRecording(){
  if(recording) return;
  try{ scStream=await navigator.mediaDevices.getUserMedia({audio:true}); }
  catch(e){ showBanner("マイクを使用できません: "+e.message); return; }
  scCtx=new (window.AudioContext||window.webkitAudioContext)();
  try{ await scCtx.resume(); }catch(e){}
  scBuf=[]; scLen=0; scSil=0; scHad=false; recording=true;
  scSrc=scCtx.createMediaStreamSource(scStream);
  scProc=scCtx.createScriptProcessor(4096,1,1);
  scProc.onaudioprocess=(e)=>{
    if(!recording) return;
    const d=e.inputBuffer.getChannelData(0);
    scBuf.push(new Float32Array(d)); scLen+=d.length;
    let s=0; for(let i=0;i<d.length;i++) s+=d[i]*d[i];
    const rms=Math.sqrt(s/d.length), sr=scCtx.sampleRate;
    if(rms>=SC_SIL_THRESH){ scHad=true; scSil=0; } else scSil+=d.length;
    const secs=scLen/sr, sil=scSil/sr;
    if(scHad && secs>=SC_MIN_SEC && sil>=SC_SIL_HOLD) stopRecording();   // 発話後の無音で自動確定
    else if(secs>=SC_MAX_SEC) stopRecording();                          // 連続発話の上限
  };
  scSrc.connect(scProc); scProc.connect(scCtx.destination);
  $("mic").classList.add("rec");
  listenBubble=addBubble("listen","🎤 録音中…（話し終えると自動で認識／もう一度タップで停止）");
}
function stopRecording(){
  if(!recording) return;
  recording=false;
  const sr=scCtx?scCtx.sampleRate:48000;
  const merged=new Float32Array(scLen); let o=0; for(const b of scBuf){ merged.set(b,o); o+=b.length; }
  scBuf=[]; scLen=0;
  try{ if(scProc){ scProc.onaudioprocess=null; scProc.disconnect(); } }catch(e){}
  try{ if(scSrc) scSrc.disconnect(); }catch(e){}
  try{ if(scStream) scStream.getTracks().forEach(t=>t.stop()); }catch(e){}
  try{ if(scCtx) scCtx.close(); }catch(e){}
  scProc=scSrc=scStream=scCtx=null;
  $("mic").classList.remove("rec");
  if(listenBubble){ listenBubble.remove(); listenBubble=null; }
  if(scHad && merged.length>sr*0.3){ scTranscribe(merged,sr); }
  else{ noSpeech++; if(noSpeech>=2) addBubble("sys","音声が検出できませんでした。マイクをタップして再開できます。"); }
}
async function scTranscribe(samples,sr){
  const th=addBubble("think","☁ Scribe Cloud で認識・翻訳中…"+(inputLang==="my"?"（緬：初回はSpace起動に時間がかかることがあります）":""));
  try{
    const b64=encodeWavB64(resampleTo16k(samples,sr),16000);
    const url=(inputLang==="my"?SCRIBE_SPACE:SCRIBE_CF)+"/transcribe";
    const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),60000);
    const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},signal:ctrl.signal,
      body:JSON.stringify({audio:b64, src:inputLang, target:REC_LANG})});
    clearTimeout(timer);
    if(!res.ok) throw new Error("HTTP "+res.status);
    const d=await res.json();
    th.remove();
    const orig=(d.transcript||"").trim(), jp=(d.translation||"").trim();
    if(!orig && !jp){ addBubble("sys","認識できませんでした（無音／ノイズの可能性）。"+(d.error?" — "+d.error:"")); return; }
    addBubble("user", orig + (jp ? `\n🌐 ${jp}` : ""));   // 原言語＋日本語訳を表示
    voiceMode=true; noSpeech=0;
    const forEngine = jp || orig;                          // 日本語訳を対話エンジンへ
    if(forEngine) process(forEngine);
    else addBubble("sys","日本語訳が取得できませんでした。");
  }catch(e){
    th.remove(); addBubble("sys","Scribe 接続に失敗しました: "+e.message);
  }
}
/* WAV helpers（Scribe の offscreen.js より流用：16kHzモノラルにダウンサンプル→WAV→base64） */
function resampleTo16k(samples,sr){
  if(sr===16000) return samples;
  const ratio=sr/16000, outLen=Math.floor(samples.length/ratio), out=new Float32Array(outLen);
  for(let i=0;i<outLen;i++) out[i]=samples[Math.floor(i*ratio)];
  return out;
}
function encodeWavB64(samples,sr){
  const buffer=new ArrayBuffer(44+samples.length*2), view=new DataView(buffer);
  const w=(o,s)=>{ for(let i=0;i<s.length;i++) view.setUint8(o+i,s.charCodeAt(i)); };
  w(0,"RIFF"); view.setUint32(4,36+samples.length*2,true); w(8,"WAVE"); w(12,"fmt ");
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sr,true); view.setUint32(28,sr*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  w(36,"data"); view.setUint32(40,samples.length*2,true);
  let o=44; for(let i=0;i<samples.length;i++){ let s=Math.max(-1,Math.min(1,samples[i])); view.setInt16(o,s<0?s*0x8000:s*0x7fff,true); o+=2; }
  let bin=""; const bytes=new Uint8Array(buffer); for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* ============ 入出力 ============ */
function submit(text,fromVoice){
  if(!fromVoice){ voiceMode=false; noSpeech=0; if(synth) synth.cancel(); stopListening(); }
  addBubble("user",text);
  process(text);
}
$("send").onclick=()=>{ const v=$("ti").value.trim(); if(v){ $("ti").value=""; submit(v); } };
$("ti").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("send").onclick(); } });
$("mic").onclick=()=>{
  if(isScribe()){
    if(recording){ stopRecording(); } else { if(synth) synth.cancel(); voiceMode=true; startRecording(); }
  }else{
    if(listening){ stopListening(); } else { if(synth) synth.cancel(); voiceMode=true; startListening(); }
  }
};
$("btnTts").onclick=()=>{ ttsOn=!ttsOn; $("btnTts").classList.toggle("on",ttsOn); if(!ttsOn&&synth) synth.cancel(); };
$("btnAuto").onclick=()=>{ autoOn=!autoOn; $("btnAuto").classList.toggle("on",autoOn); };
$("btnRecs").onclick=()=>{
  const p=$("recpanel"), inner=$("recinner"); inner.innerHTML="";
  const h=document.createElement("div"); h.style.cssText="font-weight:700;font-size:14px;";
  h.textContent=`本日の記録（${records.length}件） — タップで閉じる`; inner.appendChild(h);
  if(!records.length){ const e=document.createElement("div"); e.style.cssText="color:#68758a;font-size:13px;"; e.textContent="まだ記録がありません。"; inner.appendChild(e); }
  [...records].reverse().forEach(r=>{ const c=cardEl(r); c.style.alignSelf="stretch"; c.style.maxWidth="100%"; inner.appendChild(c); });
  p.style.display="block"; p.onclick=()=>{ p.style.display="none"; };
};
function showBanner(msg){ const b=$("banner"); b.textContent=msg; b.style.display="block"; }

/* ============ AI設定 ============ */
function refreshAiState(){
  AI.on=$("aiOn").checked; AI.key=$("aiKey").value.trim(); AI.model=$("aiModel").value.trim()||"gemini-2.5-flash";
  if(AI.on&&!AI.key){ $("aistate").textContent="⚠ キー未入力"; $("aistate").style.color="#b45309"; AI.on=false; }
  else if(AI.on){ $("aistate").textContent="✅ 有効"; $("aistate").style.color="#0f6e5d"; }
  else { $("aistate").textContent="オフ（ルール解析）"; $("aistate").style.color="#68758a"; }
  $("btnAI").classList.toggle("on",AI.on);
  try{
    if($("aiSave").checked){ localStorage.setItem("ct_ai",JSON.stringify({on:$("aiOn").checked,key:AI.key,model:AI.model,save:true})); }
    else localStorage.removeItem("ct_ai");
  }catch(e){}
}
$("btnAI").onclick=()=>{ const s=$("settings"); s.style.display=s.style.display==="block"?"none":"block"; };
["aiOn","aiKey","aiModel","aiSave"].forEach(id=>$(id).addEventListener("change",refreshAiState));
try{
  const saved=JSON.parse(localStorage.getItem("ct_ai")||"null");
  if(saved){ $("aiOn").checked=!!saved.on; $("aiKey").value=saved.key||""; $("aiModel").value=saved.model||"gemini-2.5-flash"; $("aiSave").checked=true; }
}catch(e){}
refreshAiState();

/* ============ 起動 ============ */
if(!SR){
  showBanner("このブラウザはブラウザ音声認識に非対応です。日本語はテキスト入力を、英/中/馬/泰/緬は上部の言語選択でScribe Cloud音声入力をご利用ください（Chrome/Edge推奨）。");
  if(LANG_MODE[inputLang]==="browser") $("mic").disabled=true;   // 日本語ブラウザ認識のみ無効化。Scribe言語はマイク可
}
addBubble("ai","こんにちは、"+STAFF+"さん。ケアトーク × Scribe Cloud v0.4.0 です（CWマスタ準拠：食事・水分補給・排泄・バイタル）。\n\n■ 多言語音声入力（NEW）\n・右上の言語ボタンで話す言語を選べます：🎙日本語（ブラウザ即時）／☁英・中・馬・泰・緬\n・☁言語は Scribe Cloud が音声を認識し、日本語へ翻訳してから記録します\n　例：ミャンマー人職員がビルマ語で話す → 日本語の記録に整理\n・☁は話し終えると自動で認識します（緬は初回の起動に少し時間がかかります）\n\n■ 使い方（一括発話方式）\n・マイク🎤をタップして、知っている内容を一気に話してください\n　例：「田中さんの昼食、主食8割、副食全量、お茶150cc」\n・単語ずつでもOK：「主食」→「全量」のように区切って話せます\n・内容を整理し、足りない必須項目だけ確認します\n・最後に補足（場所・介助・状態コメント）を聞いて、まとめて登録します\n・言い直しは「やっぱり主食は7割」／中止は「キャンセル」\n\n■ ⚙AI ボタンから Gemini APIキーを設定すると、AIが発話全体を解釈し、誤変換（全寮→全量など）も文脈で補正します（任意）。");
renderChips();
