import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

function firebaseReady() {
  return Boolean(process.env.FIREBASE_DATABASE_URL && process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

function db() {
  if (!firebaseReady()) throw new Error('Firebase ortam değişkenleri eksik.');

  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON geçerli JSON değil.');
    }
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
  return getDatabase();
}

const MAX_MODS = 3000000;

function DEFAULTS() {
  return {
    settings: {
      siteName:'Emir Mods', discordUrl:'', heroTitle:'Emir Mods',
      heroText:'GTA V ve LSPDFR modları', supportText:'Emir Mods topluluğuna destek olun.',
      aboutText:'Emir Mods hakkında bilgi.', contactText:'Bizimle iletişime geçin.',
      paidSetupText:'Ücretli kurulum hizmeti.', legalText:'Yasal bilgiler.', footerText:'© Emir Mods',
      supportTitle:'DESTEKÇİLER', aboutTitle:'HAKKIMIZDA', contactTitle:'İLETİŞİM',
      paidSetupTitle:'ÜCRETLİ KURULUM', legalTitle:'YASAL', supporters:'',
      sellerName:'', sellerIban:'', sellerBank:'', sellerCardLink:'',
      notification1Title:'Yeni araç modu!', notification1Text:'Yeni araç modları yakında.',
      notification2Title:'Yeni modlar yakında', notification2Text:'Emir Mods güncelleniyor.',
      notification3Title:'Emir Mods güncellendi', notification3Text:'Yeni içerikler eklendi.',
      nav0:'ANA SAYFA', nav1:'MODLAR', nav2:'ARAÇ LİSTESİ', nav3:'DESTEKÇİLER',
      nav4:'HAKKIMIZDA', nav5:'İLETİŞİM', nav6:'DISCORD', nav7:'ÜCRETLİ KURULUM', nav8:'YASAL'
    },
    categories:['Polis Modları','Ücretli Araçlar','Ücretsiz Araçlar','Scriptler','Pluginler','Harita','Kaplama','Diğer'],
    mods:[]
  };
}

async function getPublicConfig() {
  const database = db();
  const snap = await database.ref('emirMods').once('value');
  const value = snap.val() || {};
  const d = DEFAULTS();
  return {
    settings:{...d.settings,...(value.settings||{})},
    categories:Array.isArray(value.categories)?value.categories:d.categories,
    mods:Array.isArray(value.mods)?value.mods:d.mods
  };
}

async function saveConfig(payload) {
  const database = db();
  const d = DEFAULTS();
  const settings = payload?.settings && typeof payload.settings === 'object' ? payload.settings : d.settings;
  const categories = Array.isArray(payload?.categories) ? payload.categories : d.categories;
  const mods = Array.isArray(payload?.mods) ? payload.mods : [];
  if (mods.length > MAX_MODS) throw Error('En fazla 3.000.000 mod olabilir.');
  await database.ref('emirMods').update({settings,categories,mods});
  return {settings,categories,mods};
}

function cleanId(value) {
  const s=String(value||'').trim();
  return s.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,120)||`visitor_${Date.now()}`;
}

async function recordVisitor(body, req) {
  const database=db(), id=cleanId(body?.visitorId);
  const ref=database.ref(`emirMods/visitors/${id}`);
  const snap=await ref.once('value'), old=snap.val()||{}, now=Date.now();
  await ref.set({
    visitorId:id, firstSeen:old.firstSeen||now, lastSeen:now,
    visits:Number(old.visits||0)+1,
    path:String(body?.path||'/').slice(0,500),
    userAgent:String(req.headers['user-agent']||'').slice(0,500)
  });
  return {ok:true};
}

async function updateVisitor(body) {
  const id=cleanId(body?.visitorId);
  if(!id) throw Error('Ziyaretçi kimliği gerekli.');
  const ref=db().ref(`emirMods/visitors/${id}`);
  const snap=await ref.once('value');
  if(!snap.exists()) throw Error('Ziyaretçi bulunamadı.');
  const old=snap.val()||{};
  const updates={};
  if(body?.path!==undefined) updates.path=String(body.path||'/').slice(0,500);
  if(body?.visits!==undefined) updates.visits=Math.max(0,Number(body.visits)||0);
  await ref.update(updates);
  return {ok:true,visitor:{...old,...updates}};
}

async function deleteVisitor(body) {
  const id=cleanId(body?.visitorId);
  if(!id) throw Error('Ziyaretçi kimliği gerekli.');
  await db().ref(`emirMods/visitors/${id}`).remove();
  return {ok:true};
}

async function listVisitors() {
  const snap=await db().ref('emirMods/visitors').orderByChild('lastSeen').limitToLast(500).once('value');
  const value=snap.val()||{};
  return Object.values(value).sort((a,b)=>Number(b.lastSeen||0)-Number(a.lastSeen||0));
}

