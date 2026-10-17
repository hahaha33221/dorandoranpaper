/*
 * 도란도란 API 서버 (의존성 없음: node:http + node:sqlite)
 *
 *   환경 변수
 *   - PORT          기본 8787
 *   - DATA_DIR      DB/seed 위치, 기본 ./data
 *   - STATIC_DIR    지정하면 정적 파일도 함께 제공 (로컬 개발용: public)
 *   - DEV=1         정적 HTML에 자동 새로고침 스크립트 삽입
 */
import { createServer } from "node:http";
import { createReadStream, statSync, watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import crypto from "node:crypto";
import { openDb, importSeed, verifyPassword, hashPassword } from "./db.mjs";
import { setupPhotos } from "./photos.mjs";

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const DEV = process.env.DEV === "1";

const SESSION_HOURS = 24; // 로그인 유지 시간 (모든 계정 공통, 지나면 자동 로그아웃)
const MAX_LETTER = 5000;
const PASSWORD_MIN = 6, PASSWORD_MAX = 64;
const SENDER_SUFFIX = " 선생님"; // 보낸 사람 이름 뒤 호칭
const MAX_BODY = 64 * 1024;

const db = openDb(join(DATA_DIR, "doran.db"));
const seeded = importSeed(db, join(DATA_DIR, "seed.json"));
if (seeded) console.log(`seed.json 반영: 계정 ${seeded.users}개, 새 편지 ${seeded.letters}통`);
const photos = setupPhotos(db, DATA_DIR);
function upcomingSessions() {
  try { return JSON.parse(q.getSetting.get("upcoming_sessions")?.value || "[]"); } catch { return []; }
}
// 예전에 더 길게 잡힌 로그인(멘토 7일 등)도 지금부터 최대 24시간으로
db.prepare("UPDATE sessions SET expires_at = min(expires_at, ?)").run(Date.now() + SESSION_HOURS * 3600 * 1000);

const q = {
  userByLogin: db.prepare("SELECT * FROM users WHERE login = ?"),
  session: db.prepare(`
    SELECT u.id, u.role, u.name, u.full_name, u.grade, u.pw_changed, u.pw_hash FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  delSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  delOtherSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?"),
  setPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 1 WHERE id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  // 관리자
  adminUsers: db.prepare(`
    SELECT u.id, u.login, u.role, u.name, u.full_name, u.grade, u.pw_changed, u.last_login_at,
      (SELECT count(*) FROM letters l WHERE l.mentor_id = u.id) AS written,
      (SELECT count(*) FROM letters l WHERE l.mentee_id = u.id) AS received,
      (SELECT max(updated_at) FROM letters l WHERE l.mentor_id = u.id) AS last_written_at
    FROM users u WHERE u.role IN ('mentor', 'mentee') ORDER BY u.role, u.sort, u.id`),
  adminLetters: db.prepare("SELECT mentor_id, mentee_id, updated_at, length(body) AS len FROM letters"),
  adminLetter: db.prepare(`
    SELECT l.body, l.updated_at, m.name AS mentor, e.full_name AS mentee FROM letters l
    JOIN users m ON m.id = l.mentor_id JOIN users e ON e.id = l.mentee_id
    WHERE l.mentor_id = ? AND l.mentee_id = ?`),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  resetPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 2 WHERE id = ?"), // 2 = 관리자 발급
  delUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  menteeLetters: db.prepare(`
    SELECT m.name AS mentor, l.body FROM letters l
    JOIN users m ON m.id = l.mentor_id
    WHERE l.mentee_id = ? AND trim(l.body) <> ''
    ORDER BY m.sort, m.id`),
  mentorMentees: db.prepare(`
    SELECT u.id, u.name, u.full_name, u.grade, COALESCE(l.body, '') AS body, l.updated_at
    FROM users u
    LEFT JOIN letters l ON l.mentee_id = u.id AND l.mentor_id = ?
    WHERE u.role = 'mentee'
    ORDER BY u.sort, u.id`),
  isMentee: db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'mentee'"),
  upsertLetter: db.prepare(`
    INSERT INTO letters (mentor_id, mentee_id, body, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(mentor_id, mentee_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`),
  deleteLetter: db.prepare("DELETE FROM letters WHERE mentor_id = ? AND mentee_id = ?"),
  // 사진첩 (ready = 변환 끝, 오류 없음)
  albums: db.prepare(`
    SELECT a.*, (SELECT count(*) FROM photos p WHERE p.album_id = a.id AND p.error IS NULL AND p.sig <> 'pending' AND (p.hidden = 0 OR ?)) AS count
    FROM albums a WHERE (a.hidden = 0 OR ?)
    ORDER BY a.session IS NULL, a.session, a.date IS NULL, a.date, a.folder`), // 1회차부터
  album: db.prepare("SELECT * FROM albums WHERE id = ? AND (hidden = 0 OR ?)"),
  albumPhotos: db.prepare(`
    SELECT id, width, height, taken_at, hidden FROM photos
    WHERE album_id = ? AND error IS NULL AND sig <> 'pending' AND (hidden = 0 OR ?)
    ORDER BY taken_at IS NULL, taken_at, src`),
  photoForFile: db.prepare(`
    SELECT p.id, p.album_id, a.date, a.title, a.hidden AS album_hidden, p.hidden FROM photos p
    JOIN albums a ON a.id = p.album_id WHERE p.id = ?`),
  photoErrors: db.prepare("SELECT count(*) AS n FROM photos WHERE error IS NOT NULL"),
  setAlbum: db.prepare(`UPDATE albums SET
    title = COALESCE(?, title), title_custom = CASE WHEN ? IS NULL THEN title_custom ELSE 1 END,
    description = COALESCE(?, description), hidden = COALESCE(?, hidden), cover_id = COALESCE(?, cover_id)
    WHERE id = ?`),
  setPhotoHidden: db.prepare("UPDATE photos SET hidden = ? WHERE id = ?"),
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  putSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
};

/* ---------- 로그인 시도 제한 (IP별, 아이디별) ---------- */
const attempts = new Map();
const LIMIT = 10, WINDOW_MS = 10 * 60 * 1000;
function tooMany(...keys) {
  const now = Date.now();
  return keys.some((k) => {
    const a = attempts.get(k);
    return a && a.until > now && a.count >= LIMIT;
  });
}
function recordFail(...keys) {
  const now = Date.now();
  for (const k of keys) {
    const a = attempts.get(k);
    if (!a || a.until <= now) attempts.set(k, { count: 1, until: now + WINDOW_MS });
    else a.count++;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
  q.purgeSessions.run(now);
}, 10 * 60 * 1000).unref();

/* ---------- 유틸 ---------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeLogin = (s) => String(s || "").normalize("NFC").trim().toLowerCase();

function clientIp(req) {
  return (
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress
  );
}

function send(res, status, data) {
  const body = data === undefined ? "" : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { fail(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", fail);
  });
}

function auth(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return q.session.get(sha256(m[1]), Date.now()) || null;
}

const publicUser = (u) => ({
  role: u.role, name: u.name, fullName: u.full_name, grade: u.grade, mustChangePassword: u.pw_changed !== 1
});

/* ---------- API ---------- */
async function api(req, res, path) {
  const method = req.method;

  if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true });

  // 사진 파일 (서명된 주소로만, <img> 는 로그인 헤더를 못 보내므로)
  const pm = path.match(/^\/api\/photos\/(\d+)\/([tl])$/);
  if (pm && method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const [id, size] = [Number(pm[1]), pm[2]];
    if (!photos.verify(id, size, url.searchParams.get("e"), url.searchParams.get("s"))) return send(res, 403, { error: "만료된 주소예요. 새로고침해 주세요." });
    const file = photos.filePath(id, size);
    let st;
    try { st = statSync(file); } catch { return send(res, 404, { error: "사진이 없어요." }); }
    const headers = {
      "Content-Type": photos.SIZES[size].type,
      "Content-Length": st.size,
      "Cache-Control": "private, max-age=21600",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff"
    };
    res.writeHead(200, headers);
    return createReadStream(file).pipe(res);
  }

  if (path === "/api/login" && method === "POST") {
    const { login, password } = await readJson(req);
    const id = normalizeLogin(login);
    const ip = "ip:" + clientIp(req), key = "id:" + id;
    if (tooMany(ip, key)) return send(res, 429, { error: "로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    const user = id && q.userByLogin.get(id);
    const ok = user && typeof password === "string" && verifyPassword(password.trim(), user.pw_hash);
    if (!ok) {
      recordFail(ip, key);
      return send(res, 401, { error: "아이디 또는 비밀번호를 다시 확인해 주세요." });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_HOURS * 3600 * 1000;
    q.addSession.run(sha256(token), user.id, expiresAt);
    q.touchLogin.run(user.id);
    return send(res, 200, { token, expiresAt, user: publicUser(user) });
  }

  const user = auth(req);
  if (!user) return send(res, 401, { error: "로그인이 필요해요." });

  if (path === "/api/logout" && method === "POST") {
    const token = String(req.headers.authorization).split(/\s+/)[1];
    q.delSession.run(sha256(token));
    return send(res, 204);
  }

  if (path === "/api/me" && method === "GET") return send(res, 200, { user: publicUser(user) });

  // 비밀번호 변경 (본인)
  if (path === "/api/password" && method === "POST") {
    const { current, next } = await readJson(req);
    const key = "pw:" + user.id;
    if (tooMany(key)) return send(res, 429, { error: "시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    if (typeof current !== "string" || !verifyPassword(current.trim(), user.pw_hash)) {
      recordFail(key);
      return send(res, 400, { error: "지금 비밀번호가 맞지 않아요.", field: "current" });
    }
    const pw = typeof next === "string" ? next.trim() : "";
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
      return send(res, 400, { error: `새 비밀번호는 ${PASSWORD_MIN}자 이상으로 정해 주세요.`, field: "next" });
    }
    if (pw === current.trim()) return send(res, 400, { error: "지금 비밀번호와 다른 비밀번호로 정해 주세요.", field: "next" });
    q.setPassword.run(hashPassword(pw), user.id);
    const token = String(req.headers.authorization).split(/\s+/)[1];
    q.delOtherSessions.run(user.id, sha256(token)); // 다른 기기 로그인은 끊기
    return send(res, 200, { ok: true });
  }

  /* ----- 사진첩 (멘티, 관리자) ----- */
  if (path === "/api/albums" || path.startsWith("/api/albums/")) {
    if (user.role !== "mentee" && user.role !== "admin") return send(res, 403, { error: "사진첩은 멘티만 볼 수 있어요." });
    const isAdmin = user.role === "admin" ? 1 : 0;
    const photoOut = (p) => ({
      id: p.id, w: p.width, h: p.height, takenAt: p.taken_at, hidden: !!p.hidden,
      thumb: photos.url(p.id, "t"), large: photos.url(p.id, "l")
    });
    if (path === "/api/albums" && method === "GET") {
      const all = q.albums.all(isAdmin, isAdmin);
      const albums = all.filter((a) => isAdmin || a.count > 0).map((a) => {
        const list = q.albumPhotos.all(a.id, 0);
        const cover = list.find((p) => p.id === a.cover_id) || list[0];
        const previews = [cover, ...list.filter((p) => p !== cover)].filter(Boolean).slice(0, 4).map((p) => photos.url(p.id, "t"));
        return { id: a.id, session: a.session, date: a.date, title: a.title, description: a.description, count: a.count, previews, hidden: !!a.hidden, folder: isAdmin ? a.folder : undefined };
      });
      // '준비 중' 회차: 그 회차 사진이 아직 하나도 안 보이면 자리 표시 카드
      const upcoming = upcomingSessions();
      const shown = new Set(all.filter((a) => a.count > 0 && !a.hidden).map((a) => a.session));
      for (const n of upcoming) {
        if (!shown.has(n)) albums.push({ id: null, session: n, title: `${n}회차`, count: 0, previews: [], upcoming: true });
      }
      albums.sort((x, y) => (x.session ?? 1e9) - (y.session ?? 1e9));
      const out = { albums, upcomingSessions: isAdmin ? upcoming : undefined };
      if (isAdmin) out.status = { ...photos.status, ...photos.syncInfo(), errors: q.photoErrors.get().n };
      return send(res, 200, out);
    }
    const am = path.match(/^\/api\/albums\/(\d+)$/);
    if (am && method === "GET") {
      const a = q.album.get(Number(am[1]), isAdmin);
      if (!a) return send(res, 404, { error: "앨범을 찾을 수 없어요." });
      return send(res, 200, {
        album: { id: a.id, date: a.date, title: a.title, description: a.description, hidden: !!a.hidden, coverId: a.cover_id },
        photos: q.albumPhotos.all(a.id, isAdmin).map(photoOut)
      });
    }
    return send(res, 404, { error: "Not found" });
  }

  /* ----- 관리자 ----- */
  if (path.startsWith("/api/admin/")) {
    if (user.role !== "admin") return send(res, 403, { error: "관리자만 볼 수 있어요." });

    if (path === "/api/admin/overview" && method === "GET") {
      const users = q.adminUsers.all().map((u) => ({
        id: u.id, login: u.login, role: u.role, name: u.name, fullName: u.full_name, grade: u.grade,
        pwChanged: u.pw_changed === 1, tempIssued: u.pw_changed === 2, lastLoginAt: u.last_login_at,
        written: u.written, received: u.received, lastWrittenAt: u.last_written_at
      }));
      const letters = q.adminLetters.all().map((l) => ({
        mentorId: l.mentor_id, menteeId: l.mentee_id, updatedAt: l.updated_at, length: l.len
      }));
      return send(res, 200, {
        mentors: users.filter((u) => u.role === "mentor"),
        mentees: users.filter((u) => u.role === "mentee"),
        letters
      });
    }

    const lm = path.match(/^\/api\/admin\/letters\/(\d+)\/(\d+)$/);
    if (lm && method === "GET") {
      const l = q.adminLetter.get(Number(lm[1]), Number(lm[2]));
      if (!l) return send(res, 404, { error: "편지가 없어요." });
      return send(res, 200, { from: l.mentor + SENDER_SUFFIX, to: l.mentee, body: l.body, updatedAt: l.updated_at });
    }

    const rm = path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
    if (rm && method === "POST") {
      const target = q.userById.get(Number(rm[1]));
      if (!target || target.role === "admin") return send(res, 404, { error: "계정을 찾을 수 없어요." });
      const temp = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      q.resetPassword.run(hashPassword(temp), target.id);
      q.delUserSessions.run(target.id);
      console.log(`[admin] ${user.name} → ${target.login} 임시 비밀번호 발급`);
      return send(res, 200, { login: target.login, name: target.full_name, password: temp });
    }

    // 사진첩 관리
    const aa = path.match(/^\/api\/admin\/albums\/(\d+)$/);
    if (aa && method === "PATCH") {
      const b = await readJson(req);
      const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : null);
      const title = str(b.title, 60);
      q.setAlbum.run(title || null, title || null, str(b.description, 300), typeof b.hidden === "boolean" ? Number(b.hidden) : null,
        Number.isInteger(b.coverId) ? b.coverId : null, Number(aa[1]));
      return send(res, 200, { ok: true });
    }
    const ap = path.match(/^\/api\/admin\/photos\/(\d+)$/);
    if (ap && method === "PATCH") {
      const b = await readJson(req);
      if (typeof b.hidden !== "boolean") return send(res, 400, { error: "잘못된 요청이에요." });
      q.setPhotoHidden.run(Number(b.hidden), Number(ap[1]));
      return send(res, 200, { ok: true });
    }
    if (path === "/api/admin/settings/upcoming" && method === "PUT") {
      const b = await readJson(req);
      const list = [...new Set((Array.isArray(b.sessions) ? b.sessions : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100))].sort((x, y) => x - y);
      q.putSetting.run("upcoming_sessions", JSON.stringify(list));
      return send(res, 200, { ok: true, sessions: list });
    }
    if (path === "/api/admin/photos/scan" && method === "POST") {
      photos.requestSync(); // 원드라이브 동기화 + 변환 (백그라운드)
      return send(res, 202, { ok: true });
    }

    return send(res, 404, { error: "Not found" });
  }

  // 멘티: 받은 편지
  if (path === "/api/letters" && method === "GET") {
    if (user.role !== "mentee") return send(res, 403, { error: "멘티만 볼 수 있어요." });
    const letters = q.menteeLetters.all(user.id).map((l) => ({ from: l.mentor + SENDER_SUFFIX, body: l.body }));
    return send(res, 200, { name: user.name, letters });
  }

  // 멘토: 멘티 목록 + 내가 쓴 편지
  if (path === "/api/mentor/mentees" && method === "GET") {
    if (user.role !== "mentor") return send(res, 403, { error: "멘토만 볼 수 있어요." });
    const mentees = q.mentorMentees.all(user.id).map((m) => ({
      id: m.id, name: m.name, fullName: m.full_name, grade: m.grade, body: m.body, updatedAt: m.updated_at
    }));
    return send(res, 200, { mentees });
  }

  // 멘토: 편지 저장 (빈 내용이면 삭제)
  const m = path.match(/^\/api\/mentor\/letters\/(\d+)$/);
  if (m && method === "PUT") {
    if (user.role !== "mentor") return send(res, 403, { error: "멘토만 쓸 수 있어요." });
    const menteeId = Number(m[1]);
    if (!q.isMentee.get(menteeId)) return send(res, 404, { error: "멘티를 찾을 수 없어요." });
    const { body } = await readJson(req);
    const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
    if (text.length > MAX_LETTER) return send(res, 400, { error: `편지는 ${MAX_LETTER}자까지 쓸 수 있어요.` });
    if (text) q.upsertLetter.run(user.id, menteeId, text);
    else q.deleteLetter.run(user.id, menteeId);
    return send(res, 200, { ok: true, body: text });
  }

  return send(res, 404, { error: "Not found" });
}

/* ---------- 정적 파일 (로컬 개발용) ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2"
};
const reloadClients = new Set();
if (STATIC_DIR && DEV) {
  let t;
  watch(STATIC_DIR, { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => { for (const r of reloadClients) r.write("data: reload\n\n"); }, 80);
  });
}

function serveStatic(req, res, pathname) {
  if (DEV && pathname === "/__reload") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": connected\n\n");
    reloadClients.add(res);
    req.on("close", () => reloadClients.delete(res));
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(STATIC_DIR)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  if (DEV && type.startsWith("text/html")) {
    let html = "";
    createReadStream(file, "utf8").on("data", (c) => (html += c)).on("end", () =>
      res.end(html.replace("</body>", '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script></body>'))
    );
  } else createReadStream(file).pipe(res);
}

/* ---------- 서버 ---------- */
createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) return await api(req, res, pathname);
    if (STATIC_DIR) return serveStatic(req, res, pathname);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? "잘못된 요청이에요." : "서버 오류가 났어요." });
    if (!e.status) console.error(e);
  }
}).listen(PORT, () => {
  console.log(`도란도란 서버: http://localhost:${PORT}${STATIC_DIR ? " (정적 파일 포함)" : ""}`);
});
