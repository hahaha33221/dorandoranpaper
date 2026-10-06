#!/usr/bin/env node
/*
 * 관리자 도구 (비밀번호 찾기 문의 처리)
 *
 *   node server/admin.mjs list                       계정 목록 (비밀번호 변경 여부 포함)
 *   node server/admin.mjs find <이름>                이름으로 아이디 찾기
 *   node server/admin.mjs reset-password <아이디>    임시 비밀번호 새로 발급 (6자리 숫자)
 *
 * VPS 에서:  ssh root@srv1809055.hstgr.cloud 'cd /opt/dorandoran && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs reset-password <아이디>'
 */
import { join, resolve } from "node:path";
import crypto from "node:crypto";
import { openDb, hashPassword } from "./db.mjs";

const db = openDb(join(resolve(process.env.DATA_DIR || "data"), "doran.db"));
const [cmd, arg] = process.argv.slice(2);
const ROLE = { mentee: "멘티", mentor: "멘토" };

function table(rows) {
  if (!rows.length) return console.log("(없음)");
  for (const u of rows) {
    console.log(
      [u.login.padEnd(8), ROLE[u.role], (u.full_name + (u.grade ? ` (${u.grade})` : "")).padEnd(14, "　"), u.pw_changed ? "직접 변경함" : "초기 비밀번호"].join("  ")
    );
  }
}

switch (cmd) {
  case "list":
    table(db.prepare("SELECT * FROM users ORDER BY role DESC, sort, id").all());
    break;

  case "find": {
    if (!arg) { console.error("사용법: find <이름>"); process.exit(1); }
    table(db.prepare("SELECT * FROM users WHERE name LIKE ? OR full_name LIKE ? ORDER BY role DESC, sort").all(`%${arg}%`, `%${arg}%`));
    break;
  }

  case "reset-password": {
    const login = String(arg || "").trim().toLowerCase();
    const user = login && db.prepare("SELECT * FROM users WHERE login = ?").get(login);
    if (!user) { console.error(`아이디 '${arg ?? ""}' 를 찾을 수 없어요. (find <이름> 으로 찾아보세요)`); process.exit(1); }
    const temp = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 0 WHERE id = ?").run(hashPassword(temp), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    console.log(`${user.full_name} (${ROLE[user.role]}, 아이디 ${user.login}) 임시 비밀번호: ${temp}`);
    console.log("→ 로그인하면 비밀번호를 바꾸라는 안내가 나와요. 기존 로그인은 모두 끊었어요.");
    break;
  }

  default:
    console.log("사용법: node server/admin.mjs list | find <이름> | reset-password <아이디>");
    process.exit(cmd ? 1 : 0);
}
