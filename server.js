// ตัวกลางรับ webhook โดเนท -> เก็บคิว -> ให้ addon ดึงไปแจกของ (ไม่ต้องลง npm)
const http = require("http"), fs = require("fs"), path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
// ค่าลับตั้งผ่าน Environment ได้ (ไม่ต้องใส่ในไฟล์/GitHub)
if (process.env.API_KEY) cfg.apiKey = process.env.API_KEY;
if (process.env.DISCORD_WEBHOOK) cfg.discordWebhook = process.env.DISCORD_WEBHOOK;
if (process.env.EASYSLIP_API_KEY) cfg.easyslipKey = process.env.EASYSLIP_API_KEY;
if (process.env.TRUEMONEY_PHONE) cfg.truemoneyPhone = process.env.TRUEMONEY_PHONE;
const QFILE = path.join(__dirname, "queue.json");
let queue = fs.existsSync(QFILE) ? JSON.parse(fs.readFileSync(QFILE, "utf8")) : [];
const save = () => fs.writeFileSync(QFILE, JSON.stringify(queue, null, 1));

// แปลงข้อมูลจากแต่ละเจ้าให้เป็นรูปแบบเดียว — ดูไฟล์ raw.log แล้วปรับชื่อฟิลด์ตรงนี้ให้ตรงกับของจริง
function normalize(b) {
  const pick = (...k) => { for (const x of k) if (b[x] !== undefined && b[x] !== null) return b[x]; };
  const message = String(pick("message", "msg", "comment", "note", "description") ?? "");
  const amount = Number(pick("amount", "total", "value", "price") ?? 0);
  const name = String(pick("name", "donor", "donor_name", "username", "from") ?? "");
  const id = String(pick("id", "transaction_id", "txid", "ref", "reference") ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // ชื่อผู้เล่น: ใช้คำแรกของข้อความ (เช่น "Steve ขอกุญแจ") หรือใช้ชื่อผู้โดเนทตาม playerFrom
  const player = (cfg.playerFrom === "name" ? name : message.trim().split(/\s+/)[0]) || "";
  return { id, player, amount, message, at: Date.now() };
}

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r, j) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 8e6) { j(new Error("TOO_BIG")); req.destroy(); } }); req.on("end", () => r(s)); });

