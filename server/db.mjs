import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      login         TEXT NOT NULL UNIQUE,
      pw_hash       TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('mentee', 'mentor', 'admin')),
      name          TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      grade         TEXT NOT NULL DEFAULT '',
      sort          INTEGER NOT NULL DEFAULT 0,
      pw_changed    INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS letters (
      mentor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mentee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mentor_id, mentee_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);

  migrate(db);
  return db;
}

/* ---------- 마이그레이션 (예전 DB → 지금 구조) ---------- */
const USERS_DDL = `CREATE TABLE users_new (
      id            INTEGER PRIMARY KEY,
      login         TEXT NOT NULL UNIQUE,
      pw_hash       TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('mentee', 'mentor', 'admin')),
      name          TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      grade         TEXT NOT NULL DEFAULT '',
      sort          INTEGER NOT NULL DEFAULT 0,
      pw_changed    INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT
    );`;

function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  // pw_changed: 비밀번호를 직접 바꿨는지 (1이면 seed.json 이 덮어쓰지 않음)
  if (!cols.includes("pw_changed")) db.exec("ALTER TABLE users ADD COLUMN pw_changed INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("last_login_at")) db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");

  // role 에 'admin' 추가 — SQLite 는 CHECK 를 바꿀 수 없어 표를 새로 만들어 옮김 (편지/세션은 그대로)
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
  if (!ddl.includes("'admin'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(USERS_DDL);
      db.exec(`INSERT INTO users_new (id, login, pw_hash, role, name, full_name, grade, sort, pw_changed, last_login_at)
               SELECT id, login, pw_hash, role, name, full_name, grade, sort, pw_changed, last_login_at FROM users`);
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_new RENAME TO users");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error("foreign key check failed: " + JSON.stringify(broken));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/* ---------- 비밀번호 ---------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/*
 * seed.json (npm run seed 로 생성) 을 DB에 반영.
 * - 계정은 login 기준으로 추가/갱신. 비밀번호는 처음 비밀번호 그대로인 경우에만 갱신
 *   (pw_changed: 0 처음 비밀번호, 1 본인이 바꿈, 2 관리자가 임시 비밀번호 발급)
 * - 편지는 DB에 아직 없는 것만 추가 → 웹에서 쓴 편지를 덮어쓰지 않음
 * 반영 후 파일은 seed.imported-<시각>.json 으로 이름을 바꿔 다시 적용되지 않게 합니다.
 */
export function importSeed(db, file) {
  if (!existsSync(file)) return null;
  const seed = JSON.parse(readFileSync(file, "utf8"));
  const upsertUser = db.prepare(`
    INSERT INTO users (login, pw_hash, role, name, full_name, grade, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(login) DO UPDATE SET
      pw_hash = CASE WHEN users.pw_changed = 0 THEN excluded.pw_hash ELSE users.pw_hash END,
      role = excluded.role, name = excluded.name,
      full_name = excluded.full_name, grade = excluded.grade, sort = excluded.sort
  `);
  const idOf = db.prepare("SELECT id FROM users WHERE login = ?");
  const insertLetter = db.prepare(
    "INSERT OR IGNORE INTO letters (mentor_id, mentee_id, body) VALUES (?, ?, ?)"
  );

  let users = 0, letters = 0;
  db.exec("BEGIN");
  try {
    for (const u of seed.users || []) {
      upsertUser.run(u.login, u.pw_hash, u.role, u.name, u.full_name || u.name, u.grade || "", u.sort || 0);
      users++;
    }
    for (const l of seed.letters || []) {
      const mentor = idOf.get(l.mentor), mentee = idOf.get(l.mentee);
      if (mentor && mentee && l.body) letters += Number(insertLetter.run(mentor.id, mentee.id, l.body).changes);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  renameSync(file, file.replace(/\.json$/, `.imported-${Date.now()}.json`));
  return { users, letters };
}
