#!/usr/bin/env node
/*
 * 로컬 개발: API + 정적 파일을 한 서버로 실행 (http://localhost:5178)
 * - private/seed.json 이 있으면 data/ 로 복사해 계정/편지를 반영
 * - server/ 코드가 바뀌면 서버 재시작, public/ 이 바뀌면 브라우저 새로고침
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SEED = join(ROOT, "private", "seed.json");

mkdirSync(DATA, { recursive: true });
if (existsSync(SEED)) copyFileSync(SEED, join(DATA, "seed.json"));
else console.warn("private/seed.json 이 없어요. 먼저 `npm run seed` 를 실행하세요.");

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--watch-path=server", join("server", "index.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT || "5178", DATA_DIR: DATA, STATIC_DIR: join(ROOT, "public"), DEV: "1" }
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
