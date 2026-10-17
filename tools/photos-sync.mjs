#!/usr/bin/env node
/*
 * 사진첩 올리기: Mac 의 사진 폴더(원드라이브 동기화 폴더 등) → VPS
 *
 *   npm run photos:sync -- "<사진첩 폴더>"
 *   예) npm run photos:sync -- "$HOME/Library/CloudStorage/OneDrive-개인/도란도란 사진첩"
 *
 * 폴더 안은 날짜별 폴더:  2026-10-12 쿠키 만들기/ ...
 * - 바뀐 파일만 보냅니다. 폴더에서 지운 사진은 사이트에서도 지워집니다.
 * - 보내고 나면 서버가 1분 안에 새 사진을 변환해 사진첩에 올립니다.
 * - 원드라이브 "필요할 때 다운로드" 상태의 사진은 이때 내려받느라 오래 걸릴 수 있어요.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const HOST = process.env.VPS_HOST || "srv1809055.hstgr.cloud";
const USER = process.env.VPS_USER || "root";
const DEST = "/opt/dorandoran/data/photos-src/";

const src = process.argv[2] && resolve(process.argv[2]);
if (!src || !existsSync(src) || !statSync(src).isDirectory()) {
  console.error('사용법: npm run photos:sync -- "<사진첩 폴더>"');
  process.exit(1);
}
const folders = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
if (!folders.length) {
  console.error("폴더 안에 날짜별 폴더가 없어요. (예: 2026-10-12 쿠키 만들기)");
  process.exit(1);
}
console.log(`앨범 ${folders.length}개:`);
for (const f of folders) console.log("  · " + f.name);
console.log(`→ ${USER}@${HOST}:${DEST}\n`);

const r = spawnSync("rsync", ["-rtv", "--delete", "--exclude", ".*", "--exclude", "Thumbs.db", src + "/", `${USER}@${HOST}:${DEST}`], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status || 1);

// 서버에 "새 사진 확인" 요청 (1분 안에 변환 시작)
spawnSync("ssh", [`${USER}@${HOST}`, `touch ${DEST}.scan-request`], { stdio: "inherit" });
console.log("\n✔ 보냈어요. 1~몇 분 뒤 사진첩에 나타나요. (사진이 많으면 변환에 시간이 걸려요)");
