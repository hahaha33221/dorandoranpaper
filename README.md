# 도란도란 롤링페이퍼

- **멘티**: 아이디 + 비밀번호로 로그인 → 멘토 선생님들이 쓴 편지 보기 (편지함 / 퍼즐 / 펼쳐보기)
- **멘토**: 아이디 + 비밀번호로 로그인 → 멘티별로 편지 쓰기·수정 (서버 DB에 저장)
- **관리자(마스터)**: `master` 아이디로 로그인 → 전체 현황 (작성 현황, 접속 여부, 편지 보기, 임시 비밀번호 발급)
- **사진첩**: 멘티·관리자만. 활동 날짜별 앨범 → 사진 크게 보기·넘기기 (저장 기능 없음)

## 구조

```
브라우저 ── https://dorandoranpaper.vercel.app ── (Vercel: public/ 정적 파일)
                     │  /api/*  → https://dorandoran.31-97-71-87.sslip.io/api/*  (vercel.json rewrite)
                     ▼
            Hostinger VPS ── 호스트 nginx(전용 사이트, HTTPS) ── 127.0.0.1:18787 Node API(server/) ── SQLite
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

## 관리자(마스터) 화면

- 아이디 `master`, 비밀번호는 `private/계정목록.xlsx` 의 **관리자** 시트 (12자리)
- 요약: 작성된 편지 / 편지를 쓴 멘토 / 편지를 받은 멘티 / 로그인한 사람
- **멘토별·멘티별**: 진행률, 마지막 로그인·작성 시각, 비밀번호 상태, **임시 비밀번호 발급** 버튼
- **전체 표**: 멘티 × 멘토 작성 여부. ✓ 를 누르면 편지 내용을 볼 수 있습니다.
- 비밀번호 찾기 문의가 오면 여기서 바로 임시 비밀번호를 발급하면 됩니다. (아래 명령어 대신)

## 사진첩

멘티와 관리자만 볼 수 있습니다. (멘토 X)

### 원드라이브 자동 동기화 (추천)

VPS 가 원드라이브 사진첩 폴더를 **직접** 가져옵니다 (Mac 저장 공간 사용 X, 원드라이브는 읽기만).
`dorandoran-photos-sync` 컨테이너(공식 rclone 이미지)가 30분마다, 그리고 관리자 **지금 확인** 버튼을 누르면 바로 동기화합니다.

**처음 한 번 연결**

1. Mac 에서 원드라이브 로그인 → 연결 정보 파일 만들기 (브라우저가 열리면 Microsoft 로그인 → 허용)

   ```bash
   ~/.local/bin/rclone config create dorandoran onedrive --config "$HOME/Documents/1.개발폴더/17.도란도란/private/rclone.conf"
   ```
   질문이 나오면: 종류는 `OneDrive Personal or Business`, 드라이브는 목록의 첫 번째(개인 드라이브) 선택.

2. 연결 정보를 VPS 로 보내기 (비공개 파일 — GitHub 에는 올라가지 않음)

   ```bash
   scp "$HOME/Documents/1.개발폴더/17.도란도란/private/rclone.conf" root@srv1809055.hstgr.cloud:/opt/dorandoran/rclone/rclone.conf
   ```

3. VPS `.env` 에 사진첩 폴더와 동기화 켜기 → `docker compose up -d`

   ```
   COMPOSE_PROFILES=photos
   PHOTOS_REMOTE=dorandoran:도란도란/사진첩
   ```

로그: `docker logs dorandoran-photos-sync`

### 사진 올리기 (Mac 폴더에서 직접 보낼 때)

원드라이브 사진첩 폴더 안을 **날짜별 폴더**로 정리합니다. 폴더 이름 = 앨범 날짜 + 활동명.

```
도란도란 사진첩/
  2026-09-14 첫 만남/
  2026-09-28 가을 소풍/
  2026.10.12 쿠키 만들기/     (2026.10.12, 261012 형식도 가능)