async function verifyUser(req) {
  const header=req.headers.authorization||'';
  const match=String(header).match(/^Bearer\s+(.+)$/i);
  if(!match) return null;
  const token=match[1];

  // 1) Firebase ID token (yedek/ayrı Firebase girişi)
  try {
    const decoded=await getAuth().verifyIdToken(token);
    if(decoded.email_verified) return decoded;
  } catch {}

  // 2) Sitenin mevcut Google girişindeki OAuth access token.
  // Böylece kullanıcı ikinci kez Google/Firebase girişi yapmak zorunda kalmaz.
  try {
    const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{
      headers:{Authorization:'Bearer '+token,Accept:'application/json'}
    });
    if(!r.ok) return null;
    const u=await r.json();
    if(!u.email || u.email_verified===false) return null;
    return {
      uid:'google:'+String(u.sub||u.email),
      sub:u.sub,
      email:u.email,
      email_verified:true,
      name:u.name||''
    };
  } catch { return null; }
}


async function uploadMemberImage(body, req) {
  const user=await verifyUser(req);
  if(!user) throw Object.assign(new Error('Gmail ile giriş yapmalısın.'),{statusCode:401});
  const image=String(body?.image||'');
  const mime=String(body?.mime||'image/webp').slice(0,100);
  if(!/^data:image\/(webp|jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    throw Object.assign(new Error('Geçersiz fotoğraf verisi.'),{statusCode:400});
  }
  const base64=image.split(',')[1]||'';
  if(base64.length>2800000) throw Object.assign(new Error('Fotoğraf otomatik olarak küçültülemedi; daha küçük bir fotoğraf seç.'),{statusCode:413});
  const id=`img_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
  await db().ref(`emirMods/memberImageUploads/${user.uid}/${id}`).set({data:image,mime,createdAt:Date.now()});
  return {ok:true,id};
}

async function memberImageResponse(req,res) {
  const id=String(req.query?.id||'').trim();
  const index=Math.max(0,Number(req.query?.i||0));
  if(!id) return res.status(400).send('Eksik görsel kimliği.');
  const snap=await db().ref(`emirMods/memberImages/${id}/${index}`).once('value');
  if(!snap.exists()) return res.status(404).send('Görsel bulunamadı.');
  const value=snap.val()||{};
  const data=String(value.data||'');
  const m=data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if(!m) return res.status(404).send('Görsel verisi geçersiz.');
  const buffer=Buffer.from(m[2],'base64');
  res.setHeader('Content-Type',m[1]);
  res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  return res.status(200).send(buffer);
}

async function submitMemberMod(body, req) {
  const user=await verifyUser(req);
  if(!user) throw Object.assign(new Error('Gmail ile giriş yapmalısın.'),{statusCode:401});
  const category=String(body?.category||'').trim();
  if(!category || category==='Ücretli Araçlar') throw Object.assign(new Error('Geçerli ve ücretsiz bir kategori seçmelisin.'),{statusCode:400});
  const name=String(body?.name||'').trim();
  const link=String(body?.link||'').trim();
  const imageIds=Array.isArray(body?.imageIds)?body.imageIds.slice(0,5).map(String):[];
  if(!name || !link) throw Object.assign(new Error('Mod adı ve indirme linki gerekli.'),{statusCode:400});
  if(!imageIds.length) throw Object.assign(new Error('En az 1 fotoğraf gerekli.'),{statusCode:400});
  const database=db();
  const id=`member_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
  const images=[];
  for(let i=0;i<imageIds.length;i++) {
    const snap=await database.ref(`emirMods/memberImageUploads/${user.uid}/${cleanId(imageIds[i])}`).once('value');
    if(!snap.exists()) throw Object.assign(new Error('Fotoğraf yükleme kaydı bulunamadı.'),{statusCode:400});
    const value=snap.val()||{};
    await database.ref(`emirMods/memberImages/${id}/${i}`).set({data:String(value.data||''),mime:String(value.mime||'image/webp')});
    images.push(`https://emir-mods.vercel.app/api/site?action=memberImage&id=${encodeURIComponent(id)}&i=${i}`);
    await snap.ref.remove();
  }
  const item={id,name,desc:String(body?.desc||'').slice(0,2000),cat:category,link,image:images[0]||'',images,version:String(body?.version||'1.0'),size:String(body?.size||'-'),type:'free',status:'pending',submittedAt:Date.now(),submittedBy:{uid:user.uid,email:String(user.email||'')}};
  await database.ref(`emirMods/memberSubmissions/${id}`).set(item);
  return {ok:true,status:'pending',id};
}

async function listMemberMods() {
  const snap=await db().ref('emirMods/memberSubmissions').once('value');
  const v=snap.val()||{};
  return Object.values(v).sort((a,b)=>Number(b.submittedAt||0)-Number(a.submittedAt||0));
}

async function reviewMemberMod(body, approve) {
  const id=String(body?.id||'').trim();
  if(!id) throw Object.assign(new Error('Mod kimliği gerekli.'),{statusCode:400});
  const ref=db().ref(`emirMods/memberSubmissions/${id}`);
  const snap=await ref.once('value');
  if(!snap.exists()) throw Object.assign(new Error('Üye modu bulunamadı.'),{statusCode:404});
  const item=snap.val();
  if(approve) {
    const publicItem={...item,status:'approved',approvedAt:Date.now(),submittedBy:undefined};
    delete publicItem.submittedBy;
    const modsSnap=await db().ref('emirMods/mods').once('value');
    const mods=Array.isArray(modsSnap.val())?modsSnap.val():[];
    if(!mods.some(m=>String(m.id)===String(item.id))) mods.push(publicItem);
    await db().ref('emirMods').update({mods});
    await ref.update({status:'approved',approvedAt:Date.now()});
  } else {
    const rejectionReason=String(body?.rejectionReason||'').trim().slice(0,2000);
    if(!rejectionReason) throw Object.assign(new Error('Reddetme nedeni gerekli.'),{statusCode:400});
    await ref.update({status:'rejected',rejectedAt:Date.now(),rejectionReason});
  }
  return {ok:true,status:approve?'approved':'rejected',rejectionReason:approve?'':String(body?.rejectionReason||'').trim()};
}

async function deleteMemberMod(body) {
  const id=String(body?.id||'').trim();
  if(!id) throw Object.assign(new Error('Mod kimliği gerekli.'),{statusCode:400});
  const ref=db().ref(`emirMods/memberSubmissions/${id}`);
  const snap=await ref.once('value');
  if(!snap.exists()) throw Object.assign(new Error('Üye modu bulunamadı.'),{statusCode:404});
  const item=snap.val()||{};
  await ref.remove();
  await db().ref(`emirMods/memberImages/${id}`).remove();
  return {ok:true,id,status:item.status||'pending'};
}

async function adminOK(req) {
  const expected=String(process.env.ADMIN_GOOGLE_EMAIL||'').trim().toLowerCase();
  if(!expected) return false;

  const header=req.headers.authorization||'';
  const match=String(header).match(/^Bearer\s+(.+)$/i);
  if(!match) return false;

  try {
    const decoded=await getAuth().verifyIdToken(match[1]);
    const email=String(decoded.email||'').trim().toLowerCase();
    return Boolean(decoded.email_verified && email===expected);
  } catch {
    return false;
  }
}

export default async function handler(req,res) {
  cors(res);
  if(req.method==='OPTIONS') return res.status(204).end();

  try {
    if(!firebaseReady()) {
      return res.status(503).json({error:'Firebase bağlantısı eksik. Vercel\'de FIREBASE_DATABASE_URL ve FIREBASE_SERVICE_ACCOUNT_JSON eklenmeli.'});
    }

    if(req.method==='GET') {
      if(String(req.query?.action||'')==='memberImage') return await memberImageResponse(req,res);
      return res.status(200).json(await getPublicConfig());
    }
    if(req.method!=='POST') return res.status(405).json({error:'Sadece GET ve POST kullanılabilir.'});

    const body=req.body||{}, action=body.action;

    if(action==='visitor') return res.status(200).json(await recordVisitor(body,req));
    if(action==='uploadMemberImage') return res.status(200).json(await uploadMemberImage(body,req));
    if(action==='submitMemberMod') return res.status(200).json(await submitMemberMod(body,req));

    if(!(await adminOK(req))) {
      return res.status(401).json({error:'Yetkisiz yönetici hesabı. Google hesabın admin olarak tanımlı olmayabilir.'});
    }

    if(action==='visitors') return res.status(200).json({visitors:await listVisitors()});
    if(action==='updateVisitor') return res.status(200).json(await updateVisitor(body));
    if(action==='deleteVisitor') return res.status(200).json(await deleteVisitor(body));
    if(action==='saveSite') return res.status(200).json({ok:true,data:await saveConfig(body.payload||{})});
    if(action==='memberMods') return res.status(200).json({mods:await listMemberMods()});
    if(action==='approveMemberMod') return res.status(200).json(await reviewMemberMod(body,true));
    if(action==='rejectMemberMod') return res.status(200).json(await reviewMemberMod(body,false));
    if(action==='deleteMemberMod') return res.status(200).json(await deleteMemberMod(body));

    return res.status(400).json({error:'Geçersiz işlem.'});
  } catch(error) {
    console.error('Site API Hatası:',error);
    return res.status(error?.statusCode||500).json({error:error?.message||'Sunucu hatası.'});
  }
}
