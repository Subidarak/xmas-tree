'use strict';
/* 圣诞树 · 好友挂祝福 API
 * 无第三方依赖，只用 Node 内置模块。
 * 两个接口：GET /api/gifts   POST /api/gift
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT       = Number(process.env.PORT || 3000);
const DATA_DIR   = process.env.DATA_DIR || '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const GIFTS_FILE = path.join(DATA_DIR, 'gifts.json');

/* ---- 容量：一棵树挂满就自动开下一棵 ---- */
const PER_TREE       = 12;              // 每棵树最多挂几张（与页面 MAX_PHOTO 对齐）
const MAX_TREES      = 10;              // 最多几棵（10 × 12 = 120 张）
const PER_IP_PER_DAY = 3;               // 单 IP 每天
const GLOBAL_PER_MIN = 10;              // 全站每分钟
const MAX_NAME       = 12;
const MAX_MSG        = 40;
const MAX_IMAGE      = 800 * 1024;      // 单张解码后
const MAX_BODY       = 1400 * 1024;     // 请求体上限（base64 膨胀后）

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let gifts = [];
try {
  gifts = JSON.parse(fs.readFileSync(GIFTS_FILE, 'utf8'));
} catch (e) {
  gifts = [];
}
if (!Array.isArray(gifts)) gifts = [];

/* 老数据没有 tree 字段，一律归到第 1 棵 */
for (var _i = 0; _i < gifts.length; _i++) {
  if (!gifts[_i].tree) gifts[_i].tree = 1;
}

/* ---- 落盘：串行队列，避免并发写坏文件 ---- */
let chain = Promise.resolve();
function persist() {
  const snap = JSON.stringify(gifts);
  chain = chain.then(function () {
    return fs.promises.writeFile(GIFTS_FILE + '.tmp', snap)
      .then(function () { return fs.promises.rename(GIFTS_FILE + '.tmp', GIFTS_FILE); });
  }).catch(function (e) {
    console.error('[persist] failed:', e.message);
  });
  return chain;
}

/* ---- 树：统计每棵挂了几张，找第一棵还有空位的 ---- */
function treeStats() {
  var counts = {};
  var maxT = 0;
  for (var i = 0; i < gifts.length; i++) {
    var t = gifts[i].tree || 1;
    counts[t] = (counts[t] || 0) + 1;
    if (t > maxT) maxT = t;
  }
  return { counts: counts, maxT: maxT };
}

/* 返回第一个没挂满的树号；全部挂满返回 0 */
function pickTree() {
  var st = treeStats();
  for (var t = 1; t <= MAX_TREES; t++) {
    if ((st.counts[t] || 0) < PER_TREE) return t;
  }
  return 0;
}

/* ---- 限流状态 ---- */
const ipDay  = new Map();   // ipHash -> { day, n }
const recent = [];          // 最近一分钟的时间戳

function dayKey() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 按东八区算一天
}

