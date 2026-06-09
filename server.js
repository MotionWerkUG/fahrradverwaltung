const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
require('dotenv').config({ path: '/var/www/sandumotion/.env' });

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'SanduMotion_Secret_2025';

const pg = require("pg");
pg.types.setTypeParser(1082, val => val);

const pool = new Pool({
  user: process.env.DB_USER || 'sandumotion',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sandulager',
  password: process.env.DB_PASS,
  port: parseInt(process.env.DB_PORT || '5432'),
});

function getTransporter(){
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.ionos.de',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' }
  });
}

async function sendMail(to, subject, html, attachments){
  if(!process.env.SMTP_USER || !process.env.SMTP_PASS){ console.log('Mail nicht konfiguriert'); return false; }
  try {
    await getTransporter().sendMail({
      from: '"Sandu Motion Lager" <'+process.env.SMTP_USER+'>',
      to, subject, html, attachments: attachments||[]
    });
    return true;
  } catch(e){ console.error('Mail Fehler:', e.message); return false; }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next){
  const token = req.headers.authorization?.split(' ')[1];
  if(!token) return res.status(401).json({error:'Kein Token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Ungültiger Token'}); }
}

function canWrite(req){ return req.user.can_write || req.user.role==='admin' || req.user.role==='staff' || req.user.role==='partner'; }

// ── AUTH ROUTEN ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
    if(!r.rows.length) return res.status(401).json({error:'Falsche Zugangsdaten'});
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if(!ok) return res.status(401).json({error:'Falsche Zugangsdaten'});
    const token = jwt.sign({id:r.rows[0].id, email:r.rows[0].email, can_write:r.rows[0].can_write, role:r.rows[0].role}, JWT_SECRET, {expiresIn:'30d'});
    res.json({token, email:r.rows[0].email, role:r.rows[0].role, can_write:r.rows[0].can_write});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id,email,role,can_write FROM users WHERE id=$1', [req.user.id]);
  if(!r.rows.length) return res.status(404).json({error:'User nicht gefunden'});
  res.json(r.rows[0]);
});

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const r = await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
    if(r.rows.length){
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000);
      await pool.query('UPDATE users SET reset_token=$1, reset_expires=$2 WHERE email=$3', [token, expires, email]);
      const link = 'https://lager.sandu-motion.de/reset.html?token='+token;
      await sendMail(email, 'Passwort zurücksetzen – Sandu Motion Lager',
        '<h2>Passwort zurücksetzen</h2><p><a href="'+link+'" style="background:#c4a882;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Passwort zurücksetzen</a></p><p>Der Link ist 1 Stunde gültig.</p>');
    }
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  try {
    const r = await pool.query('SELECT id FROM users WHERE reset_token=$1 AND reset_expires>NOW()', [token]);
    if(!r.rows.length) return res.status(400).json({error:'Token ungültig oder abgelaufen'});
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2', [hash, r.rows[0].id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/change-password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if(!r.rows.length) return res.status(404).json({error:'User nicht gefunden'});
    const ok = await bcrypt.compare(oldPassword, r.rows[0].password_hash);
    if(!ok) return res.status(401).json({error:'Altes Passwort falsch'});
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── USER VERWALTUNG ──
app.get('/api/users', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Kein Adminrecht'});
  const r = await pool.query('SELECT id,email,role FROM users ORDER BY email');
  res.json(r.rows);
});

