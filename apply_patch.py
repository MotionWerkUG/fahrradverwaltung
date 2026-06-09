import re, subprocess
with open('/var/www/sandumotion/server.js', 'r') as f:
code = f.read()
print("Original Zeilen:", len(code.split("\n")))
# 1. pdfkit require
if "require('pdfkit')" not in code:
code = code.replace(
"const nodemailer = require('nodemailer');",
"const nodemailer = require('nodemailer');\nconst PDFDocument = require('pdfkit');"
)
else:
print(" pdfkit require hinzugefügt")
print(" pdfkit bereits vorhanden")
# 2. sendMail erweitern
if "async function sendMail(to, subject, html){" in code:
code = code.replace(
"async function sendMail(to, subject, html){",
"async function sendMail(to, subject, html, attachments){"
)
code = code.replace(
"try { await getTransporter().sendMail({ from: \'\"Sandu Motion Lager\" <\'+process.e
"try { await getTransporter().sendMail({ from: \'\"Sandu Motion Lager\" <\'+process.e
)
print(" sendMail erweitert")
# 3. PDF Funktionen + Routen
pdf_code = """
// PDF GENERIERUNG
function generatePDF(buildFn) {
return new Promise((resolve, reject) => {
const doc = new PDFDocument({ margin: 50, size: 'A4' });
const chunks = [];
doc.on('data', chunk => chunks.push(chunk));
doc.on('end', () => resolve(Buffer.concat(chunks)));
doc.on('error', reject);
buildFn(doc);
doc.end();
});
}
async function generateInvoicePDF(inv, s) {
return generatePDF(doc => {
s = s || {};
const beige = '#8a6a3a', dark = '#2a2018';
doc.fillColor(dark).rect(50,40,495,55).fill();
doc.fillColor('#c4a882').fontSize(16).font('Helvetica-Bold').text(s.name||'Sandu Motion G
doc.fontSize(10).font('Helvetica').text('Rechnung '+inv.nr,65,72);
doc.fillColor('#333').fontSize(9).font('Helvetica')
.text((s.strasse||'')+' | '+(s.ort||'')+' | '+(s.email||''),65,108);
if(s.ust) doc.text('USt-IdNr: '+s.ust+(s.steuer?' | Steuernr: '+s.steuer:''),65,120);
doc.fontSize(10).text('Rechnungsnummer: '+inv.nr,350,108,{align:'right',width:195});
doc.text('Rechnungsdatum: '+inv.date,350,121,{align:'right',width:195});
doc.text('Leistungsdatum: '+(inv.service_date||inv.date),350,134,{align:'right',width:195
doc.fillColor(beige).fontSize(8).font('Helvetica-Bold').text('AN:',65,152);
doc.fillColor('#333').fontSize(10).font('Helvetica')
.text((inv.recipient||'').replace(/\\n/g,'\n'),65,165,{width:220,lineGap:2});
doc.moveTo(50,235).lineTo(545,235).strokeColor(beige).lineWidth(1.5).stroke();
doc.fillColor(dark).rect(50,242,495,20).fill();
doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
doc.text('Pos.',60,249);doc.text('Beschreibung',95,249);
doc.text('Menge',340,249,{align:'right',width:60});
doc.text('Einzelpreis',405,249,{align:'right',width:65});
doc.text('Gesamt',475,249,{align:'right',width:65});
let y=270;
const items=typeof inv.items==='string'?JSON.parse(inv.items):(inv.items||[]);
items.forEach((it,i)=>{
if(i%2===1) doc.fillColor('#f9f7f4').rect(50,y-3,495,18).fill();
doc.fillColor('#333').fontSize(9).font('Helvetica');
doc.text(String(i+1),60,y);
doc.text('Montage '+it.model,95,y,{width:240});
doc.text(it.qty+' Stk.',340,y,{align:'right',width:60});
doc.text(Number(it.price).toFixed(2).replace('.',',')+' EUR',405,y,{align:'right',width
doc.text(Number(it.total).toFixed(2).replace('.',',')+' EUR',475,y,{align:'right',width
y+=18;
});
y+=10;
doc.moveTo(350,y).lineTo(545,y).strokeColor('#ddd').lineWidth(0.5).stroke();y+=8;
doc.fillColor('#333').fontSize(10).font('Helvetica');
doc.text('Nettobetrag:',350,y);doc.text(Number(inv.netto).toFixed(2).replace('.',',')+' E
doc.text('zzgl. 19% MwSt:',350,y);doc.text(Number(inv.mwst).toFixed(2).replace('.',',')+'
doc.moveTo(350,y).lineTo(545,y).strokeColor(beige).lineWidth(1.5).stroke();y+=8;
doc.fontSize(13).font('Helvetica-Bold').fillColor(beige);
doc.text('Gesamtbetrag:',350,y);doc.text(Number(inv.brutto).toFixed(2).replace('.',',')+'
y+=35;
doc.fillColor('#555').fontSize(9).font('Helvetica');
doc.text(inv.note||'Zahlbar innerhalb von 7 Tagen netto ohne Abzug.',50,y,{width:495});y+
if(s.bank||s.iban) doc.text('Bank: '+(s.bank||'')+' | IBAN: '+(s.iban||'')+(s.bic?' | BIC
doc.text('Verwendungszweck: '+inv.nr,50,y);
doc.moveTo(50,760).lineTo(545,760).strokeColor('#ddd').lineWidth(0.5).stroke();
doc.fillColor('#aaa').fontSize(7.5).text('Elektronisch erstellt, gueltig ohne Unterschrif
if(inv.cancelled){doc.fillColor('#c0392b').fontSize(36).font('Helvetica-Bold').opacity(0.
});
}
async function generateTakeoverPDF(tp) {
return generatePDF(doc => {
const items=typeof tp.items==='string'?JSON.parse(tp.items):(tp.items||[]);
doc.fillColor('#2a2018').rect(50,40,495,50).fill();
doc.fillColor('#c4a882').fontSize(16).font('Helvetica-Bold').text('Uebernahmeprotokoll',6
doc.fillColor('white').fontSize(10).font('Helvetica').text(tp.nr+' | '+tp.date,65,72);
doc.fillColor('#333').fontSize(12).font('Helvetica-Bold').text('Container: '+tp.container
doc.moveTo(50,125).lineTo(545,125).strokeColor('#8a6a3a').lineWidth(1).stroke();
doc.fillColor('#2a2018').rect(50,132,495,20).fill();
doc.fillColor('white').fontSize(9).font('Helvetica-Bold');
doc.text('Modell',60,139);doc.text('Stueck',480,139,{align:'right',width:55});
let y=162;
items.forEach((it,i)=>{
if(i%2===1) doc.fillColor('#f9f7f4').rect(50,y-3,495,18).fill();
doc.fillColor('#333').fontSize(10).font('Helvetica');
doc.text(it.model,60,y);doc.text(String(it.qty),480,y,{align:'right',width:55});
y+=18;
});
if(tp.note){y+=8;doc.fillColor('#777').fontSize(9).text('Notiz: '+tp.note,50,y);}
});
}
async function getFirmSettings() {
try {
const r = await pool.query("SELECT value FROM app_settings WHERE key='firm_settings'");
if(r.rows.length) return JSON.parse(r.rows[0].value);
} catch(e) {}
return {};
}
app.post('/api/notifications/send', auth, async (req, res) => {
try {
const { to, subject, html, pdfData, pdfName } = req.body;
let attachments = [];
if(pdfData) {
if(pdfData.startsWith('INVOICE:')) {
const invId = pdfData.replace('INVOICE:','');
const invR = await pool.query('SELECT * FROM invoices WHERE id=$1',[invId]);
if(invR.rows.length) {
const firm = await getFirmSettings();
const buf = await generateInvoicePDF(invR.rows[0], firm);
attachments.push({filename:'Rechnung_'+invR.rows[0].nr+'.pdf',content:buf,contentTy
}
} else if(pdfData.startsWith('TAKEOVER:')) {
const tId = pdfData.replace('TAKEOVER:','');
let tRow;
if(tId==='LATEST') {
const tR = await pool.query('SELECT * FROM takeovers ORDER BY created_at DESC LIMIT
tRow=tR.rows[0];
} else {
const tR = await pool.query('SELECT * FROM takeovers WHERE id=$1',[tId]);
tRow=tR.rows[0];
}
if(tRow) {
const buf = await generateTakeoverPDF(tRow);
attachments.push({filename:'Uebernahmeprotokoll_'+tRow.nr+'.pdf',content:buf,conten
}
}
}
await sendMail(to, subject, html, attachments);
res.json({ok:true});
} catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/settings/notifications', auth, async (req, res) => {
if(req.user.role!=='admin') return res.status(403).json({error:'Nur Admin'});
try {
await pool.query("INSERT INTO app_settings (key,value) VALUES ('notif_settings',$1) ON CO
res.json({ok:true});
} catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/settings/notifications', auth, async (req, res) => {
try {
const r = await pool.query("SELECT value FROM app_settings WHERE key='notif_settings'");
res.json(r.rows.length?JSON.parse(r.rows[0].value):{});
} catch(e) { res.status(500).json({error:e.message}); }
});
"""
# Einfuegen
markers = ["\n// ─── ÜBERNAHMEPROTOKOLLE", "\n// ── ÜBERNAHMEPROTOKOLLE", "\napp.get('/api/ta
inserted = False
for m in markers:
if m in code:
code = code.replace(m, pdf_code + m, 1)
inserted = True
print(" PDF Code eingefuegt vor:", m[:40])
break
if not inserted:
code = code + pdf_code
print(" PDF Code ans Ende eingefuegt")
# 4. Invoice send Route updaten
old_send = """app.post('/api/invoices/:id/send', auth, async (req, res) => {
try {
const inv = await pool.query('SELECT * FROM invoices WHERE id=$1',[req.params.id]);
if(!inv.rows.length) return res.status(404).json({error:'Nicht gefunden'});
const {to, htmlBody} = req.body;
const i = inv.rows[0];
const subject = 'Rechnung ' + i.nr + ' – Sandu Motion GmbH';
const html = htmlBody || ('<h2>Rechnung '+i.nr+'</h2><p>Brutto: '+parseFloat(i.brutto).to
await sendMail(to, subject, html);
res.json({ok:true});
} catch(e){ res.status(500).json({error:e.message}); }
});"""
new_send = """app.post('/api/invoices/:id/send', auth, async (req, res) => {
try {
const inv = await pool.query('SELECT * FROM invoices WHERE id=$1',[req.params.id]);
if(!inv.rows.length) return res.status(404).json({error:'Nicht gefunden'});
const {to, htmlBody} = req.body;
const i = inv.rows[0];
const subject = 'Rechnung ' + i.nr + ' – Sandu Motion GmbH';
const html = htmlBody || ('<h2>Rechnung '+i.nr+'</h2><p>Brutto: '+parseFloat(i.brutto).to
const firm = await getFirmSettings();
const pdfBuf = await generateInvoicePDF(i, firm);
const attachments = [{filename:'Rechnung_'+i.nr+'.pdf',content:pdfBuf,contentType:'applic
await sendMail(to, subject, html, attachments);
res.json({ok:true});
} catch(e){ res.status(500).json({error:e.message}); }
});"""
if old_send in code:
code = code.replace(old_send, new_send)
print(" Invoice send Route aktualisiert")
else:
print(" Invoice send Route nicht gefunden - bereits aktualisiert?")
with open('/var/www/sandumotion/server.js', 'w') as f:
f.write(code)
print(" server.js gespeichert. Zeilen:", len(code.split("\n")))
