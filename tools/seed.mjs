#!/usr/bin/env node
/*
 * 엑셀(롤링페이퍼 작성.xlsx) → 계정 만들기
 *
 *   npm run seed [-- 엑셀파일경로]
 *
 * 만들어지는 파일 (모두 private/ — 절대 커밋/공유 금지)
 *   private/계정목록.xlsx   멘티·멘토 아이디/비밀번호 목록 (배부용)
 *   private/accounts.json  아이디/비밀번호 원본 (다시 실행해도 같은 값 유지)
 *   private/seed.json      서버에 올릴 데이터 (비밀번호는 해시만 포함)
 *
 * seed.json 을 서버의 data/ 폴더에 넣고 서버를 재시작하면 반영됩니다.
 * (로컬 개발: npm run dev 가 자동으로 data/ 에 복사해 사용)
 */
import ExcelJS from "exceljs";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { hashPassword } from "../server/db.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = join(ROOT, "private");
const ACCOUNTS = join(PRIVATE, "accounts.json");
const LEGACY_IDS = join(ROOT, "tools", "mentee-ids.csv"); // 예전 아이디 유지용

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // 헷갈리는 i, l, o, 0, 1 제외
const rand = (alphabet, n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const newPassword = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/* ---------- 엑셀 읽기 ---------- */
const xlsxPath = resolve(
  process.argv[2] || readdirSync(ROOT).filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$")).map((f) => join(ROOT, f))[0] || ""
);
if (!existsSync(xlsxPath)) {
  console.error("엑셀 파일을 찾을 수 없어요. 사용법: npm run seed -- <파일.xlsx>");
  process.exit(1);
}
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(xlsxPath);

const cellText = (v) => {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v);
};

const mentors = []; // { key, name }
const mentees = new Map(); // key(원래 이름) → { no, name, fullName, grade }
const letters = []; // { mentor, mentee, body } (key 기준)

wb.eachSheet((ws) => {
  let header = null;
  ws.eachRow((row) => {
    const vals = row.values.map(cellText);
    if (!header) {
      if (vals.some((v) => v.replace(/\s/g, "").includes("멘티성명"))) {
        header = {};
        vals.forEach((v, i) => {
          const k = v.replace(/\s/g, "");
          if (k.includes("멘티성명")) header.name = i;
          else if (k.includes("롤링페이퍼")) header.body = i;
          else if (k.includes("넘버링")) header.no = i;
          else if (k.includes("학년")) header.grade = i;
        });
      }
      return;
    }
    const raw = (vals[header.name] || "").trim();
    if (!raw) return;
    if (!mentees.has(raw)) {
      mentees.set(raw, {
        no: vals[header.no] ? String(parseFloat(vals[header.no])) : "",
        name: raw.replace(/\s*\([^)]*\)\s*/g, "").trim(),
        fullName: raw,
        grade: vals[header.grade] || ""
      });
    }
    const body = header.body ? (vals[header.body] || "").replace(/\r\n?/g, "\n").trim() : "";
    if (body) letters.push({ mentor: ws.name, mentee: raw, body });
  });
  if (header) mentors.push({ key: ws.name, name: ws.name });
  else console.warn(`· '${ws.name}' 시트: '멘티 성명' 머리글이 없어 건너뜁니다.`);
});
if (!mentees.size || !mentors.length) {
  console.error("멘토/멘티를 찾지 못했어요. 엑셀 형식을 확인해 주세요.");
  process.exit(1);
}

/* ---------- 계정 (기존 값 유지, 없으면 생성) ---------- */
mkdirSync(PRIVATE, { recursive: true });
const saved = existsSync(ACCOUNTS) ? JSON.parse(readFileSync(ACCOUNTS, "utf8")) : { mentee: {}, mentor: {} };
saved.mentee ||= {};
saved.mentor ||= {};