app.post('/api/users', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Kein Adminrecht'});
  const { email, password, role, sendEmail } = req.body;
  if(!email||!password) return res.status(400).json({error:'E-Mail und Passwort erforderlich'});
  try {
    const hash = await bcrypt.hash(password, 10);
    const validRole = ['admin','staff','reader','partner'].includes(role)?role:'reader';
    const cw = ['admin','staff'].includes(validRole);
    await pool.query('INSERT INTO users (email,password_hash,role,can_write) VALUES ($1,$2,$3,$4)', [email.toLowerCase(), hash, validRole, cw]);
    if(sendEmail){
      const roleDE = validRole==='admin'?'Administrator':validRole==='staff'?'Mitarbeiter':validRole==='partner'?'Partner':'Leser';
      await sendMail(email, 'Dein Zugang – Sandu Motion Lagerverwaltung',
        '<h2>Willkommen bei Sandu Motion Lagerverwaltung</h2>'+
        '<p>Dein Zugang:<br><b>URL:</b> https://lager.sandu-motion.de<br><b>E-Mail:</b> '+email+'<br><b>Passwort:</b> '+password+'<br><b>Rolle:</b> '+roleDE+'</p>'+
        '<p>Bitte ändere dein Passwort nach dem ersten Login.</p>');
    }
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/users/:id', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Kein Adminrecht'});
  const { role, password } = req.body;
  try {
    if(role){ const validRole=['admin','staff','reader','partner'].includes(role)?role:'reader'; await pool.query('UPDATE users SET role=$1, can_write=$2 WHERE id=$3', [validRole, ['admin','staff'].includes(validRole), req.params.id]); }
    if(password){
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
      const u = await pool.query('SELECT email FROM users WHERE id=$1', [req.params.id]);
      if(u.rows.length) await sendMail(u.rows[0].email, 'Dein Passwort wurde zurückgesetzt',
        '<h2>Passwort zurückgesetzt</h2><p>Dein neues Passwort: <b>'+password+'</b></p><p>Bitte ändere es nach dem Login.</p>');
    }
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Kein Adminrecht'});
  await pool.query('DELETE FROM users WHERE id=$1 AND id!=$2', [req.params.id, req.user.id]);
  res.json({ok:true});
});

// ── MODELLE ──
app.get('/api/models', auth, async (req, res) => { const r = await pool.query('SELECT name, COALESCE(price,0) as price FROM models ORDER BY name'); res.json(r.rows); });
app.post('/api/models', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); await pool.query('INSERT INTO models (name) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.name]); res.json({ok:true}); });
app.delete('/api/models/:name', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); await pool.query('DELETE FROM models WHERE name=$1', [req.params.name]); res.json({ok:true}); });
app.put('/api/models/price', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); const {name, price} = req.body; await pool.query('UPDATE models SET price=$1 WHERE name=$2', [parseFloat(price)||0, name]); res.json({ok:true}); });

// ── EINGANG/AUSGANG ──
app.get('/api/entries', auth, async (req, res) => { const r = await pool.query('SELECT * FROM entries ORDER BY date DESC'); res.json(r.rows); });
app.post('/api/entries', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); const {model,qty,date,note}=req.body; const r=await pool.query('INSERT INTO entries (model,qty,date,note) VALUES ($1,$2,$3,$4) RETURNING *',[model,qty,date,note||'']); res.json(r.rows[0]); });
app.delete('/api/entries/:id', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); await pool.query('DELETE FROM entries WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.get('/api/exits', auth, async (req, res) => { const r = await pool.query('SELECT * FROM exits ORDER BY date DESC'); res.json(r.rows); });
app.post('/api/exits', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); const {model,qty,date,recipient}=req.body; const r=await pool.query('INSERT INTO exits (model,qty,date,recipient) VALUES ($1,$2,$3,$4) RETURNING *',[model,qty,date,recipient||'']); res.json(r.rows[0]); });
app.delete('/api/exits/:id', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); await pool.query('DELETE FROM exits WHERE id=$1',[req.params.id]); res.json({ok:true}); });

