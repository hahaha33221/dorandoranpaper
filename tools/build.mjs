#!/usr/bin/env node
/*
 * 엑셀(롤링페이퍼 작성.xlsx) → public/data.js 변환
 *
 *   node tools/build.mjs [엑셀파일경로]
 *
 * - 시트 이름 = 편지를 쓴 멘토, 각 행 = 멘티, '롤링페이퍼 내용' 칸 = 편지
 * - 멘티별 로그인 아이디는 tools/mentee-ids.csv 에 저장됩니다.
 *   (없으면 자동 생성, 있으면 그대로 사용 — 직접 고쳐도 됩니다)
 * - 편지는 아이디로 암호화되어 data.js 에 들어가므로, 아이디 없이는 읽을 수 없습니다.
 *   mentee-ids.csv 와 엑셀 파일은 배포(업로드)하지 마세요.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDS_CSV = join(ROOT, "tools", "mentee-ids.csv");
const OUT = join(ROOT, "public", "data.js");

const TITLE = "도란도란";
const SENDER_SUFFIX = " 선생님"; // 보낸 사람 이름 뒤에 붙는 호칭
const ITERATIONS = 150000;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // 헷갈리는 i, l, o, 0, 1 제외
const ID_LENGTH = 6;

/* ---------- xlsx 읽기 (unzip + XML) ---------- */
const xlsxPath = resolve(process.argv[2] || readdirSync(ROOT).filter((f) => f.endsWith(".xlsx")).map((f) => join(ROOT, f))[0] || "");
if (!existsSync(xlsxPath)) {
  console.error("엑셀 파일을 찾을 수 없어요. 사용법: node tools/build.mjs <파일.xlsx>");
  process.exit(1);
}
const unzip = (entry) => {
  try {
    return execFileSync("unzip", ["-p", xlsxPath, entry], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    return "";
  }
};
const decode = (s) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e] ??
    String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  );
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

const shared = [...unzip("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
const rels = Object.fromEntries(
  [...unzip("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    m[0].match(/Id="([^"]+)"/)[1],
    m[0].match(/Target="([^"]+)"/)[1].replace(/^\/?(xl\/)?/, "xl/")
  ])
);
const sheets = [...unzip("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
  name: decode(m[0].match(/name="([^"]+)"/)[1]),
  path: rels[m[0].match(/r:id="([^"]+)"/)[1]]
}));

function readRows(path) {
  const rows = [];
  for (const row of unzip(path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/r="([A-Z]+)\d+"/)?.[1];
      const type = c[1].match(/t="([^"]+)"/)?.[1];
      const inner = c[2] || "";
      let v = "";
      if (type === "s") v = shared[+inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]] ?? "";
      else if (type === "inlineStr") v = textOf(inner);
      else v = decode(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
      if (ref && v !== "") cells[ref] = v;
    }
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

/* ---------- 멘토 시트 → 멘티별 편지 ---------- */
const mentees = new Map(); // 원래 이름 → { no, name, grade, letters[] }
for (const sheet of sheets) {
  const rows = readRows(sheet.path);
  const headerIdx = rows.findIndex((r) => Object.values(r).some((v) => v.includes("멘티 성명")));
  if (headerIdx < 0) {
    console.warn(`· '${sheet.name}' 시트: '멘티 성명' 머리글이 없어 건너뜁니다.`);
    continue;
  }
  const header = rows[headerIdx];
  const col = (label) => Object.keys(header).find((k) => header[k].replace(/\s/g, "").includes(label));
  const cName = col("멘티성명"), cBody = col("롤링페이퍼"), cNo = col("넘버링"), cGrade = col("학년");
  if (!cBody) console.warn(`· '${sheet.name}' 시트: '롤링페이퍼 내용' 머리글이 없어 편지를 읽지 못했어요.`);

  for (const r of rows.slice(headerIdx + 1)) {
    const raw = (r[cName] || "").trim();
    if (!raw) continue;
    if (!mentees.has(raw)) {
      mentees.set(raw, {
        no: r[cNo] ? String(parseFloat(r[cNo])) : "",
        name: raw.replace(/\s*\([^)]*\)\s*/g, "").trim(),
        grade: r[cGrade] || "",
        letters: []
      });
    }
    const body = (r[cBody] || "").replace(/\r\n?/g, "\n").trim();
    if (body) mentees.get(raw).letters.push({ from: sheet.name + SENDER_SUFFIX, body });
  }
}
if (!mentees.size) {
  console.error("멘티를 하나도 찾지 못했어요. 엑셀 형식을 확인해 주세요.");
  process.exit(1);
}

/* ---------- 아이디 (CSV 유지/생성) ---------- */
const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
function parseCsv(text) {
  return text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((line) => {
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
}
const normalizeId = (s) => s.normalize("NFC").trim().toLowerCase();

const ids = new Map(); // 원래 이름 → 아이디
if (existsSync(IDS_CSV)) {
  for (const [, name, , id] of parseCsv(readFileSync(IDS_CSV, "utf8")).slice(1)) {
    if (name && id) ids.set(name.trim(), normalizeId(id));
  }
}
const used = new Set(ids.values());
const newId = () => {
  let id;
  do {
    id = Array.from(crypto.randomBytes(ID_LENGTH), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
  } while (used.has(id));
  used.add(id);
  return id;
};
let created = 0;
for (const raw of mentees.keys()) {
  if (!ids.has(raw)) { ids.set(raw, newId()); created++; }
}
const seen = new Map();
for (const [raw, id] of ids) {
  if (!mentees.has(raw)) continue;
  if (seen.has(id)) {
    console.error(`아이디 '${id}'가 '${seen.get(id)}'와 '${raw}'에 중복돼요. mentee-ids.csv를 고쳐 주세요.`);
    process.exit(1);
  }
  seen.set(id, raw);
}
writeFileSync(
  IDS_CSV,
  "﻿" + [["넘버링", "멘티 성명", "학년", "아이디"], ...[...mentees].map(([raw, m]) => [m.no, raw, m.grade, ids.get(raw)])]
    .map((r) => r.map(csvCell).join(","))
    .join("\n") + "\n"
);

/* ---------- 암호화 → data.js ---------- */
const salt = crypto.randomBytes(16);
const entries = {};
for (const [raw, m] of mentees) {
  const bits = crypto.pbkdf2Sync(ids.get(raw), salt, ITERATIONS, 64, "sha256");
  const token = bits.subarray(0, 16).toString("hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", bits.subarray(32, 64), iv);
  const plain = JSON.stringify({ name: m.name, letters: m.letters });
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  entries[token] = { iv: iv.toString("base64"), data: data.toString("base64") };
}
const payload = { title: TITLE, salt: salt.toString("base64"), iterations: ITERATIONS, entries };
writeFileSync(
  OUT,
  "/* 자동 생성 파일 — 직접 고치지 말고 `node tools/build.mjs` 로 다시 만드세요. */\n" +
    "window.ROLLING_DATA = " + JSON.stringify(payload, null, 1) + ";\n"
);

/* ---------- 요약 ---------- */
const total = [...mentees.values()].reduce((n, m) => n + m.letters.length, 0);
console.log(`멘토 ${sheets.length}명 · 멘티 ${mentees.size}명 · 편지 ${total}통 → public/data.js`);
console.log(`아이디 목록: tools/mentee-ids.csv${created ? ` (새로 만든 아이디 ${created}개)` : ""}`);
for (const [raw, m] of mentees) console.log(`  ${raw.padEnd(10, "　")} ${ids.get(raw)}  편지 ${m.letters.length}통`);