function ipHash(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = fwd || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/* ---- 魔数校验：不信 Content-Type，只看文件头 ---- */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) {
        const err = new Error('BIG');
        err.code = 'BIG';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

const server = http.createServer(function (req, res) {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch (e) { return send(res, 400, { ok: false }); }
  const p = url.pathname;

  if (p === '/api/health') {
    const hs = treeStats();
    return send(res, 200, {
      ok: true,
      total: gifts.length,
      trees: Math.max(1, hs.maxT),
      perTree: PER_TREE,
      full: gifts.length >= MAX_TREES * PER_TREE
    });
  }

  /* ---- 拉列表 ---- */
  if (p === '/api/gifts' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0) || 0;
    const st = treeStats();
    const list = gifts
      .filter(function (g) { return g.ts > since; })
      .map(function (g) {
        return {
          id: g.id, name: g.name, msg: g.msg,
          url: '/uploads/' + g.file, ts: g.ts,
          tree: g.tree || 1
        };
      });
    return send(res, 200, {
      ok: true,
      total: gifts.length,
      trees: Math.max(1, st.maxT),        /* 当前一共几棵树，至少 1 */
      perTree: PER_TREE,
      full: gifts.length >= MAX_TREES * PER_TREE,
      gifts: list
    });
  }

  /* ---- 挂一个祝福 ---- */
  if (p === '/api/gift' && req.method === 'POST') {
    if (gifts.length >= MAX_TREES * PER_TREE) {
      return send(res, 507, { ok: false, code: 'FULL', msg: '十棵树都挂满啦' });
    }

    const now = Date.now();
    while (recent.length && now - recent[0] > 60000) recent.shift();
    if (recent.length >= GLOBAL_PER_MIN) {
      return send(res, 429, { ok: false, code: 'RATE', msg: '挂得太快啦，歇一会儿再来' });
    }

    const ip = ipHash(req);
    const day = dayKey();
    let rec = ipDay.get(ip);
    if (!rec || rec.day !== day) { rec = { day: day, n: 0 }; ipDay.set(ip, rec); }
    if (rec.n >= PER_IP_PER_DAY) {
      return send(res, 429, { ok: false, code: 'RATE', msg: '今天挂够啦，明天再来' });
    }

    readBody(req, MAX_BODY).then(function (buf) {
      let data;
      try { data = JSON.parse(buf.toString('utf8')); }
      catch (e) { return send(res, 400, { ok: false, code: 'BAD', msg: '请求格式不对' }); }

      const name = String(data.name || '').trim().slice(0, MAX_NAME);
      const msg  = String(data.msg || '').trim().slice(0, MAX_MSG);
      if (!name) return send(res, 400, { ok: false, code: 'BAD', msg: '写个名字吧' });
      if (!msg)  return send(res, 400, { ok: false, code: 'BAD', msg: '写一句话吧' });

      const m = /^data:image\/(?:jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(data.photo || ''));
      if (!m) return send(res, 400, { ok: false, code: 'BAD', msg: '照片格式不对' });

      let img;
      try { img = Buffer.from(m[1], 'base64'); }
      catch (e) { return send(res, 400, { ok: false, code: 'BAD', msg: '照片解不开' }); }

      if (!img.length || img.length > MAX_IMAGE) {
        return send(res, 413, { ok: false, code: 'BIG', msg: '图太大了，换一张小的' });
      }
      if (!sniff(img)) {
        return send(res, 400, { ok: false, code: 'BAD', msg: '这不是图片' });
      }

      const id = crypto.randomBytes(3).toString('hex');  // 服务端生成，绝不用客户端的文件名
      const file = id + '.jpg';

      /* 关键：查空位 + 占位必须在同一个同步块里完成。
         否则两个并发请求会看到同一个空位，都塞进同一棵树，导致那棵树超过 12 张。 */
      const tree = pickTree();
      if (!tree) {
        return send(res, 507, { ok: false, code: 'FULL', msg: '十棵树都挂满啦' });
      }

      const entry = {
        id: id, name: name, msg: msg, file: file,
        ts: Date.now(), ip: ip, tree: tree
      };
      gifts.push(entry);
      rec.n += 1;
      recent.push(Date.now());

      fs.promises.writeFile(path.join(UPLOAD_DIR, file), img).then(function () {
        return persist();
      }).then(function () {
        send(res, 200, {
          ok: true,
          id: id,
          tree: tree,
          total: gifts.length,
          trees: Math.max(1, treeStats().maxT)
        });
      }).catch(function (e) {
        /* 落盘失败：把刚占的位子撤回，别留幽灵记录 */
        var idx = gifts.indexOf(entry);
        if (idx >= 0) gifts.splice(idx, 1);
        rec.n -= 1;
        console.error('[write] failed:', e.message);
        send(res, 500, { ok: false, code: 'ERR', msg: '服务器开小差了' });
      });
    }).catch(function (e) {
      if (e && e.code === 'BIG') {
        return send(res, 413, { ok: false, code: 'BIG', msg: '图太大了，换一张小的' });
      }
      send(res, 400, { ok: false, code: 'BAD', msg: '读取失败' });
    });
    return;
  }

  send(res, 404, { ok: false, code: 'NF' });
});

server.listen(PORT, function () {
  console.log('[gift-api] listening on :' + PORT + ' data=' + DATA_DIR + ' total=' + gifts.length);
});