// ===== เติมอัตโนมัติด้วยซองอั่งเปา TrueMoney (แลกเข้าเบอร์ cfg.truemoneyPhone) =====
const RFILE = path.join(__dirname, "redeemed.json");
const redeemed = fs.existsSync(RFILE) ? JSON.parse(fs.readFileSync(RFILE, "utf8")) : {};
const lastTry = {};
async function discord(player, amount, coins, via) {
  if (!cfg.discordWebhook) return;
  try {
    await fetch(cfg.discordWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      username: "PingSMP Donate",
      embeds: [{ title: "💖 มีคนโดเนท!", color: 0xf1c40f, timestamp: new Date().toISOString(),
        fields: [ { name: "ผู้เล่น", value: String(player), inline: true }, { name: "ยอด", value: amount + " บาท", inline: true },
                  ...(coins ? [{ name: "ได้รับ", value: coins + " PingCoin", inline: true }] : []), { name: "ช่องทาง", value: via, inline: true } ] }] }) });
  } catch (e) { console.error("discord error", e.message); }
}
const webHits = {};
async function redeem(req, res, web) {
  const reply = (o) => send(res, 200, o);
  const { player, link } = JSON.parse(await readBody(req));
  if (web) { const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim(); webHits[ip] = (webHits[ip] || []).filter((t) => Date.now() - t < 60000); if (webHits[ip].length >= 5) return reply({ ok: false, error: "TOO_FAST" }); webHits[ip].push(Date.now()); }
  if (!player || !/^[\w .\-]{1,32}$/.test(player)) return reply({ ok: false, error: "BAD_PLAYER" });
  if (Date.now() - (lastTry[player] ?? 0) < 10000) return reply({ ok: false, error: "TOO_FAST" });
  lastTry[player] = Date.now();
  const m = String(link).match(/[?&]v=([0-9A-Za-z]+)/) || String(link).trim().match(/^([0-9A-Za-z]{18,64})$/);
  if (!m) return reply({ ok: false, error: "BAD_LINK" });
  const code = m[1];
  if (redeemed[code]) return reply({ ok: false, error: "ALREADY_REDEEMED" });
  redeemed[code] = { player, at: Date.now(), status: "pending" };   // จองไว้ก่อน กันยิงซ้ำ
  fs.writeFileSync(RFILE, JSON.stringify(redeemed, null, 1));
  try {
    const r = await fetch(`https://gift.truemoney.com/campaign/vouchers/${code}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
      body: JSON.stringify({ mobile: cfg.truemoneyPhone, voucher_hash: code }),
    });
    const text = await r.text();
    fs.appendFileSync(path.join(__dirname, "raw.log"), `${new Date().toISOString()} REDEEM ${player} ${r.status} ${text.slice(0, 500)}\n`);
    let j; try { j = JSON.parse(text); } catch { j = null; }
    const st = j && j.status && j.status.code;
    if (st === "SUCCESS") {
      const amount = Number(j.data?.my_ticket?.amount_baht ?? j.data?.voucher?.amount_baht ?? 0);
      if (!(amount > 0)) throw new Error("NO_AMOUNT");
      redeemed[code] = { player, amount, at: Date.now(), status: "ok" };
      fs.writeFileSync(RFILE, JSON.stringify(redeemed, null, 1));
      console.log("แลกซองสำเร็จ", player, amount);
      discord(player, amount, null, web ? "เว็บโดเนท (ซองอั่งเปา)" : "ซองอั่งเปา (อัตโนมัติ)");
      if (web) { queue.push({ id: code, player, amount, message: "web", at: Date.now() }); save(); }   // ให้เกมมาดึงไปเติม coin
      return reply({ ok: true, amount, id: code });
    }
    delete redeemed[code]; fs.writeFileSync(RFILE, JSON.stringify(redeemed, null, 1));   // ล้มเหลว — ให้ลองใหม่ได้
    return reply({ ok: false, error: st || "HTTP_" + r.status });
  } catch (e) {
    console.error("redeem error", e);
    redeemed[code] = { player, at: Date.now(), status: "error", note: String(e) };   // ไม่ทราบผล — คงไว้ให้แอดมินตรวจ
    fs.writeFileSync(RFILE, JSON.stringify(redeemed, null, 1));
    return reply({ ok: false, error: "UNKNOWN_CHECK_ADMIN" });
  }
}

// ===== โอนพร้อมเพย์ + อัปโหลดสลิป (ตรวจด้วย EasySlip) =====
const SFILE = path.join(__dirname, "slips.json");
const slips = fs.existsSync(SFILE) ? JSON.parse(fs.readFileSync(SFILE, "utf8")) : {};
async function slipVerify(req, res) {
  const reply = (o) => send(res, 200, o);
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim();
  webHits[ip] = (webHits[ip] || []).filter((t) => Date.now() - t < 60000);
  if (webHits[ip].length >= 5) return reply({ ok: false, error: "TOO_FAST" });
  webHits[ip].push(Date.now());
  if (!cfg.easyslipKey) return reply({ ok: false, error: "NOT_CONFIGURED" });
  const { player, image } = JSON.parse(await readBody(req));
  if (!player || !/^[\w .\-]{1,32}$/.test(player)) return reply({ ok: false, error: "BAD_PLAYER" });
  const buf = Buffer.from(String(image || ""), "base64");
  const okType = buf.length > 100 && ((buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50) || buf.slice(0, 4).toString() === "RIFF" || buf.slice(0, 3).toString() === "GIF");
  if (!okType) return reply({ ok: false, error: "INVALID_IMAGE_FORMAT" });
  if (buf.length > 4 * 1024 * 1024) return reply({ ok: false, error: "IMAGE_SIZE_TOO_LARGE" });
  try {
    const fd = new FormData();
    fd.append("image", new Blob([buf]), "slip.jpg");
    fd.append("checkDuplicate", "true");
    if (cfg.requireMatchAccount) fd.append("matchAccount", "true");
    const r = await fetch("https://api.easyslip.com/v2/verify/bank", { method: "POST", headers: { Authorization: "Bearer " + cfg.easyslipKey }, body: fd });
    const text = await r.text();
    fs.appendFileSync(path.join(__dirname, "raw.log"), `${new Date().toISOString()} SLIP ${player} ${r.status} ${text.slice(0, 700)}\n`);
    let j; try { j = JSON.parse(text); } catch { j = null; }
    if (!j || !j.success) return reply({ ok: false, error: (j && j.error && j.error.code) || "HTTP_" + r.status });
    const d = j.data || {}, raw = d.rawSlip || {};
    const ref = String(raw.transRef || ""), amount = Number(raw.amount && raw.amount.amount);
    if (!ref || !(amount > 0)) return reply({ ok: false, error: "UNREADABLE" });
    if (d.isDuplicate || slips[ref]) return reply({ ok: false, error: "DUPLICATE" });
    if (cfg.requireMatchAccount && !d.matchedAccount) return reply({ ok: false, error: "WRONG_RECEIVER" });
    if (amount < (cfg.minSlipAmount || 1)) return reply({ ok: false, error: "AMOUNT_TOO_LOW" });
    const age = Date.now() - new Date(raw.date).getTime();
    if (!(age < (cfg.slipMaxAgeHours || 24) * 3600e3)) return reply({ ok: false, error: "SLIP_TOO_OLD" });
    slips[ref] = { player, amount, at: Date.now() }; fs.writeFileSync(SFILE, JSON.stringify(slips, null, 1));
    redeemed["slip-" + ref] = { player, amount, at: Date.now(), status: "ok" }; fs.writeFileSync(RFILE, JSON.stringify(redeemed, null, 1));   // ให้ขึ้นกำแพงผู้โดเนท
    queue.push({ id: "slip-" + ref, player, amount, message: "slip", at: Date.now() }); save();
    discord(player, amount, null, "โอนพร้อมเพย์ + สลิป (ตรวจอัตโนมัติ)");
    return reply({ ok: true, amount });
  } catch (e) { console.error("slip error", e); return reply({ ok: false, error: "UNKNOWN_CHECK_ADMIN" }); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const authed = req.headers["x-api-key"] === cfg.apiKey;
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); const a = path.join(__dirname, "public", "index.html"), b = path.join(__dirname, "index.html"); return res.end(fs.readFileSync(fs.existsSync(a) ? a : b)); }
    if (req.method === "GET" && url.pathname === "/info") {
      const wall = Object.values(redeemed).filter((x) => x.status === "ok").sort((a, b) => b.at - a.at).slice(0, 10).map((x) => ({ player: x.player, amount: x.amount, at: x.at }));
      return send(res, 200, { slip: !!cfg.easyslipKey, phone: cfg.displayPhone, coin: cfg.coinName, rate: cfg.rate, bonus: cfg.bonus, wall });
    }
    if (req.method === "POST" && url.pathname === "/web/redeem") return redeem(req, res, true);
    if (req.method === "POST" && url.pathname === "/web/slip") return slipVerify(req, res);
    if (req.method === "POST" && url.pathname === "/webhook") {
      if (url.searchParams.get("key") !== cfg.webhookSecret) return send(res, 403, { error: "forbidden" });
      const raw = await readBody(req);
      fs.appendFileSync(path.join(__dirname, "raw.log"), new Date().toISOString() + " " + raw + "\n");
      let body; try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
      const d = normalize(body.data && typeof body.data === "object" ? { ...body, ...body.data } : body);
      if (!queue.some((q) => q.id === d.id)) { queue.push(d); save(); console.log("รับโดเนท", d); }
      return send(res, 200, { ok: true });
    }
    if (!authed) return send(res, 403, { error: "forbidden" });
    if (req.method === "POST" && url.pathname === "/notify") { const b = JSON.parse(await readBody(req)); discord(b.player, b.amount, b.coins, b.via || "แอดมินอนุมัติ"); return send(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/redeem") return redeem(req, res);
    if (req.method === "GET" && url.pathname === "/pending") {
      queue = queue.filter((q) => Date.now() - q.at < cfg.expireHours * 3600e3); save();
      return send(res, 200, { donations: queue });
    }
    if (req.method === "POST" && url.pathname === "/ack") {
      const { id } = JSON.parse(await readBody(req));
      queue = queue.filter((q) => q.id !== id); save();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e) }); }
}).listen(process.env.PORT || cfg.port, () => console.log("donate relay พร้อมที่พอร์ต", cfg.port));
