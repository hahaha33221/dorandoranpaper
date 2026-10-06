# 도란도란 롤링페이퍼

- **멘티**: 아이디 + 비밀번호로 로그인 → 멘토 선생님들이 쓴 편지 보기 (편지함 / 퍼즐 / 펼쳐보기)
- **멘토**: 아이디 + 비밀번호로 로그인 → 멘티별로 편지 쓰기·수정 (서버 DB에 저장)

## 구조

```
브라우저 ── https://dorandoranpaper.vercel.app ── (Vercel: public/ 정적 파일)
                     │  /api/*  → https://<VPS>/dorandoran-api/*  (vercel.json rewrite)
                     ▼
            Hostinger VPS ── 기존 웹서버 /dorandoran-api/ ── 127.0.0.1:18787 Node API(server/) ── SQLite
```

| 경로 | 설명 | 커밋 |
| --- | --- | --- |
| `public/` | 화면 (Vercel 배포) | ✅ |
| `server/` | API 서버 (VPS 배포, 의존성 없음: `node:http` + `node:sqlite`) | ✅ |
| `tools/seed.mjs` | 엑셀 → 계정·편지 데이터 생성 | ✅ |
| `docker-compose.yml`, `Dockerfile`, `deploy/` | VPS 실행 설정 | ✅ |
| `private/` | **계정목록.xlsx**(아이디·비밀번호), accounts.json, seed.json | ❌ 비공개 |
| `data/` | 로컬 개발용 DB | ❌ |
| `*.xlsx` | 편지 원본 엑셀 | ❌ 비공개 |

## 계정 만들기

```bash
npm install      # 처음 한 번 (엑셀 읽기/쓰기용)
npm run seed
```

- 엑셀의 **시트 이름 = 멘토**, 각 행 = 멘티입니다. `롤링페이퍼 내용` 칸에 이미 쓴 편지가 있으면 함께 들어갑니다.
- `private/계정목록.xlsx` 에 멘티·멘토 아이디/비밀번호가 정리됩니다. (배부용)
- 다시 실행해도 기존 아이디/비밀번호는 유지되고, 새로 추가된 사람만 새로 만듭니다.
  비밀번호를 바꾸려면 `private/accounts.json` 의 값을 고친 뒤 다시 `npm run seed` 하세요.
- 멘티 아이디는 6자리, 멘토 아이디는 `t`로 시작하는 6자리, 비밀번호는 숫자 6자리입니다.

## 로컬 개발

```bash
npm run dev
```
→ http://localhost:5178 (API + 화면을 한 서버로 실행, `private/seed.json` 자동 반영, 파일 수정 시 자동 새로고침)

## VPS 배포 (최초 1회) — 다른 서비스와 같이 쓰는 VPS

다른 서비스와 겹치지 않도록 모든 것이 분리돼 있습니다.

| 항목 | 도란도란 전용 값 |
| --- | --- |
| 폴더 | `/opt/dorandoran` |
| 컨테이너 / 네트워크 | `dorandoran-api` (`dorandoran-caddy`) / `dorandoran` |
| 포트 | `127.0.0.1:18787` — 외부 공개 안 함, 80/443 사용 안 함 |
| 공개 경로 | 기존 도메인의 `https://<호스트>/dorandoran-api/*` 경로 하나만 사용 |
| 자원 제한 | 메모리 256MB, CPU 0.5, 로그 최대 30MB |

1. **점검** (아무것도 바꾸지 않음) — 80/443을 누가 쓰는지, 18787 포트가 비었는지 확인

   ```bash
   ssh root@<호스트> 'bash -s' < deploy/setup-vps.sh <호스트> --check
   ```

2. **설치**

   ```bash
   # 기존 nginx가 있으면 경로 연결까지 자동 (설정 검사 실패 시 원래대로 되돌림)
   ssh root@<호스트> 'bash -s' < deploy/setup-vps.sh <호스트> --nginx
   ```
   - 80/443을 이미 다른 서비스가 쓰면 **proxy 모드**: API만 띄우고, 기존 웹서버에 `/dorandoran-api/` 경로를 추가합니다.
     nginx가 아니면(Caddy, Traefik 등) 스크립트가 넣을 설정을 안내해 줍니다.
   - 80/443이 비어 있으면 **standalone 모드**: 전용 Caddy가 HTTPS 인증서까지 처리합니다.
   - 18787이 이미 쓰이면 `--port 18800` 처럼 다른 포트를 지정하세요.

3. **확인**: `curl https://<호스트>/dorandoran-api/health` → `{"ok":true}`

4. **계정 데이터 올리기** (계정을 새로 만들거나 바꿀 때마다)

   ```bash
   scp private/seed.json root@<호스트>:/opt/dorandoran/data/seed.json
   ssh root@<호스트> 'cd /opt/dorandoran && chown 1000:1000 data/seed.json && docker compose restart api'
   ```
   서버가 시작할 때 `seed.json` 을 반영하고 이름을 `seed.imported-*.json` 으로 바꿉니다.
   웹에서 멘토가 쓴 편지는 덮어쓰지 않습니다.

5. **Vercel 연결** — `vercel.json` 의 `VPS_API_DOMAIN` 을 실제 호스트로 바꿔 커밋합니다.
   (`/api/*` → `https://<호스트>/dorandoran-api/*`)

6. **자동 배포(CI/CD) 시크릿** — GitHub 저장소 → Settings → Secrets and variables → Actions

   | 이름 | 값 |
   | --- | --- |
   | `VPS_HOST` | VPS 주소 |
   | `VPS_USER` | `root` (또는 docker 권한이 있는 배포용 사용자) |
   | `VPS_SSH_KEY` | 배포용 SSH 개인키 (공개키는 VPS `~/.ssh/authorized_keys` 에 추가) |
   | `VPS_PORT` | (선택) SSH 포트, 기본 22 |

   배포는 `/opt/dorandoran` 안에서 `docker compose up -d --build` 만 실행하므로 다른 서비스에는 영향이 없습니다.

### 삭제

```bash
cd /opt/dorandoran && docker compose down   # DB(data/)는 남음
# nginx 를 연결했다면 include ... nginx-dorandoran.local.conf; 줄을 지우고 reload
```

## 자동 배포 (CI/CD)

`main` 에 푸시하면:

- **Vercel**: `public/` 화면을 자동 배포
- **GitHub Actions** (`.github/workflows/ci-deploy.yml`):
  비공개 파일 커밋 여부 검사 → 문법 검사 → API 동작 테스트 → Docker 빌드 → VPS에 SSH 접속해 `git pull` + `docker compose up -d --build`
- Pull Request 에서는 검사만 하고 배포하지 않습니다.

## 백업

DB는 VPS의 `/opt/dorandoran/data/doran.db` 한 파일입니다.

```bash
scp root@srv123456.hstgr.cloud:/opt/dorandoran/data/doran.db ./backup-$(date +%Y%m%d).db
```
