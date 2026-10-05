# 도란도란 롤링페이퍼

멘티가 **자기 아이디**를 입력하면 멘토 선생님들이 쓴 편지를 볼 수 있는 웹사이트입니다.

## 폴더 구성

| 경로 | 설명 | 배포 |
| --- | --- | --- |
| `public/` | 웹사이트 (이 폴더만 업로드) | ✅ |
| `public/data.js` | 엑셀로 만든 **암호화된** 편지 데이터 (자동 생성) | ✅ |
| `tools/build.mjs` | 엑셀 → `data.js` 변환 스크립트 | ❌ |
| `tools/mentee-ids.csv` | 멘티별 로그인 아이디 목록 | ❌ **비공개** |
| `도란도란 롤링페이퍼 작성.xlsx` | 편지 원본 | ❌ **비공개** |

## 편지 내용 반영하기

1. 엑셀의 각 멘토 시트 `롤링페이퍼 내용` 칸에 편지를 씁니다. (빈 칸은 건너뜀)
2. 이 폴더에서 실행합니다.

   ```bash
   node tools/build.mjs
   ```

3. 바뀐 `public/data.js`를 커밋하고 푸시하면 자동으로 배포됩니다.

   ```bash
   git add public/data.js && git commit -m "편지 업데이트" && git push
   ```

- 시트 이름 = 보낸 사람 (`○○○ 선생님`으로 표시)
- 멘티 이름의 `(형제)`, `(쌍둥이)` 같은 괄호는 화면에서 빠집니다.

## 아이디

- 처음 실행할 때 멘티마다 6자리 아이디를 만들어 `tools/mentee-ids.csv`에 저장하고, 이후에는 그대로 유지합니다.
- 아이디를 바꾸고 싶으면 CSV의 `아이디` 칸을 고친 뒤 다시 `node tools/build.mjs` 하세요.
- 대소문자와 앞뒤 공백은 구분하지 않습니다.
- 편지는 아이디로 암호화되어 있어 아이디 없이는 페이지 소스를 열어도 읽을 수 없습니다.
  그래서 사이트는 **https** 주소(또는 localhost)로 열어야 합니다.

## 배포 (CI/CD)

- `main` 브랜치에 푸시하면 GitHub Actions(`.github/workflows/deploy.yml`)가
  검사 → `public/` 폴더를 GitHub Pages에 배포합니다.
- 주소: https://hahaha33221.github.io/dorandoranpaper/
- 엑셀·CSV는 `.gitignore`로 제외되고, 실수로 커밋되면 CI가 실패해서 배포를 막습니다.
- Pull Request에서는 검사만 하고 배포하지 않습니다.

## 미리보기

```bash
python3 -m http.server 5178 -d public
```
→ http://localhost:5178
