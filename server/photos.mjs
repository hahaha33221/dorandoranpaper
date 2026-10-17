/*
 * 사진첩: DATA_DIR/photos-src/<YYYY-MM-DD 활동명>/사진들  →  DB + 변환본(DATA_DIR/photos/<id>/)
 *
 * - 폴더 이름에서 날짜·활동명을 읽어 앨범을 만듭니다. (2026-10-12 쿠키 만들기 / 2026.10.12 / 261012 등)
 *   "1회차 활동사진"처럼 날짜가 없으면, 사진들의 촬영일(없으면 파일 이름 속 날짜) 중 가장 많은 날을 앨범 날짜로 씀
 * - 새 사진·바뀐 사진만 변환: 목록용 t.webp(긴 변 480), 크게 보기·다운로드용 l.jpg(긴 변 1600)
 *   방향 바로잡기(-auto-orient), 촬영 정보·GPS 제거(-strip)
 * - 원본 폴더에서 지운 사진/폴더는 사이트에서도 지움
 * - 변환 도구: ImageMagick(magick) — 없으면(맥 로컬 개발) sips 로 대체
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { promisify } from "node:util";
import crypto from "node:crypto";

const run = promisify(execFile);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".tif", ".tiff"]);

export function setupPhotos(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id           INTEGER PRIMARY KEY,
      folder       TEXT NOT NULL UNIQUE,
      date         TEXT,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      title_custom INTEGER NOT NULL DEFAULT 0,
      cover_id     INTEGER,
      hidden       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS photos (
      id        INTEGER PRIMARY KEY,
      album_id  INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      src       TEXT NOT NULL UNIQUE,
      sig       TEXT NOT NULL,
      taken_at  TEXT,
      width     INTEGER,
      height    INTEGER,
      hidden    INTEGER NOT NULL DEFAULT 0,
      error     TEXT
    );
    CREATE INDEX IF NOT EXISTS photos_album ON photos(album_id);
  `);
  const albumCols = db.prepare("PRAGMA table_info(albums)").all().map((c) => c.name);
  if (!albumCols.includes("session")) db.exec("ALTER TABLE albums ADD COLUMN session INTEGER");
  if (!albumCols.includes("date_from_folder")) db.exec("ALTER TABLE albums ADD COLUMN date_from_folder INTEGER NOT NULL DEFAULT 1");

  const SRC = join(dataDir, "photos-src");
  const OUT = join(dataDir, "photos");
  const REQUEST = join(SRC, ".scan-request"); // 이 파일이 생기면 1분 안에 다시 확인 (photos:sync 가 만듦)
  mkdirSync(SRC, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // 사진 주소 서명용 비밀값 (서버마다 한 번 만들어 보관)
  const keyFile = join(dataDir, "photo-url.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const KEY = readFileSync(keyFile, "utf8").trim();

  const q = {
    albumByFolder: db.prepare("SELECT * FROM albums WHERE folder = ?"),
    insertAlbum: db.prepare("INSERT INTO albums (folder, date, title, session, date_from_folder) VALUES (?, ?, ?, ?, ?)"),
    updateAlbumAuto: db.prepare(`UPDATE albums SET
      date = CASE WHEN ? = 1 THEN ? ELSE date END, date_from_folder = ?, session = ?,
      title = CASE WHEN title_custom = 1 THEN title ELSE ? END WHERE id = ?`),
    albumsNeedingDate: db.prepare("SELECT id FROM albums WHERE date_from_folder = 0"),
    commonDate: db.prepare(`SELECT substr(taken_at, 1, 10) AS d, count(*) AS n FROM photos
      WHERE album_id = ? AND taken_at IS NOT NULL GROUP BY d ORDER BY n DESC, d LIMIT 1`),
    setAlbumDate: db.prepare("UPDATE albums SET date = ? WHERE id = ?"),
    allAlbums: db.prepare("SELECT * FROM albums"),
    deleteAlbum: db.prepare("DELETE FROM albums WHERE id = ?"),
    photoBySrc: db.prepare("SELECT * FROM photos WHERE src = ?"),
    insertPhoto: db.prepare("INSERT INTO photos (album_id, src, sig, taken_at, width, height, error) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    updatePhoto: db.prepare("UPDATE photos SET album_id = ?, sig = ?, taken_at = ?, width = ?, height = ?, error = ? WHERE id = ?"),
    photosOfAlbum: db.prepare("SELECT id, src FROM photos WHERE album_id = ?"),
    allPhotoSrc: db.prepare("SELECT id, src FROM photos"),
    deletePhoto: db.prepare("DELETE FROM photos WHERE id = ?")
  };

  const status = { running: false, lastRunAt: null, lastError: null, processed: 0, pending: 0, failed: 0, tool: null };

  async function detectTool() {
    for (const [name, args] of [["magick", ["-version"]], ["sips", ["--help"]]]) {
      try { await run(name, args, { timeout: 10000 }); return name; } catch { /* 다음 후보 */ }
    }
    return null;
  }

  // 파일 이름 속 날짜·시각: 20260509_143012.jpg, KakaoTalk_20260615_101233456_01.jpg, KakaoTalk_Photo_2026-10-15-12-30-45 001.jpeg
  function dateFromName(file) {
    const base = file.split("/").pop();
    const m = base.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ ]?(\d{2})[-_.]?(\d{2})[-_.]?(\d{2}))?/);
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}`;
  }

  function parseFolder(name) {
    let m = name.match(/^(\d{4})[-._ ]?(\d{1,2})[-._ ]?(\d{1,2})[\s_\-.)]*(.*)$/);
    if (!m) {
      const s = name.match(/^(\d{2})(\d{2})(\d{2})[\s_\-.)]*(.*)$/);
      if (s) m = [s[0], "20" + s[1], s[2], s[3], s[4]];
    }
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        return { date, title: (m[4] || "").trim() || "활동 사진", session: null };
      }
    }
    const session = name.match(/(\d+)\s*회차/);
    return { date: null, title: name.trim(), session: session ? Number(session[1]) : null };
  }

  function listImages(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...listImages(p));
      else if (IMAGE_EXT.has(extname(e.name).toLowerCase())) out.push(p);
    }
    return out;
  }

  async function convert(tool, src, dir) {
    mkdirSync(dir, { recursive: true });
    const t = join(dir, "t.webp"), l = join(dir, "l.jpg");
    let takenAt = null, width = null, height = null;
    if (tool === "magick") {
      const input = src + "[0]";
      await run("magick", [input, "-auto-orient", "-strip", "-thumbnail", "480x480>", "-quality", "78", t], { timeout: 120000 });
      await run("magick", [input, "-auto-orient", "-strip", "-resize", "1600x1600>", "-quality", "84", "-interlace", "JPEG", l], { timeout: 120000 });
      try {
        const { stdout } = await run("magick", ["identify", "-format", "%[EXIF:DateTimeOriginal]|", input], { timeout: 30000 });
        const raw = stdout.split("|")[0].trim();
        const m = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (m) takenAt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
      } catch { /* 촬영 시각 없음 */ }
      const { stdout } = await run("magick", ["identify", "-format", "%w %h", l], { timeout: 30000 });
      [width, height] = stdout.trim().split(/\s+/).map(Number);
    } else {
      // 맥 로컬 개발용 (sips): 목록용도 jpg 로 만들어 같은 이름(t.webp)에 저장 — 브라우저는 내용으로 판단
      await run("sips", ["-s", "format", "jpeg", "-Z", "1600", src, "--out", l], { timeout: 120000 });
      await run("sips", ["-s", "format", "jpeg", "-Z", "480", src, "--out", t], { timeout: 120000 });
      const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", l], { timeout: 30000 });
      width = Number(stdout.match(/pixelWidth: (\d+)/)?.[1]) || null;
      height = Number(stdout.match(/pixelHeight: (\d+)/)?.[1]) || null;
    }
    return { takenAt, width, height };
  }

  // 폴더 이름에 날짜가 없는 앨범: 사진 날짜 중 가장 많은 날
  function fillAlbumDates() {
    for (const { id } of q.albumsNeedingDate.all()) {
      const r = q.commonDate.get(id);
      if (r?.d) q.setAlbumDate.run(r.d, id);
    }
  }

  async function scan() {
    if (status.running) return status;
    status.running = true;
    status.lastError = null;
    status.processed = 0;
    status.failed = 0;
    try {
      status.tool ||= await detectTool();
      if (!status.tool) throw new Error("이미지 변환 도구(ImageMagick)가 없어요.");

      const folders = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
      const seenSrc = new Set();
      const seenFolders = new Set();
      const work = [];

      for (const f of folders) {
        const { date, title, session } = parseFolder(f.name);
        const fromFolder = date ? 1 : 0;
        let album = q.albumByFolder.get(f.name);
        if (!album) album = { id: Number(q.insertAlbum.run(f.name, date, title, session, fromFolder).lastInsertRowid) };
        else q.updateAlbumAuto.run(fromFolder, date, fromFolder, session, title, album.id);
        seenFolders.add(f.name);

        for (const file of listImages(join(SRC, f.name))) {
          const rel = relative(SRC, file);
          const st = statSync(file);
          const sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
          seenSrc.add(rel);
          const row = q.photoBySrc.get(rel);
          if (!row || row.sig !== sig || row.album_id !== album.id) work.push({ rel, file, sig, albumId: album.id, row });
        }
      }

      // 원본에서 사라진 사진·앨범 정리
      for (const p of q.allPhotoSrc.all()) {
        if (!seenSrc.has(p.src)) {
          q.deletePhoto.run(p.id);
          rmSync(join(OUT, String(p.id)), { recursive: true, force: true });
        }
      }
      for (const a of q.allAlbums.all()) {
        if (!seenFolders.has(a.folder)) q.deleteAlbum.run(a.id);
      }

      status.pending = work.length;
      for (const w of work) {
        let id = w.row?.id;
        if (!id) id = Number(q.insertPhoto.run(w.albumId, w.rel, "pending", null, null, null, null).lastInsertRowid);
        try {
          const meta = await convert(status.tool, w.file, join(OUT, String(id)));
          q.updatePhoto.run(w.albumId, w.sig, meta.takenAt || dateFromName(w.rel), meta.width, meta.height, null, id);
          status.processed++;
        } catch (e) {
          q.updatePhoto.run(w.albumId, w.sig, null, null, null, String(e.message || e).slice(0, 300), id);
          status.failed++;
        }
        status.pending--;
        if (status.processed % 20 === 0) fillAlbumDates();
      }
      fillAlbumDates();
      if (work.length) console.log(`[photos] 변환 ${status.processed}장, 실패 ${status.failed}장`);
    } catch (e) {
      status.lastError = String(e.message || e);
      console.error("[photos]", status.lastError);
    } finally {
      status.running = false;
      status.lastRunAt = new Date().toISOString();
    }
    return status;
  }

  // 시작할 때, 매 30분, 그리고 .scan-request 가 생기면 1분 안에
  setTimeout(scan, 3000).unref();
  setInterval(scan, 30 * 60 * 1000).unref();
  // .scan-request 는 rsync(root) 가 만들어 지우지 못할 수 있으니 수정 시각으로 판단
  let handledRequest = existsSync(REQUEST) ? statSync(REQUEST).mtimeMs : 0;
  setInterval(() => {
    if (status.running || !existsSync(REQUEST)) return;
    const t = statSync(REQUEST).mtimeMs;
    if (t > handledRequest) { handledRequest = t; scan(); }
  }, 60 * 1000).unref();

  /* ---------- 서명된 사진 주소 ---------- */
  const SIZES = { t: { file: "t.webp", type: "image/webp" }, l: { file: "l.jpg", type: "image/jpeg" } };
  function sign(id, size, exp) {
    return crypto.createHmac("sha256", KEY).update(`${id}.${size}.${exp}`).digest("base64url").slice(0, 22);
  }
  function url(id, size) {
    const exp = Math.ceil(Date.now() / 3600000) * 3600 + 6 * 3600; // 6~7시간 유효, 1시간 단위(브라우저 캐시 재사용)
    return `/api/photos/${id}/${size}?e=${exp}&s=${sign(id, size, exp)}`;
  }
  function verify(id, size, exp, s) {
    if (!SIZES[size] || !/^\d+$/.test(String(exp)) || Number(exp) < Date.now() / 1000) return false;
    const want = Buffer.from(sign(id, size, exp)), got = Buffer.from(String(s || ""));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  function filePath(id, size) {
    return join(OUT, String(id), SIZES[size].file);
  }

  // 관리자 '지금 확인': 원드라이브 동기화 컨테이너에 바로 가져오라고 알리고, 이미 받은 사진도 바로 확인
  function requestSync() {
    try { writeFileSync(join(SRC, ".sync-now"), new Date().toISOString()); } catch { /* 동기화 미사용 */ }
    scan();
  }
  function syncInfo() {
    const read = (f) => { try { return readFileSync(join(SRC, f), "utf8").trim(); } catch { return null; } };
    return { lastSyncAt: read(".last-sync"), lastSyncErrorAt: read(".last-sync-error") };
  }

  return { scan, status, url, verify, filePath, SIZES, requestSync, syncInfo };
}