```

Mac 에서 (원드라이브 앱이 동기화한 폴더 경로를 넣으세요):

```bash
npm run photos:sync -- "$HOME/Library/CloudStorage/OneDrive-개인/도란도란 사진첩"
```

- 바뀐 사진만 VPS로 보내고, 서버가 1분 안에 변환해 사진첩에 올립니다.
- 폴더에서 지운 사진·폴더는 사이트에서도 지워집니다.
- 원드라이브의 "필요할 때 다운로드" 사진은 이때 내려받느라 오래 걸릴 수 있어요.
  (폴더 오른쪽 클릭 → **항상 이 장치에 유지**)
- 터미널에 원드라이브 폴더 접근 권한을 물어보면 허용하세요.

### 서버에서 하는 일

- 목록용(`t.webp`, 긴 변 480px)과 크게 보기용(`l.jpg`, 긴 변 1600px) 변환
- 사진 방향 바로잡기, **촬영 정보·위치(GPS) 제거**, 아이폰 HEIC 지원 (ImageMagick)
- 사진 주소는 6~7시간 뒤 만료되는 서명 주소 → 로그인한 사람만 볼 수 있음
- 원본은 VPS `/opt/dorandoran/data/photos-src`, 변환본은 `data/photos`

### 관리자

- 📷 사진첩: 마지막 확인 시각, 변환 대기·실패 수, **지금 확인** 버튼
- 앨범 안: 제목·한 줄 설명 수정, **멘티에게 숨기기**, 사진별 **숨기기 / 대표로** (원드라이브 원본은 그대로)

## 비밀번호

- 처음 나눠 준 비밀번호로 로그인하면 **비밀번호 변경** 안내가 뜹니다. (나중에 하기 가능)
- 로그인 후 화면 오른쪽 위 🔑 버튼으로 언제든 바꿀 수 있습니다. (6자 이상)
- 직접 바꾼 비밀번호와 관리자가 발급한 임시 비밀번호는 `seed.json` 을 다시 올려도 덮어쓰지 않습니다.
- 로그인 화면의 **비밀번호를 잊어버렸어요** → 관리자에게 문의하라는 안내가 나옵니다.
  관리자 이메일(`public/app.js` 의 `ADMIN_EMAIL`)이 함께 표시되고, 누르면 메일 작성 창이 열립니다.

### 비밀번호 찾기 문의 처리 (명령어로 할 때)

```bash
# 이름으로 아이디 찾기
ssh root@srv1809055.hstgr.cloud 'cd /opt/dorandoran && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs find 박지은'

# 임시 비밀번호 새로 발급 (6자리 숫자, 기존 로그인은 모두 끊김)
ssh root@srv1809055.hstgr.cloud 'cd /opt/dorandoran && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs reset-password <아이디>'

# 전체 계정과 비밀번호 변경 여부
ssh root@srv1809055.hstgr.cloud 'cd /opt/dorandoran && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs list'
```

발급된 임시 비밀번호를 본인에게 알려 주면, 로그인할 때 다시 바꾸라는 안내가 나옵니다.
(`private/계정목록.xlsx` 에는 처음 비밀번호만 적혀 있으니 바뀐 비밀번호는 따로 관리하세요.)

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
| 공개 주소 | 전용 주소 `dorandoran.31-97-71-87.sslip.io` (nginx 사이트 `/etc/nginx/sites-available/dorandoran`) |
| 자원 제한 | 메모리 256MB, CPU 0.5, 로그 최대 30MB |

1. **점검** (아무것도 바꾸지 않음) — 80/443을 누가 쓰는지, 18787 포트가 비었는지 확인

   ```bash
   ssh root@srv1809055.hstgr.cloud 'bash -s' < deploy/setup-vps.sh dorandoran.31-97-71-87.sslip.io --check
   ```

2. **설치**

   ```bash
   # 호스트 nginx 에 전용 사이트 생성 + certbot HTTPS (설정 검사 실패 시 이 사이트만 비활성화)
   ssh root@srv1809055.hstgr.cloud 'bash -s' < deploy/setup-vps.sh dorandoran.31-97-71-87.sslip.io --nginx
   ```
   - 80/443을 이미 다른 서비스가 쓰면 **proxy 모드**: API는 127.0.0.1 에만 띄우고, nginx 에 이 주소 전용 사이트만 추가합니다.
     다른 사이트 설정 파일은 건드리지 않습니다.
   - 80/443이 비어 있으면 **standalone 모드**: 전용 Caddy가 HTTPS 인증서까지 처리합니다.
   - 18787이 이미 쓰이면 `--port 18800` 처럼 다른 포트를 지정하세요.

3. **확인**: `curl https://dorandoran.31-97-71-87.sslip.io/api/health` → `{"ok":true}`

4. **계정 데이터 올리기** (계정을 새로 만들거나 바꿀 때마다)

   ```bash
   scp private/seed.json root@srv1809055.hstgr.cloud:/opt/dorandoran/data/seed.json
   ssh root@srv1809055.hstgr.cloud 'cd /opt/dorandoran && chown 1000:1000 data/seed.json && docker compose restart api'
   ```
   서버가 시작할 때 `seed.json` 을 반영하고 이름을 `seed.imported-*.json` 으로 바꿉니다.
   웹에서 멘토가 쓴 편지는 덮어쓰지 않습니다.

5. **Vercel 연결** — `vercel.json` 의 rewrite 대상이 위 호스트인지 확인합니다.
   (`/api/*` → `https://dorandoran.31-97-71-87.sslip.io/api/*`)

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
rm /etc/nginx/sites-enabled/dorandoran && nginx -t && systemctl reload nginx
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
scp root@srv1809055.hstgr.cloud:/opt/dorandoran/data/doran.db ./backup-$(date +%Y%m%d).db
```