// ── VORLAUF ──
app.get('/api/vorlauf', auth, async (req, res) => { const r = await pool.query('SELECT * FROM vorlauf ORDER BY expected_date ASC NULLS LAST'); res.json(r.rows); });
app.post('/api/vorlauf', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); const {name,expected_date,arrival_time,items,note}=req.body; const r=await pool.query('INSERT INTO vorlauf (name,expected_date,arrival_time,items,note) VALUES ($1,$2,$3,$4,$5) RETURNING *',[name,expected_date||null,arrival_time||null,JSON.stringify(items||[]),note||'']); res.json(r.rows[0]); });
app.put('/api/vorlauf/:id', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); const {name,expected_date,arrival_time,items,note,arrived}=req.body; const r=await pool.query('UPDATE vorlauf SET name=$1,expected_date=$2,arrival_time=$3,items=$4,note=$5,arrived=$6 WHERE id=$7 RETURNING *',[name,expected_date||null,arrival_time||null,JSON.stringify(items||[]),note||'',arrived||false,req.params.id]); res.json(r.rows[0]); });
app.delete('/api/vorlauf/:id', auth, async (req, res) => { if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'}); await pool.query('DELETE FROM vorlauf WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.post('/api/vorlauf/notify', auth, async (req, res) => {
  try {
    const { name, expected_date, arrival_time, items, note } = req.body;
    const itemStr = (items||[]).map(i => i.model+' x'+i.qty).join(', ');
    const dateStr = expected_date ? new Date(expected_date).toLocaleDateString('de-DE') : 'Kein Datum';
    const timeStr = arrival_time ? ' um '+arrival_time+' Uhr' : '';
    await sendMail('david@sandu-motion.de', 'Neuer Vorlauf: '+name,
      '<h2>Neuer Vorlauf eingetragen</h2><p><b>Sendung:</b> '+name+'</p>'+
      '<p><b>Ankunft:</b> '+dateStr+timeStr+'</p>'+
      '<p><b>Modelle:</b> '+itemStr+'</p>'+
      (note?'<p><b>Notiz:</b> '+note+'</p>':'')+
      '<p><b>Eingetragen von:</b> '+req.user.email+'</p>');
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── DOKUMENTE ──
app.get('/api/documents', auth, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM documents ORDER BY created_at DESC'); res.json(r.rows); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/documents/next-nr', auth, async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const r = await pool.query("SELECT nextval('doc_nr_seq') AS nr");
    const nr = String(r.rows[0].nr).padStart(4, '0');
    res.json({doc_nr: 'AB-'+year+'-'+nr});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/documents', auth, async (req, res) => {
  try {
    const {doc_nr,date,recipient,items,total} = req.body;
    const r = await pool.query(
      'INSERT INTO documents (doc_nr,date,recipient,items,total,storno) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [doc_nr,date,recipient||'',JSON.stringify(items),total,req.body.storno||false]
    );
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/documents/seq-value', auth, async (req, res) => {
  try { const r = await pool.query("SELECT last_value AS current_value FROM doc_nr_seq"); res.json(r.rows[0]); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/documents/set-seq', auth, async (req, res) => {
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
    await pool.query("SELECT setval('doc_nr_seq', $1)", [parseInt(req.body.value)-1]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/documents/:doc_nr', auth, async (req, res) => {
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
    await pool.query('DELETE FROM documents WHERE doc_nr=$1', [req.params.doc_nr]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/documents/signature', auth, async (req, res) => {
  try {
    const {doc_nr,signature} = req.body;
    await pool.query('UPDATE documents SET signature=$1 WHERE doc_nr=$2', [signature,doc_nr]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── KALENDER ──
const icsStore = {};
app.post('/api/calendar/create', auth, (req, res) => {
  const token = Math.random().toString(36).slice(2);
  icsStore[token] = {ics:req.body.ics, filename:req.body.filename, ts:Date.now()};
  Object.keys(icsStore).forEach(k => { if(Date.now()-icsStore[k].ts > 60000) delete icsStore[k]; });
  res.json({token});
});

app.get('/api/calendar/download/:token', (req, res) => {
  const entry = icsStore[req.params.token];
  if(!entry) return res.status(404).send('Nicht gefunden');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="'+entry.filename+'.ics"');
  res.send(entry.ics);
  delete icsStore[req.params.token];
});

app.get('/api/calendar/ics/:id', async (req, res) => {
  try {
    const token = req.query.token;
    if(!token) return res.status(401).send('Kein Token');
    let user;
    try { user = jwt.verify(token, JWT_SECRET); } catch(e){ return res.status(401).send('Ungültiger Token'); }
    const r = await pool.query('SELECT * FROM vorlauf WHERE id=$1', [req.params.id]);
    if(!r.rows.length) return res.status(404).send('Nicht gefunden');
    const v = r.rows[0];
    const items = (v.items||[]).map(i => i.model+' x'+i.qty).join(', ');
    const date = v.expected_date ? v.expected_date.toString().slice(0,10).replace(/-/g,'') : '';
    const time = v.arrival_time ? v.arrival_time.replace(':','')+'00' : '';
    const now = new Date();
    const pad = n => String(n).padStart(2,'0');
    const stamp = now.getFullYear()+pad(now.getMonth()+1)+pad(now.getDate())+'T'+pad(now.getHours())+pad(now.getMinutes())+pad(now.getSeconds())+'Z';
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sandu Motion//Lagerverwaltung//DE\r\nBEGIN:VEVENT\r\n';
    ics += 'UID:'+v.id+'@sandu-motion.de\r\n';
    ics += 'DTSTAMP:'+stamp+'\r\n';
    if(date){
      if(time){ ics += 'DTSTART:'+date+'T'+time+'\r\nDTEND:'+date+'T'+time+'\r\n'; }
      else { ics += 'DTSTART;VALUE=DATE:'+date+'\r\nDTEND;VALUE=DATE:'+date+'\r\n'; }
    }
    ics += 'SUMMARY:Lieferung: '+v.name+'\r\n';

    ics += 'DESCRIPTION:Modelle: '+items+(v.note?'\nNotiz: '+v.note:'')+'\r\n';

    ics += 'END:VEVENT\r\nEND:VCALENDAR';
    const filename = v.name.replace(/[^a-zA-Z0-9]/g,'_')+'.ics';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="'+filename+'"');
    res.send(ics);
  } catch(e){ res.status(500).send('Fehler: '+e.message); }
});

// ── EINSTELLUNGEN ──
app.get('/api/settings/tab-perms', auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key='tab_perms'");
    res.json(r.rows.length ? {perms:JSON.parse(r.rows[0].value)} : {perms:null});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/settings/tab-perms', auth, async (req, res) => {
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
    await pool.query("INSERT INTO app_settings (key,value) VALUES ('tab_perms',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(req.body.perms)]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/settings/firm', auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key='firm_settings'");
    res.json(r.rows.length ? {settings:JSON.parse(r.rows[0].value)} : {settings:{}});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/settings/firm', auth, async (req, res) => {
  try {
    if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
    await pool.query("INSERT INTO app_settings (key,value) VALUES ('firm_settings',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(req.body.settings)]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/settings/notifications', auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key='notif_settings'");
    res.json(r.rows.length ? JSON.parse(r.rows[0].value) : {});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/settings/notifications', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
  try {
    await pool.query("INSERT INTO app_settings (key,value) VALUES ('notif_settings',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(req.body)]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── PDF GENERIERUNG ──
function generatePDF(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({margin:50, size:'A4'});
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

async function getFirmSettings() {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key='firm_settings'");
    if(r.rows.length) return JSON.parse(r.rows[0].value);
  } catch(e){}
  return {};
}

async function generateInvoicePDF(inv, s) {
  return generatePDF(doc => {
    s = s || {};
    const beige = '#8a6a3a';
    const dark = '#333333';
    const items = typeof inv.items === 'string' ? JSON.parse(inv.items) : (inv.items||[]);
    const recipient = (inv.recipient||'').replace(/\n/g, '\n');

    // Datum formatieren
    const fmtDate = d => {
      if(!d) return '';
      const p = d.split('-');
      return p.length===3 ? p[2]+'.'+p[1]+'.'+p[0] : d;
    };

    let y = 35;

    // Firmenname oben links
    doc.fontSize(13).font('Helvetica-Bold').fillColor(dark)
       .text((s.name||'Sandu Motion')+(s.zusatz?' '+s.zusatz:''), 50, y);
    y += 16;

    // Absenderzeile
    doc.fontSize(8).font('Helvetica').fillColor('#999')
       .text((s.strasse||'')+' | '+(s.ort||'')+(s.email?' | '+s.email:''), 50, y, {width:350});
    y += 5;
    doc.moveTo(50,y).lineTo(545,y).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += 12;

    // Empfänger links
    const recipLines = recipient.split('\n').filter(l => l.trim());
    recipLines.forEach((line, i) => {
      if(i===0) doc.fontSize(11).font('Helvetica-Bold').fillColor(dark).text(line, 50, y);
      else doc.fontSize(10).font('Helvetica').fillColor('#444').text(line, 50, y);
      y += 14;
    });

    // Rechnungsinfo rechts (neben Empfänger)
    const metaY = 55;
    doc.fontSize(15).font('Helvetica-Bold').fillColor(beige)
       .text('Rechnung '+inv.nr, 300, metaY, {align:'right', width:245});
    doc.fontSize(9).font('Helvetica').fillColor('#555')
       .text('Rechnungsdatum: '+fmtDate(inv.date), 300, metaY+22, {align:'right', width:245})
       .text('Leistungsdatum: '+fmtDate(inv.service_date||inv.date), 300, metaY+36, {align:'right', width:245});

    // Tabellen-Header
    y = Math.max(y + 8, 145);
    doc.fillColor('#444').rect(50, y, 495, 22).fill();
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
    doc.text('Pos.', 58, y+7, {width:30});
    doc.text('Beschreibung', 90, y+7, {width:240});
    doc.text('Menge', 330, y+7, {align:'right', width:65});
    doc.text('Einzelpreis', 400, y+7, {align:'right', width:70});
    doc.text('Gesamt', 475, y+7, {align:'right', width:65});
    y += 22;

    // Positionen
    items.forEach((it, i) => {
      const hasDesc = it.description && it.description.trim();
      const rowH = hasDesc ? 28 : 20;
      if(i%2===1) doc.fillColor('#f8f8f8').rect(50,y,495,rowH).fill();
      doc.fillColor(dark).fontSize(9.5).font('Helvetica');
      doc.text(String(i+1), 58, y+5, {width:30});
      doc.text('Montage '+it.model, 90, y+5, {width:235});
      if(hasDesc) doc.fontSize(8).fillColor('#888').text(it.description, 90, y+17, {width:235});
      doc.fontSize(9.5).fillColor(dark);
      doc.text(it.qty+' Stk.', 330, y+5, {align:'right', width:65});
      doc.text(Number(it.price).toFixed(2).replace('.',',')+' €', 400, y+5, {align:'right', width:70});
      doc.text(Number(it.total).toFixed(2).replace('.',',')+' €', 475, y+5, {align:'right', width:65});
      y += rowH;
    });

    // Trennlinie + Summen
    y += 8;
    doc.moveTo(340,y).lineTo(545,y).strokeColor('#ddd').lineWidth(0.5).stroke(); y += 7;
    doc.fillColor('#555').fontSize(10).font('Helvetica');
    doc.text('Nettobetrag:', 340, y, {width:130});
    doc.text(Number(inv.netto).toFixed(2).replace('.',',')+' €', 475, y, {align:'right', width:65}); y += 16;
    doc.text('zzgl. 19% MwSt:', 340, y, {width:130});
    doc.text(Number(inv.mwst).toFixed(2).replace('.',',')+' €', 475, y, {align:'right', width:65}); y += 7;
    doc.moveTo(340,y).lineTo(545,y).strokeColor(beige).lineWidth(1.5).stroke(); y += 9;
    doc.fontSize(13).font('Helvetica-Bold').fillColor(beige);
    doc.text('Gesamtbetrag:', 340, y, {width:130});
    doc.text(Number(inv.brutto).toFixed(2).replace('.',',')+' €', 475, y, {align:'right', width:65});

    // Zahlungsinfos
    y += 35;
    doc.fillColor('#555').fontSize(9).font('Helvetica');
    doc.text(inv.note||'Zahlbar innerhalb von 7 Tagen ohne Abzug.', 50, y, {width:495}); y += 13;
    if(s.bank||s.iban) {
      doc.text('Bank: '+(s.bank||'')+' | IBAN: '+(s.iban||'')+(s.bic?' | BIC: '+s.bic:''), 50, y, {width:495}); y += 13;
    }
    doc.text('Verwendungszweck: '+inv.nr, 50, y);

    // Footer ganz unten mit 4 Spalten
    const fY = 758;
    doc.moveTo(50,fY).lineTo(545,fY).strokeColor('#ccc').lineWidth(0.5).stroke();
    const fcols = [
      [(s.name||'Sandu Motion')+(s.zusatz?' '+s.zusatz:''), s.strasse||'', s.ort||''],
      ['USt-IdNr: '+(s.ust||'beantragt'), 'Steuernr: '+(s.steuer||'beantragt')],
      ['Geschaeftsfuehrer: '+(s.gf||'-'), s.gericht||''],
      ['Bank: '+(s.bank||'-'), 'IBAN: '+(s.iban||'-'), 'BIC: '+(s.bic||'-')]
    ];
    fcols.forEach((col, ci) => {
      const cx = 50 + ci*124;
      let fy = fY + 5;
      col.forEach((line, li) => {
        doc.fontSize(7).font(li===0?'Helvetica-Bold':'Helvetica').fillColor('#777')
           .text(line, cx, fy, {width:118, lineBreak:false});
        fy += 9;
      });
      if(ci < 3) doc.moveTo(cx+120,fY+3).lineTo(cx+120,fY+36).strokeColor('#ddd').lineWidth(0.5).stroke();
    });

    if(inv.cancelled) {
      doc.fillColor('#c0392b').fontSize(36).font('Helvetica-Bold').opacity(0.12)
         .text('STORNIERT', 120, 280, {rotate:-20});
    }
  });
}

async function generateTakeoverPDF(tp) {
  return generatePDF(doc => {
    const items = typeof tp.items === 'string' ? JSON.parse(tp.items) : (tp.items||[]);
    doc.fillColor('#2a2018').rect(50,40,495,50).fill();
    doc.fillColor('#c4a882').fontSize(16).font('Helvetica-Bold').text('Uebernahmeprotokoll',65,50);
    doc.fillColor('white').fontSize(10).font('Helvetica').text(tp.nr+' | '+tp.date,65,72);
    doc.fillColor('#333').fontSize(12).font('Helvetica-Bold').text('Container: '+tp.container_name,50,105);
    doc.moveTo(50,125).lineTo(545,125).strokeColor('#8a6a3a').lineWidth(1).stroke();
    doc.fillColor('#2a2018').rect(50,132,495,20).fill();
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
    doc.text('Modell',60,139);
    doc.text('Stueck',480,139,{align:'right',width:55});
    let y = 162;
    items.forEach((it, i) => {
      if(i%2===1) doc.fillColor('#f9f7f4').rect(50,y-3,495,18).fill();
      doc.fillColor('#333').fontSize(10).font('Helvetica');
      doc.text(it.model,60,y);
      doc.text(String(it.qty),480,y,{align:'right',width:55});
      y += 18;
    });
    if(tp.note){ y+=8; doc.fillColor('#777').fontSize(9).text('Notiz: '+tp.note,50,y); }
  });
}

// ── RECHNUNGEN ──
app.get('/api/invoices', auth, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM invoices ORDER BY created_at DESC'); res.json(r.rows); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/invoices', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
  try {
    const seq = await pool.query("SELECT nextval('invoice_nr_seq') as n");
    const nr = 'RG-'+new Date().getFullYear()+'-'+String(seq.rows[0].n).padStart(4,'0');
    const {date,service_date,recipient,items,netto,mwst,brutto,note} = req.body;
    const r = await pool.query(
      'INSERT INTO invoices (nr,date,service_date,recipient,items,netto,mwst,brutto,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [nr,date,service_date,recipient,JSON.stringify(items||[]),netto,mwst,brutto,note||'',req.user.email]
    );
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/invoices/:id/paid', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
  try { await pool.query('UPDATE invoices SET paid=true WHERE id=$1', [req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/invoices/:id/send', auth, async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invoices WHERE id=$1',[req.params.id]);
    if(!inv.rows.length) return res.status(404).json({error:'Nicht gefunden'});
    const {to, htmlBody} = req.body;
    const i = inv.rows[0];
    const firm = await getFirmSettings();
    const subject = 'Rechnung '+i.nr+' – '+(firm.name||'Sandu Motion')+(firm.zusatz?' '+firm.zusatz:'');
    const html = htmlBody || ('<p>Sehr geehrte Damen und Herren,</p><p>anbei erhalten Sie die Rechnung '+i.nr+' über '+Number(i.brutto).toFixed(2).replace('.',',')+'&nbsp;€.</p><p>Mit freundlichen Grüßen<br>'+(firm.name||'Sandu Motion')+'</p>');
    const pdfBuf = await generateInvoicePDF(i, firm);
    await sendMail(to, subject, html, [{filename:'Rechnung_'+i.nr+'.pdf', content:pdfBuf, contentType:'application/pdf'}]);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/invoices/:id/cancel', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
  try {
    const orig = await pool.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if(!orig.rows.length) return res.status(404).json({error:'Nicht gefunden'});
    const inv = orig.rows[0];
    if(inv.cancelled) return res.status(400).json({error:'Bereits storniert'});
    const seq = await pool.query("SELECT nextval('invoice_nr_seq') as n");
    const storno_nr = 'ST-'+new Date().getFullYear()+'-'+String(seq.rows[0].n).padStart(4,'0');
    await pool.query(
      'INSERT INTO invoices (nr,date,service_date,recipient,items,netto,mwst,brutto,note,cancelled,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)',
      [storno_nr,new Date().toISOString().slice(0,10),inv.service_date,inv.recipient,inv.items,-inv.netto,-inv.mwst,-inv.brutto,'Stornorechnung zu '+inv.nr,req.user.email]
    );
    await pool.query('UPDATE invoices SET cancelled=true, storno_nr=$1 WHERE id=$2', [storno_nr, req.params.id]);
    res.json({ok:true, storno_nr});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── BENACHRICHTIGUNGEN ──
app.post('/api/notifications/send', auth, async (req, res) => {
  try {
    const {to, subject, html, pdfData} = req.body;
    let attachments = [];
    if(pdfData && pdfData.startsWith('INVOICE:')) {
      const invR = await pool.query('SELECT * FROM invoices WHERE id=$1',[pdfData.replace('INVOICE:','')]);
      if(invR.rows.length) {
        const firm = await getFirmSettings();
        const buf = await generateInvoicePDF(invR.rows[0], firm);
        attachments.push({filename:'Rechnung_'+invR.rows[0].nr+'.pdf', content:buf, contentType:'application/pdf'});
      }
    } else if(pdfData && pdfData.startsWith('TAKEOVER:')) {
      const tId = pdfData.replace('TAKEOVER:','');
      const tR = tId==='LATEST'
        ? await pool.query('SELECT * FROM takeovers ORDER BY created_at DESC LIMIT 1')
        : await pool.query('SELECT * FROM takeovers WHERE id=$1',[tId]);
      if(tR.rows.length) {
        const buf = await generateTakeoverPDF(tR.rows[0]);
        attachments.push({filename:'Uebernahmeprotokoll_'+tR.rows[0].nr+'.pdf', content:buf, contentType:'application/pdf'});
      }
    }
    await sendMail(to, subject, html, attachments);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── ÜBERNAHMEPROTOKOLLE ──
app.get('/api/takeovers', auth, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM takeovers ORDER BY created_at DESC'); res.json(r.rows); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/takeovers', auth, async (req, res) => {
  if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'});
  try {
    const seq = await pool.query("SELECT nextval('takeover_nr_seq') as n");
    const nr = 'ÜP-'+new Date().getFullYear()+'-'+String(seq.rows[0].n).padStart(4,'0');
    const {container_name,items,note,date} = req.body;
    const r = await pool.query('INSERT INTO takeovers (nr,container_name,items,note,date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nr,container_name,JSON.stringify(items||[]),note||'',date]);
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/takeovers/:id', auth, async (req, res) => {
  if(!canWrite(req)) return res.status(403).json({error:'Kein Schreibrecht'});
  try {
    const r = await pool.query('UPDATE takeovers SET items=$1,note=$2 WHERE id=$3 RETURNING *',
      [JSON.stringify(req.body.items||[]),req.body.note||'',req.params.id]);
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/takeovers/:id', auth, async (req, res) => {
  if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
  try { await pool.query('DELETE FROM takeovers WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.listen(PORT, () => console.log('Sandu Motion Lager läuft auf Port '+PORT));
