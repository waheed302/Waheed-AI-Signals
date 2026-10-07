require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
const db = new Database("waheed.sqlite");
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME";
const PORT = Number(process.env.PORT || 3000);

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS licenses(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 key TEXT UNIQUE NOT NULL,
 plan TEXT NOT NULL DEFAULT 'Premium',
 expires_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 user_id INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS signals(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 symbol TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 direction TEXT NOT NULL,
 confidence INTEGER NOT NULL,
 entry TEXT,
 target TEXT,
 risk TEXT,
 source TEXT NOT NULL DEFAULT 'demo',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function seedAdmin(){
  const email = process.env.ADMIN_EMAIL;
  const pass = process.env.ADMIN_PASSWORD;
  if(!email || !pass) return;
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if(!existing){
    const hash = bcrypt.hashSync(pass, 12);
    db.prepare("INSERT INTO users(email,password_hash,role) VALUES(?,?,?)").run(email,hash,"admin");
    console.log("Admin created:", email);
  }
}
seedAdmin();

function auth(requiredRole){
  return (req,res,next)=>{
    try{
      const token = (req.headers.authorization||"").replace("Bearer ","");
      const payload = jwt.verify(token, JWT_SECRET);
      if(requiredRole && payload.role !== requiredRole) return res.status(403).json({error:"Admin only"});
      req.user = payload;
      next();
    }catch(e){ return res.status(401).json({error:"Unauthorized"}); }
  };
}

function sign(user){
  return jwt.sign({id:user.id,email:user.email,role:user.role},JWT_SECRET,{expiresIn:"7d"});
}

function makeKey(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<8;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

app.post("/api/register", async (req,res)=>{
  const {email,password}=req.body||{};
  if(!email || !password || password.length<8) return res.status(400).json({error:"Email and password (8+ chars) required"});
  try{
    const hash=await bcrypt.hash(password,12);
    const info=db.prepare("INSERT INTO users(email,password_hash) VALUES(?,?)").run(email.toLowerCase(),hash);
    const user={id:info.lastInsertRowid,email:email.toLowerCase(),role:"user"};
    res.json({token:sign(user),user});
  }catch(e){res.status(409).json({error:"Email already registered"});}
});

app.post("/api/login", async (req,res)=>{
  const {email,password}=req.body||{};
  const user=db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
  if(!user || !(await bcrypt.compare(password||"",user.password_hash))) return res.status(401).json({error:"Invalid login"});
  res.json({token:sign(user),user:{id:user.id,email:user.email,role:user.role}});
});

app.post("/api/license/activate",auth(),(req,res)=>{
  const key=(req.body.key||"").toUpperCase().trim();
  const lic=db.prepare("SELECT * FROM licenses WHERE key=? AND active=1").get(key);
  if(!lic) return res.status(404).json({error:"Invalid or inactive license"});
  if(new Date(lic.expires_at) < new Date()) return res.status(410).json({error:"License expired"});
  db.prepare("UPDATE licenses SET user_id=? WHERE id=?").run(req.user.id,lic.id);
  res.json({ok:true,plan:lic.plan,expiresAt:lic.expires_at});
});

app.get("/api/signals",auth(),(req,res)=>{
  const rows=db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT 50").all();
  res.json(rows);
});

app.get("/api/signals/latest",auth(),(req,res)=>{
  const row=db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT 1").get();
  res.json(row||null);
});

/*
  Production signal engine:
  This endpoint intentionally does NOT pretend to have a real OTC feed.
  Connect a licensed/reliable market-data provider in generateSignal().
*/
function generateSignal(symbol,timeframe){
  const direction=Math.random()>0.5?"CALL":"PUT";
  const confidence=Math.floor(68+Math.random()*25);
  const source=process.env.LIVE_MARKET_DATA==="true"?"provider-required":"demo";
  return {symbol,timeframe,direction,confidence,entry:"LIVE",target:"ANALYTICAL",risk:"Medium",source};
}

app.post("/api/signals/generate",auth(),(req,res)=>{
  const symbol=req.body.symbol||"EUR/USD";
  const timeframe=req.body.timeframe==="5M"?"5M":"1M";
  const s=generateSignal(symbol,timeframe);
  const info=db.prepare(`INSERT INTO signals(symbol,timeframe,direction,confidence,entry,target,risk,source)
    VALUES(?,?,?,?,?,?,?,?)`).run(s.symbol,s.timeframe,s.direction,s.confidence,s.entry,s.target,s.risk,s.source);
  const row=db.prepare("SELECT * FROM signals WHERE id=?").get(info.lastInsertRowid);
  res.json(row);
});

app.get("/api/admin/stats",auth("admin"),(req,res)=>{
  const users=db.prepare("SELECT COUNT(*) n FROM users").get().n;
  const keys=db.prepare("SELECT COUNT(*) n FROM licenses WHERE active=1").get().n;
  const signals=db.prepare("SELECT COUNT(*) n FROM signals").get().n;
  res.json({users,activeKeys:keys,signals});
});

app.post("/api/admin/licenses",auth("admin"),(req,res)=>{
  const plan=req.body.plan||"Premium";
  const expiresAt=req.body.expiresAt;
  if(!expiresAt) return res.status(400).json({error:"expiresAt required"});
  let key=makeKey();
  while(db.prepare("SELECT id FROM licenses WHERE key=?").get(key)) key=makeKey();
  db.prepare("INSERT INTO licenses(key,plan,expires_at) VALUES(?,?,?)").run(key,plan,expiresAt);
  res.json({key,plan,expiresAt});
});

app.get("/api/admin/licenses",auth("admin"),(req,res)=>{
  res.json(db.prepare("SELECT id,key,plan,expires_at,active,user_id,created_at FROM licenses ORDER BY id DESC LIMIT 100").all());
});

app.post("/api/admin/licenses/:id/revoke",auth("admin"),(req,res)=>{
  db.prepare("UPDATE licenses SET active=0 WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.get("/api/admin/users",auth("admin"),(req,res)=>{
  res.json(db.prepare("SELECT id,email,role,created_at FROM users ORDER BY id DESC LIMIT 100").all());
});

app.post("/api/telegram/test",auth("admin"),async(req,res)=>{
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const chat=process.env.TELEGRAM_CHAT_ID;
  if(!token || !chat) return res.status(400).json({error:"Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env"});
  try{
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({chat_id:chat,text:"🟣 WAHEED AI SIGNALS\\nTelegram connection test successful."})
    });
    const data=await r.json();
    res.status(data.ok?200:400).json(data);
  }catch(e){res.status(500).json({error:"Telegram request failed"});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Waheed AI Signals running on http://localhost:${PORT}`));