// 예전(아이디만 쓰던 버전)에 만든 멘티 아이디는 그대로 이어서 사용
if (existsSync(LEGACY_IDS)) {
  const lines = readFileSync(LEGACY_IDS, "utf8").replace(/^﻿/, "").split(/\r?\n/).slice(1);
  for (const line of lines) {
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    const [, name, , id] = cols || [];
    if (name && id && !saved.mentee[name.trim()]) saved.mentee[name.trim()] = { login: id.trim().toLowerCase() };
  }
}

const used = new Set([...Object.values(saved.mentee), ...Object.values(saved.mentor)].map((a) => a.login));
const newLogin = (prefix) => {
  let id;
  do id = prefix + rand(ID_ALPHABET, 6 - prefix.length); while (used.has(id));
  used.add(id);
  return id;
};
let created = 0;
for (const key of mentees.keys()) {
  const a = (saved.mentee[key] ||= {});
  if (!a.login) { a.login = newLogin(""); created++; }
  if (!a.password) { a.password = newPassword(); created++; }
}
for (const { key } of mentors) {
  const a = (saved.mentor[key] ||= {});
  if (!a.login) { a.login = newLogin("t"); created++; }
  if (!a.password) { a.password = newPassword(); created++; }
}
writeFileSync(ACCOUNTS, JSON.stringify(saved, null, 2) + "\n");

/* ---------- seed.json ---------- */
const users = [
  ...[...mentees].map(([key, m], i) => ({
    login: saved.mentee[key].login, pw_hash: hashPassword(saved.mentee[key].password),
    role: "mentee", name: m.name, full_name: m.fullName, grade: m.grade, sort: i
  })),
  ...mentors.map((t, i) => ({
    login: saved.mentor[t.key].login, pw_hash: hashPassword(saved.mentor[t.key].password),
    role: "mentor", name: t.name, full_name: t.name, grade: "", sort: i
  }))
];
const seed = {
  createdAt: new Date().toISOString(),
  users,
  letters: letters.map((l) => ({ mentor: saved.mentor[l.mentor].login, mentee: saved.mentee[l.mentee].login, body: l.body }))
};
writeFileSync(join(PRIVATE, "seed.json"), JSON.stringify(seed, null, 1) + "\n");

/* ---------- 계정목록.xlsx ---------- */
const out = new ExcelJS.Workbook();
out.creator = "도란도란";
function sheet(title, rows, withGrade) {
  const ws = out.addWorksheet(title, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "번호", key: "no", width: 7 },
    { header: "이름", key: "name", width: 18 },
    ...(withGrade ? [{ header: "학년", key: "grade", width: 9 }] : []),
    { header: "아이디", key: "login", width: 14 },
    { header: "비밀번호", key: "password", width: 14 }
  ];
  rows.forEach((r) => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { horizontal: "center" };
  head.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEF79" } };
    c.border = { bottom: { style: "thin", color: { argb: "FF77B17E" } } };
  });
  for (const key of ["login", "password"]) {
    ws.getColumn(key).numFmt = "@";
    ws.getColumn(key).font = { name: "Consolas", size: 12 };
    ws.getColumn(key).alignment = { horizontal: "center" };
  }
  ws.getColumn("no").alignment = { horizontal: "center" };
}
sheet("멘티", [...mentees].map(([key, m], i) => ({
  no: m.no || i + 1, name: m.fullName, grade: m.grade, login: saved.mentee[key].login, password: saved.mentee[key].password
})), true);
sheet("멘토", mentors.map((t, i) => ({
  no: i + 1, name: t.name, login: saved.mentor[t.key].login, password: saved.mentor[t.key].password
})), false);
await out.xlsx.writeFile(join(PRIVATE, "계정목록.xlsx"));

console.log(`멘토 ${mentors.length}명 · 멘티 ${mentees.size}명 · 엑셀 편지 ${letters.length}통`);
console.log("→ private/계정목록.xlsx  (아이디·비밀번호 목록)");
console.log("→ private/seed.json      (서버 data/ 폴더에 올릴 파일)");
if (created) console.log(`  새로 만든 아이디/비밀번호 ${created}개`);
