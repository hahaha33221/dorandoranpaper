(function () {
  "use strict";

  const TITLE = "도란도란";
  // 비밀번호 찾기 안내에 보여줄 관리자 이메일 (비워 두면 연락처 줄은 숨김)
  const ADMIN_EMAIL = "hand090399@gmail.com";
  const API = "/api";
  const app = document.getElementById("app");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");

  const VIEWS = [
    { id: "inbox", label: "편지함" },
    { id: "puzzle", label: "퍼즐" },
    { id: "cards", label: "펼쳐보기" }
  ];
  const PIECE_COLORS = ["#f9ae72", "#fb9aac", "#66b8dd", "#cd85ea", "#ffcc00", "#0fb5b5"];

  const store = {
    get(key, fallback) {
      try { return sessionStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { sessionStorage.setItem(key, value); } catch (e) { /* 저장 불가 환경 무시 */ }
    },
    remove(key) {
      try { sessionStorage.removeItem(key); } catch (e) { /* 무시 */ }
    }
  };
  const prefs = {
    get(key, fallback) {
      try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* 무시 */ }
    }
  };

  /* ---------- 유틸 ---------- */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) {
      if (c != null) el.append(c);
    }
    return el;
  }

  // 같은 학생/화면에서 항상 같은 모양이 나오도록 하는 시드 난수
  function seeded(seed) {
    let s = 0;
    for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  const ICON_KEY = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/></svg>';
  const ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';
  const ICON_USER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/></svg>';

  function frame(children) {
    const svg = '<svg class="frame__border" aria-hidden="true"><rect x="1.5" y="1.5" width="100%" height="100%" rx="18" ry="18" style="width:calc(100% - 3px);height:calc(100% - 3px)"/></svg>';
    const back = h("button", { class: "back", type: "button", "aria-label": "나가기", html: ICON_BACK, onclick: logout });
    const key = h("button", {
      class: "account", type: "button", "aria-label": "비밀번호 변경", title: "비밀번호 변경",
      html: ICON_KEY, onclick: (e) => openPassword(e.currentTarget)
    });
    const el = h("div", { class: "frame", html: svg }, [back, key].concat(children));
    return el;
  }

  /* ---------- API / 세션 ---------- */
  const TOKEN_KEY = "doran:token";
  let current = null; // { user, letters? , mentees? }

  async function request(method, path, body) {
    const token = store.get(TOKEN_KEY, "");
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: Object.assign(
          { Accept: "application/json" },
          body !== undefined ? { "Content-Type": "application/json" } : {},
          token ? { Authorization: "Bearer " + token } : {}
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw Object.assign(new Error("서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요."), { status: 0 });
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && path !== "/login") { store.remove(TOKEN_KEY); current = null; }
      throw Object.assign(new Error(data.error || "문제가 생겼어요. 다시 시도해 주세요."), { status: res.status });
    }
    return data;
  }

  async function logout() {
    if (editorDirty() && !confirm("저장하지 않은 편지가 있어요. 나갈까요?")) return;
    try { await request("POST", "/logout"); } catch (e) { /* 이미 만료돼도 무시 */ }
    store.remove(TOKEN_KEY);
    store.remove(PROMPTED_KEY);
    current = null;
    go("#/");
  }

  /* ---------- 라우팅 ---------- */
  function homeRoute(role) {
    return role === "admin" ? "#/admin" : role === "mentor" ? "#/write" : "#/letters";
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  async function render() {
    closeModal();
    closeEditor(true);
    hideDialog(pwDialog);
    closeViewer();
    window.removeEventListener("resize", onPuzzleResize);
    const route = location.hash;
    if (route.length > 2 && !current && store.get(TOKEN_KEY, "")) {
      try { current = { user: (await request("GET", "/me")).user }; } catch (e) { current = null; }
    }
    app.replaceChildren();
    try {
      if (current && current.user.role === "mentee" && route === "#/letters") {
        const data = await request("GET", "/letters");
        renderLetters({ id: data.name, name: data.name, letters: data.letters });
        promptPasswordChange();
      } else if (current && (current.user.role === "mentee" || current.user.role === "admin") && /^#\/photos(\/\d+)?$/.test(route)) {
        const albumId = route.split("/")[2];
        if (albumId) renderAlbum(await request("GET", "/albums/" + albumId));
        else renderPhotos(await request("GET", "/albums"));
        promptPasswordChange();
      } else if (current && current.user.role === "admin" && route === "#/admin") {
        renderAdmin(await request("GET", "/admin/overview"));
        promptPasswordChange();
      } else if (current && current.user.role === "mentor" && route === "#/write") {
        const data = await request("GET", "/mentor/mentees");
        renderMentor(current.user, data.mentees);
        promptPasswordChange();
      } else if (current) {
        return go(homeRoute(current.user.role));
      } else {
        if (route) history.replaceState(null, "", location.pathname + location.search);
        renderHome();
      }
    } catch (e) {
      if (e.status === 401) return go("#/");
      renderError(e.message);
    }
    window.scrollTo(0, 0);
  }

  function renderError(text) {
    app.replaceChildren(
      h("section", { class: "page page--home" }, [
        h("div", { class: "home__inner" }, [
          h("h1", { class: "title title--brand", text: TITLE }),
          h("p", { class: "empty", text }),
          h("button", { class: "pill", type: "button", text: "다시 시도", style: "margin-top:24px", onclick: render })
        ])
      ])
    );
  }

  /* ---------- 1. 홈: 아이디 + 비밀번호 로그인 ---------- */
  function renderHome() {
    document.title = TITLE + " 롤링페이퍼";
    const common = { autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false" };
    const idInput = h("input", Object.assign({
      id: "login-id", type: "text", placeholder: "아이디", "aria-label": "아이디", enterkeyhint: "next", "aria-describedby": "login-msg"
    }, common));
    const pwInput = h("input", Object.assign({
      id: "login-pw", type: "password", placeholder: "비밀번호", "aria-label": "비밀번호",
      inputmode: "numeric", enterkeyhint: "go", "aria-describedby": "login-msg"
    }, common, { autocomplete: "current-password" }));
    const idField = h("label", { class: "search", html: ICON_USER }, [idInput]);
    const pwField = h("label", { class: "search", html: ICON_LOCK }, [pwInput]);
    const submit = h("button", { class: "pill", type: "submit", text: "들어가기" });
    const msg = h("p", { class: "lock__msg", id: "login-msg", role: "alert" });
    const forgotBox = h("div", { class: "forgot", id: "forgot-help", hidden: true }, [
      h("p", { class: "forgot__title", text: "비밀번호는 관리자에게 문의해 주세요" }),
      h("p", { text: "이름과 아이디를 알려 주면 새 임시 비밀번호를 받을 수 있어요." }),
      ADMIN_EMAIL ? h("p", { class: "forgot__contact" }, [
        "📧 ",
        h("a", {
          href: "mailto:" + ADMIN_EMAIL + "?subject=" + encodeURIComponent("[도란도란] 비밀번호 문의") +
            "&body=" + encodeURIComponent("이름:\n아이디:\n"),
          text: ADMIN_EMAIL
        })
      ]) : null
    ]);
    const forgotBtn = h("button", {
      class: "linkish", type: "button", text: "비밀번호를 잊어버렸어요",
      "aria-expanded": "false", "aria-controls": "forgot-help",
      onclick: () => {
        forgotBox.hidden = !forgotBox.hidden;
        forgotBtn.setAttribute("aria-expanded", String(!forgotBox.hidden));
      }
    });

    idInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !pwInput.value) { e.preventDefault(); pwInput.focus(); }
    });

    const form = h("form", {
      class: "login",
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        if (!idInput.value.trim()) return fail("아이디를 입력해 주세요.", idInput, idField);
        if (!pwInput.value.trim()) return fail("비밀번호를 입력해 주세요.", pwInput, pwField);
        submit.disabled = true;
        submit.textContent = "확인 중…";
        msg.textContent = "";
        try {
          const data = await request("POST", "/login", { login: idInput.value, password: pwInput.value });
          store.set(TOKEN_KEY, data.token);
          current = { user: data.user };
          go(homeRoute(data.user.role));
        } catch (err) {
          submit.disabled = false;
          submit.textContent = "들어가기";
          fail(err.message, pwInput, form);
          pwInput.value = "";
        }
      }
    }, [idField, pwField, submit, msg, forgotBtn, forgotBox]);

    function fail(text, input, shakeEl) {
      msg.textContent = text;
      shakeEl.classList.remove("shake");
      void shakeEl.offsetWidth;
      shakeEl.classList.add("shake");
      input.focus();
    }

    app.append(
      h("section", { class: "page page--home" }, [
        h("div", { class: "home__inner" }, [h("h1", { class: "title title--brand", text: TITLE }), form])
      ])
    );
    setTimeout(() => idInput.focus({ preventScroll: true }), 50);
  }

  /* ---------- 상단 메뉴: 편지 / 사진첩 (멘티), 현황 / 사진첩 (관리자) ---------- */
  function sectionNav(active) {
    const isAdmin = current && current.user.role === "admin";
    const items = isAdmin
      ? [["#/admin", "📊 현황"], ["#/photos", "📷 사진첩"]]
      : [["#/letters", "💌 편지"], ["#/photos", "📷 사진첩"]];
    return h("nav", { class: "section-nav", "aria-label": "메뉴" },
      items.map(([href, label]) => h("a", {
        href, text: label, class: active.startsWith(href) ? "is-active" : null,
        "aria-current": active.startsWith(href) ? "page" : null
      }))
    );
  }

  /* ---------- 사진첩 ---------- */
  const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
  function albumDate(d) {
    if (!d) return "";
    const [y, m, day] = d.split("-").map(Number);
    const wd = WEEKDAY[new Date(y, m - 1, day).getDay()];
    return `${m}월 ${day}일 (${wd})`;
  }

  function renderPhotos(data) {
    document.title = "사진첩 · " + TITLE;
    const isAdmin = current.user.role === "admin";
    const albums = data.albums;
    const list = h("div", { class: "timeline" });

    if (!albums.length) {
      list.append(h("p", { class: "empty", text: isAdmin ? "아직 올라온 사진이 없어요. npm run photos:sync 로 사진 폴더를 보내 주세요." : "아직 올라온 사진이 없어요." }));
    }

    // 월별로 묶기
    const groups = [];
    for (const a of albums) {
      const key = a.date ? a.date.slice(0, 7) : "etc";
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) groups.push((g = { key, items: [] }));
      g.items.push(a);
    }
    const monthLabel = (key) => key === "etc" ? "날짜 없음" : `${Number(key.slice(0, 4))}년 ${Number(key.slice(5))}월`;

    const jump = groups.length > 1 ? h("nav", { class: "month-jump", "aria-label": "월 바로가기" },
      groups.map((g) => h("a", { href: "#", text: monthLabel(g.key).replace(/^\d+년 /, ""), onclick: (e) => {
        e.preventDefault();
        document.getElementById("m-" + g.key)?.scrollIntoView({ behavior: "smooth", block: "start" });
      } }))) : null;

    for (const g of groups) {
      list.append(h("h2", { class: "month", id: "m-" + g.key, text: monthLabel(g.key) }));
      list.append(h("ul", { class: "albums" }, g.items.map((a, i) =>
        h("li", null, h("a", { class: "album-card" + (a.hidden ? " is-hidden" : ""), href: "#/photos/" + a.id }, [
          h("div", { class: "polaroids", "aria-hidden": "true" },
            (a.previews.length ? a.previews.slice(0, 3) : [null]).map((src, k) =>
              h("span", { class: "polaroid", style: `--r:${[-5, 4, -2][k] * (i % 2 ? -1 : 1)}deg; --z:${3 - k}` },
                src ? h("img", { src, alt: "", loading: "lazy", decoding: "async" }) : h("i", { text: "📷" })))),
          h("div", { class: "album-card__text" }, [
            a.date ? h("p", { class: "album-card__date", text: albumDate(a.date) }) : null,
            h("p", { class: "album-card__title", text: a.title }),
            h("p", { class: "album-card__count", text: `사진 ${a.count}장` + (a.hidden ? " · 숨김" : "") })
          ])
        ]))
      )));
    }

    let adminBar = null;
    if (isAdmin) {
      const st = data.status || {};
      const parts = [
        st.running ? "새 사진 확인 중…" : st.lastRunAt ? `마지막 확인 ${ago(st.lastRunAt.replace("T", " ").slice(0, 19))}` : "아직 확인 전",
        st.pending ? `변환 대기 ${st.pending}장` : null,
        st.errors ? `변환 실패 ${st.errors}장` : null,
        st.lastError ? `오류: ${st.lastError}` : null
      ].filter(Boolean);
      adminBar = h("div", { class: "admin-bar" }, [
        h("span", { text: parts.join(" · ") }),
        h("button", { class: "linkish", type: "button", text: "지금 확인", onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await request("POST", "/admin/photos/scan"); } catch (err) { alert(err.message); }
          setTimeout(render, 2500);
        } })
      ]);
    }

    app.append(h("section", { class: "page" }, [
      frame([h("div", { class: "letters photos" }, [
        sectionNav("#/photos"),
        h("h1", { class: "title title--name", text: "사진첩" }),
        adminBar, jump, list
      ])])
    ]));
  }

  function renderAlbum(data) {
    const { album, photos } = data;
    const isAdmin = current.user.role === "admin";
    document.title = album.title + " · 사진첩 · " + TITLE;
    const grid = h("ul", { class: "photo-grid" });

    function drawGrid() {
      grid.replaceChildren(...photos.map((p, i) => h("li", { class: p.hidden ? "is-hidden" : null }, [
        h("button", { class: "thumb", type: "button", "aria-label": `${i + 1}번째 사진 크게 보기`, onclick: (e) => openViewer(photos, i, e.currentTarget) },
          h("img", { src: p.thumb, alt: "", loading: "lazy", decoding: "async", width: 240, height: 240 })),
        isAdmin ? h("div", { class: "thumb__tools" }, [
          h("button", { type: "button", text: p.hidden ? "보이기" : "숨기기", onclick: async () => {
            try { await request("PATCH", "/admin/photos/" + p.id, { hidden: !p.hidden }); p.hidden = !p.hidden; drawGrid(); }
            catch (err) { alert(err.message); }
          } }),
          h("button", { type: "button", text: album.coverId === p.id ? "★ 대표" : "대표로", onclick: async () => {
            try { await request("PATCH", "/admin/albums/" + album.id, { coverId: p.id }); album.coverId = p.id; drawGrid(); }
            catch (err) { alert(err.message); }
          } })
        ]) : null
      ])));
    }
    drawGrid();

    let editor = null;
    if (isAdmin) {
      const title = h("input", { type: "text", value: album.title, maxlength: 60, "aria-label": "앨범 제목" });
      const desc = h("input", { type: "text", value: album.description, maxlength: 300, placeholder: "한 줄 설명 (선택)", "aria-label": "앨범 설명" });
      const hidden = h("input", { type: "checkbox" }); hidden.checked = album.hidden;
      const msg = h("span", { class: "album-edit__msg", role: "status" });
      editor = h("form", { class: "album-edit", onsubmit: async (e) => {
        e.preventDefault();
        try {
          await request("PATCH", "/admin/albums/" + album.id, { title: title.value, description: desc.value, hidden: hidden.checked });
          msg.textContent = "저장했어요";
        } catch (err) { msg.textContent = err.message; }
      } }, [
        title, desc,
        h("label", { class: "album-edit__hide" }, [hidden, " 멘티에게 숨기기"]),
        h("button", { class: "pill", type: "submit", text: "저장" }), msg
      ]);
    }

    app.append(h("section", { class: "page" }, [
      frame([h("div", { class: "letters photos" }, [
        sectionNav("#/photos"),
        h("a", { class: "crumb", href: "#/photos", text: "← 사진첩" }),
        album.date ? h("p", { class: "album-head__date", text: albumDate(album.date) }) : null,
        h("h1", { class: "title title--album", text: album.title }),
        album.description ? h("p", { class: "album-head__desc", text: album.description }) : null,
        h("p", { class: "album-head__count", text: `사진 ${photos.length}장 · 사진을 누르면 크게 볼 수 있어요` }),
        editor,
        photos.length ? grid : h("p", { class: "empty", text: "사진이 아직 없어요." })
      ])])
    ]));
  }

  /* 사진 크게 보기 (넘기기·다운로드) */
  const viewer = document.getElementById("viewer");
  const viewerImg = document.getElementById("viewer-img");
  const viewerCount = document.getElementById("viewer-count");
  const viewerDownload = document.getElementById("viewer-download");
  let viewing = null; // { list, index }

  function showPhoto(i) {
    const { list } = viewing;
    viewing.index = (i + list.length) % list.length;
    const p = list[viewing.index];
    viewerImg.classList.add("is-loading");
    viewerImg.onload = () => viewerImg.classList.remove("is-loading");
    viewerImg.src = p.large;
    viewerImg.alt = `${viewing.index + 1}번째 사진`;
    viewerCount.textContent = `${viewing.index + 1} / ${list.length}`;
    viewerDownload.href = p.download;
    // 다음 사진 미리 불러오기
    const next = list[(viewing.index + 1) % list.length];
    if (next) new Image().src = next.large;
  }
  function openViewer(list, index, trigger) {
    viewing = { list, index };
    showDialog(viewer, trigger, viewer.querySelector(".viewer__close"));
    showPhoto(index);
  }
  function closeViewer() {
    if (viewer.hidden) return;
    viewing = null;
    viewerImg.removeAttribute("src");
    hideDialog(viewer);
  }
  viewer.querySelector(".viewer__prev").addEventListener("click", () => showPhoto(viewing.index - 1));
  viewer.querySelector(".viewer__next").addEventListener("click", () => showPhoto(viewing.index + 1));
  viewer.querySelector(".viewer__close").addEventListener("click", closeViewer);
  viewer.addEventListener("click", (e) => { if (e.target === viewer || e.target.classList.contains("viewer__stage")) closeViewer(); });
  // 손가락으로 넘기기
  let touchX = null, touchY = null;
  viewer.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
  viewer.addEventListener("touchend", (e) => {
    if (touchX === null || !viewing) return;
    const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) showPhoto(viewing.index + (dx < 0 ? 1 : -1));
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeViewer();
  });

  /* ---------- 관리자: 전체 현황 ---------- */
  const ADMIN_TAB_KEY = "doran:admin-tab";

  function parseTime(s) {
    return s ? new Date(s.replace(" ", "T") + "Z") : null; // 서버 시각은 UTC
  }
  function ago(s) {
    const d = parseTime(s);
    if (!d) return "";
    const m = Math.round((Date.now() - d) / 60000);
    if (m < 1) return "방금";
    if (m < 60) return m + "분 전";
    if (m < 60 * 24) return Math.round(m / 60) + "시간 전";
    if (m < 60 * 24 * 7) return Math.round(m / 1440) + "일 전";
    return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
  }
  function exact(s) {
    const d = parseTime(s);
    return d ? d.toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  }

  function renderAdmin(data) {
    document.title = "전체 현황 · " + TITLE;
    const { mentors, mentees, letters } = data;
    const wrote = new Map(letters.map((l) => [l.mentorId + ":" + l.menteeId, l]));
    const total = mentors.length * mentees.length;
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

    const everyone = mentors.concat(mentees);
    const tiles = [
      { label: "작성된 편지", value: letters.length, of: total, note: `${pct(letters.length, total)}% 완료` },
      { label: "편지를 쓴 멘토", value: mentors.filter((m) => m.written > 0).length, of: mentors.length, note: `다 쓴 멘토 ${mentors.filter((m) => m.written >= mentees.length && mentees.length).length}명` },
      { label: "편지를 받은 멘티", value: mentees.filter((m) => m.received > 0).length, of: mentees.length, note: `다 받은 멘티 ${mentees.filter((m) => m.received >= mentors.length && mentors.length).length}명` },
      { label: "로그인한 사람", value: everyone.filter((u) => u.lastLoginAt).length, of: everyone.length, note: `비밀번호 바꾼 사람 ${everyone.filter((u) => u.pwChanged).length}명` }
    ];

    const stats = h("section", { class: "admin__stats", "aria-label": "요약" },
      tiles.map((t) => h("div", { class: "stat" }, [
        h("p", { class: "stat__label", text: t.label }),
        h("p", { class: "stat__value" }, [String(t.value), h("small", { text: " / " + t.of })]),
        meter(t.value, t.of),
        h("p", { class: "stat__note", text: t.note })
      ]))
    );

    function meter(n, d) {
      return h("div", {
        class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(d), "aria-valuenow": String(n),
        "aria-label": `${n} / ${d}`
      }, h("span", { style: `width:${pct(n, d)}%` }));
    }

    function personCard(u) {
      const isMentor = u.role === "mentor";
      const n = isMentor ? u.written : u.received;
      const d = isMentor ? mentees.length : mentors.length;
      const done = d && n >= d;
      return h("li", { class: "person" + (done ? " is-done" : "") }, [
        h("div", { class: "person__head" }, [
          h("p", { class: "person__name" }, [
            u.fullName,
            u.grade ? h("small", { text: " " + u.grade }) : null
          ]),
          h("code", { class: "person__login", text: u.login })
        ]),
        h("div", { class: "person__progress" }, [
          meter(n, d),
          h("span", { class: "person__count", text: `${isMentor ? "작성" : "받음"} ${n}/${d}` + (done ? " ✓" : "") })
        ]),
        h("ul", { class: "person__meta" }, [
          h("li", { text: u.lastLoginAt ? `로그인 ${ago(u.lastLoginAt)}` : "아직 로그인 안 함", title: exact(u.lastLoginAt) }),
          isMentor && u.lastWrittenAt ? h("li", { text: `마지막 작성 ${ago(u.lastWrittenAt)}`, title: exact(u.lastWrittenAt) }) : null,
          h("li", { class: u.pwChanged ? "" : "is-muted", text: u.pwChanged ? "비밀번호 바꿈" : u.tempIssued ? "임시 비밀번호 발급됨" : "초기 비밀번호" })
        ]),
        h("button", {
          class: "linkish person__reset", type: "button", text: "임시 비밀번호 발급",
          onclick: (e) => resetUserPassword(u, e.currentTarget)
        })
      ]);
    }

    function matrix() {
      const wrap = h("div", { class: "matrix", tabindex: "0", role: "region", "aria-label": "멘토별·멘티별 작성 현황 표 (가로로 스크롤)" });
      const table = h("table");
      table.append(h("caption", { class: "sr-only", text: "행은 멘티, 열은 멘토입니다. ✓ 를 누르면 편지를 볼 수 있어요." }));
      table.append(h("thead", null, h("tr", null, [
        h("th", { scope: "col", text: "멘티 \\ 멘토" }),
        ...mentors.map((m) => h("th", { scope: "col", text: m.name })),
        h("th", { scope: "col", text: "받음" })
      ])));
      const tbody = h("tbody");
      for (const e of mentees) {
        tbody.append(h("tr", null, [
          h("th", { scope: "row", text: e.name }),
          ...mentors.map((m) => {
            const l = wrote.get(m.id + ":" + e.id);
            return h("td", null, l
              ? h("button", {
                  class: "cell is-done", type: "button", text: "✓",
                  "aria-label": `${m.name} → ${e.name} 편지 보기`, title: `${m.name} → ${e.name} · ${exact(l.updatedAt)}`,
                  onclick: (ev) => showAdminLetter(m, e, ev.currentTarget)
                })
              : h("span", { class: "cell", text: "·", "aria-label": "아직 안 씀", title: `${m.name} → ${e.name} 아직 안 씀` }));
          }),
          h("td", { class: "matrix__sum", text: `${e.received}/${mentors.length}` })
        ]));
      }
      tbody.append(h("tr", { class: "matrix__foot" }, [
        h("th", { scope: "row", text: "작성" }),
        ...mentors.map((m) => h("td", { class: "matrix__sum", text: `${m.written}/${mentees.length}` })),
        h("td", { class: "matrix__sum", text: `${letters.length}/${total}` })
      ]));
      table.append(tbody);
      wrap.append(table);
      return wrap;
    }

    const VIEWS = [
      { id: "mentors", label: "멘토별", draw: () => h("ul", { class: "people" }, mentors.map(personCard)) },
      { id: "mentees", label: "멘티별", draw: () => h("ul", { class: "people" }, mentees.map(personCard)) },
      { id: "matrix", label: "전체 표", draw: matrix }
    ];
    let view = store.get(ADMIN_TAB_KEY, "mentors");
    if (!VIEWS.some((v) => v.id === view)) view = "mentors";
    const body = h("div", { class: "admin__view" });
    const tabs = h("div", { class: "views", role: "group", "aria-label": "보기 방식" });
    function setView(id) {
      view = id;
      store.set(ADMIN_TAB_KEY, id);
      for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.view === id));
      body.replaceChildren(VIEWS.find((v) => v.id === id).draw());
    }
    for (const v of VIEWS) tabs.append(h("button", { type: "button", "data-view": v.id, text: v.label, onclick: () => setView(v.id) }));

    const refresh = h("button", { class: "linkish", type: "button", text: "새로고침", onclick: render });
    const updated = h("p", { class: "admin__updated" }, [
      `${new Date().toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })} 기준 · `, refresh
    ]);

    app.append(
      h("section", { class: "page" }, [
        frame([
          h("div", { class: "letters admin" }, [
            sectionNav("#/admin"),
            h("h1", { class: "title title--name", text: "전체 현황" }),
            updated,
            stats,
            tabs,
            body
          ])
        ])
      ])
    );
    setView(view);
  }

  async function showAdminLetter(mentor, mentee, trigger) {
    try {
      const l = await request("GET", `/admin/letters/${mentor.id}/${mentee.id}`);
      openModal({ from: `${l.from} → ${l.to}`, body: l.body }, trigger);
    } catch (e) {
      if (e.status === 401) return go("#/");
      alert(e.message);
    }
  }

  async function resetUserPassword(u, trigger) {
    if (!confirm(`${u.fullName}(${u.login})의 임시 비밀번호를 새로 발급할까요?\n지금 비밀번호는 더 이상 쓸 수 없고, 로그인돼 있던 기기는 로그아웃돼요.`)) return;
    try {
      const r = await request("POST", `/admin/users/${u.id}/reset-password`);
      u.pwChanged = false;
      u.tempIssued = true;
      document.querySelector('.views [aria-pressed="true"]')?.click(); // 카드 상태 다시 그리기
      openModal({
        from: "임시 비밀번호 발급",
        body: `${r.name} · 아이디 ${r.login}\n\n임시 비밀번호\n${r.password}\n\n이 창을 닫으면 다시 볼 수 없어요.\n본인에게 알려 주면, 로그인할 때 새 비밀번호로 바꾸라는 안내가 나와요.`
      }, trigger);
    } catch (e) {
      if (e.status === 401) return go("#/");
      alert(e.message);
    }
  }

  /* ---------- 2. 멘토: 편지 쓰기 ---------- */
  function renderMentor(user, mentees) {
    document.title = user.name + " 선생님 · " + TITLE;
    const status = h("p", { class: "mentor__status" });
    const list = h("ul", { class: "inbox" });

    function draw() {
      const done = mentees.filter((m) => m.body).length;
      status.textContent = `멘티 ${mentees.length}명 중 ${done}명에게 편지를 썼어요`;
      list.replaceChildren(
        ...mentees.map((m) =>
          h("li", null,
            h("button", {
              class: "pill pill--mentee" + (m.body ? " is-done" : ""),
              type: "button",
              "aria-label": `${m.fullName} ${m.grade} — ${m.body ? "작성함" : "아직 안 씀"}`,
              onclick: (e) => openEditor(m, e.currentTarget, (body) => { m.body = body; draw(); })
            }, [
              h("span", { class: "pill__icon", "aria-hidden": "true", text: m.body ? "💌" : "✏️" }),
              h("span", { text: m.name }),
              m.grade ? h("small", { class: "pill__meta", text: m.grade }) : null
            ])
          )
        )
      );
    }
    draw();

    app.append(
      h("section", { class: "page" }, [
        frame([
          h("div", { class: "letters" }, [
            h("h1", { class: "title title--name", text: user.name }),
            status,
            list
          ])
        ])
      ])
    );
  }

  /* ---------- 3. 편지 보기 ---------- */
  let puzzleState = null;

  function renderLetters(student) {
    document.title = student.name + " · " + TITLE;
    let view = prefs.get("view", VIEWS[0].id);
    if (!VIEWS.some((v) => v.id === view)) view = VIEWS[0].id;

    const body = h("div", { class: "letters__view", style: "width:100%;display:flex;justify-content:center" });
    const tabs = h("div", { class: "views", role: "group", "aria-label": "보기 방식" });

    function setView(id) {
      view = id;
      prefs.set("view", id);
      for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.view === id));
      window.removeEventListener("resize", onPuzzleResize);
      body.replaceChildren();
      if (!student.letters.length) {
        body.append(h("p", { class: "empty", text: "아직 도착한 편지가 없어요." }));
      } else if (id === "cards") body.append(viewCards(student));
      else if (id === "puzzle") body.append(viewPuzzle(student));
      else body.append(viewInbox(student));
    }
    for (const v of VIEWS) {
      tabs.append(h("button", { type: "button", "data-view": v.id, text: v.label, onclick: () => setView(v.id) }));
    }

    app.append(
      h("section", { class: "page" }, [
        frame([h("div", { class: "letters" }, [sectionNav("#/letters"), h("h1", { class: "title title--name", text: student.name }), tabs, body])])
      ])
    );
    setView(view);
  }

  function viewCards(student) {
    return h("div", { class: "cards" },
      student.letters.map((l) =>
        h("article", { class: "letter" }, [
          h("h2", { class: "letter__from", text: l.from }),
          h("div", { class: "letter__body", text: l.body })
        ])
      )
    );
  }

  function viewInbox(student) {
    return h("ul", { class: "inbox" },
      student.letters.map((l) =>
        h("li", null,
          h("button", { class: "pill", type: "button", onclick: (e) => openModal(l, e.currentTarget) }, [
            h("span", { class: "pill__icon", "aria-hidden": "true", text: "💌" }),
            h("span", { text: l.from })
          ])
        )
      )
    );
  }

  /* 퍼즐 조각 경로: 100x100 본체 + 사방 25 여백 (viewBox 150x150)
     edges = [top, right, bottom, left], 0 평평 / 1 튀어나옴 / -1 들어감 */
  function piecePath(edges) {
    const S = 100, M = 25, n = 9, r = 13;
    const corners = [[M, M], [M + S, M], [M + S, M + S], [M, M + S]];
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let d = "M" + corners[0].join(" ");
    for (let i = 0; i < 4; i++) {
      const [px, py] = corners[i];
      const [dx, dy] = dirs[i];
      const end = corners[(i + 1) % 4];
      const t = edges[i];
      if (t) {
        const cx = px + dx * S / 2, cy = py + dy * S / 2;
        d += ` L${cx - dx * n} ${cy - dy * n}`;
        d += ` A${r} ${r} 0 1 ${t > 0 ? 1 : 0} ${cx + dx * n} ${cy + dy * n}`;
      }
      d += ` L${end[0]} ${end[1]}`;
    }
    return d + "Z";
  }

  function puzzleLayout(width) {
    const cols = width < 420 ? 3 : width < 760 ? 4 : 5;
    const cell = Math.max(56, Math.min(140, Math.floor((width - 8) / (cols + 0.3))));
    return { cols, cell };
  }

  function onPuzzleResize() {
    if (!puzzleState) return;
    clearTimeout(puzzleState.timer);
    puzzleState.timer = setTimeout(() => {
      const { el, student } = puzzleState;
      const next = puzzleLayout(el.parentElement.clientWidth);
      if (next.cols !== puzzleState.cols || next.cell !== puzzleState.cell) {
        el.replaceWith(viewPuzzle(student, false));
      }
    }, 120);
  }

  function viewPuzzle(student, animate = true) {
    const el = h("div", { class: "puzzle" });
    // 첫 렌더 땐 아직 DOM에 없으니 프레임 너비 기준으로 계산
    const width = (el.parentElement && el.parentElement.clientWidth) ||
      Math.min(document.documentElement.clientWidth - 24, 1080) - 2 * Math.max(20, Math.min(56, window.innerWidth * 0.05));
    const { cols, cell } = puzzleLayout(width);
    const total = Math.ceil(student.letters.length / cols) * cols;
    const rows = total / cols;
    const rand = seeded(student.id + ":" + cols);
    const sign = () => (rand() < 0.5 ? 1 : -1);

    const right = Array.from({ length: rows }, () => Array.from({ length: cols }, sign));
    const bottom = Array.from({ length: rows }, () => Array.from({ length: cols }, sign));

    el.style.setProperty("--cols", cols);
    el.style.setProperty("--cell", cell + "px");

    for (let i = 0; i < total; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const edges = [
        r === 0 ? 0 : -bottom[r - 1][c],
        c === cols - 1 ? 0 : right[r][c],
        r === rows - 1 ? 0 : bottom[r][c],
        c === 0 ? 0 : -right[r][c - 1]
      ];
      const letter = student.letters[i];
      const color = letter ? PIECE_COLORS[i % PIECE_COLORS.length] : "#77b17e";
      const svg = `<svg viewBox="0 0 150 150" aria-hidden="true"><path d="${piecePath(edges)}" fill="${color}"/></svg>`;
      const style = [
        `--rot:${((rand() - 0.5) * 6).toFixed(1)}deg`,
        `--fx:${((rand() - 0.5) * cell * 1.6).toFixed(0)}px`,
        `--fy:${(-cell * (0.6 + rand())).toFixed(0)}px`,
        `--frot:${((rand() - 0.5) * 70).toFixed(0)}deg`,
        `--delay:${animate ? (i * 0.06).toFixed(2) : 0}s`,
        animate ? "" : "animation:none"
      ].join(";");

      if (letter) {
        el.append(h("button", {
          class: "piece", type: "button", style, html: svg,
          "aria-label": letter.from + "의 편지 열기",
          onclick: (e) => openModal(letter, e.currentTarget)
        }, [h("span", { text: letter.from.replace(/\s+/, "\n") , style: "white-space:pre-line" })]));
      } else {
        el.append(h("div", { class: "piece piece--blank", style, html: svg, "aria-hidden": "true" }));
      }
    }

    puzzleState = { el, student, cols, cell };
    window.addEventListener("resize", onPuzzleResize);
    return el;
  }

  /* ---------- 모달 공통 ---------- */
  let lastFocus = null;

  function showDialog(el, trigger, focusEl) {
    lastFocus = trigger || document.activeElement;
    el.hidden = false;
    document.body.classList.add("is-locked");
    (focusEl || el.querySelector(".modal__close")).focus({ preventScroll: true });
  }

  function hideDialog(el) {
    if (el.hidden) return;
    el.hidden = true;
    if (modal.hidden && editor.hidden && pwDialog.hidden && viewer.hidden) document.body.classList.remove("is-locked");
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  /* 편지 읽기 */
  function openModal(letter, trigger) {
    modalTitle.textContent = letter.from;
    modalBody.textContent = letter.body;
    modalBody.scrollTop = 0;
    showDialog(modal, trigger);
  }
  function closeModal() { hideDialog(modal); }

  /* 편지 쓰기 (멘토) */
  const editor = document.getElementById("editor");
  const editorTitle = document.getElementById("editor-title");
  const editorText = document.getElementById("editor-text");
  const editorCount = document.getElementById("editor-count");
  const editorMsg = document.getElementById("editor-msg");
  const editorSave = document.getElementById("editor-save");
  const MAX_LETTER = 5000;
  let editing = null; // { mentee, saved, onSaved }

  function editorDirty() {
    return !!editing && editorText.value.trim() !== editing.saved;
  }

  function updateCount() {
    const n = editorText.value.length;
    editorCount.textContent = `${n.toLocaleString()} / ${MAX_LETTER.toLocaleString()}자`;
    editorCount.classList.toggle("is-over", n > MAX_LETTER);
    editorSave.disabled = !editorDirty() || n > MAX_LETTER;
  }

  function openEditor(mentee, trigger, onSaved) {
    editing = { mentee, saved: mentee.body || "", onSaved };
    editorTitle.textContent = `To. ${mentee.name}`;
    editorText.value = mentee.body || "";
    editorMsg.textContent = "";
    updateCount();
    showDialog(editor, trigger, editorText);
  }

  function closeEditor(force) {
    if (editor.hidden) return true;
    if (!force && editorDirty() && !confirm("저장하지 않은 내용이 있어요. 닫을까요?")) return false;
    editing = null;
    hideDialog(editor);
    return true;
  }

  editorText.addEventListener("input", () => { editorMsg.textContent = ""; updateCount(); });
  editor.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!editing || editorSave.disabled) return;
    const target = editing;
    editorSave.disabled = true;
    editorSave.textContent = "저장 중…";
    try {
      const data = await request("PUT", "/mentor/letters/" + target.mentee.id, { body: editorText.value });
      target.saved = data.body;
      target.onSaved(data.body);
      editorMsg.textContent = data.body ? "저장했어요 💌" : "편지를 지웠어요.";
      editorMsg.classList.remove("is-error");
    } catch (err) {
      editorMsg.textContent = err.message;
      editorMsg.classList.add("is-error");
      if (err.status === 401) { editing = null; setTimeout(() => go("#/"), 1200); }
    } finally {
      editorSave.textContent = "저장";
      updateCount();
    }
  });
  editorText.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") editor.querySelector("form").requestSubmit();
  });

  /* 비밀번호 변경 */
  const pwDialog = document.getElementById("pwdialog");
  const pwForm = pwDialog.querySelector("form");
  const pwNote = document.getElementById("pw-note");
  const pwMsg = document.getElementById("pw-msg");
  const pwSave = document.getElementById("pw-save");
  const pwLater = document.getElementById("pw-later");
  const PROMPTED_KEY = "doran:pw-prompted";

  function openPassword(trigger, first) {
    pwForm.reset();
    pwMsg.textContent = "";
    pwMsg.classList.remove("is-ok");
    pwNote.hidden = !first;
    pwLater.textContent = first ? "나중에 할게요" : "취소";
    showDialog(pwDialog, trigger, pwForm.elements.current);
  }
  function closePassword() { hideDialog(pwDialog); }

  function promptPasswordChange() {
    if (!current || !current.user.mustChangePassword || store.get(PROMPTED_KEY, "") === "1") return;
    store.set(PROMPTED_KEY, "1");
    setTimeout(() => openPassword(null, true), 400);
  }

  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pwSave.disabled) return;
    const f = pwForm.elements;
    const fail = (text, input) => {
      pwMsg.textContent = text;
      pwMsg.classList.remove("is-ok");
      if (input) { input.focus(); input.select(); }
    };
    if (!f.current.value.trim()) return fail("지금 비밀번호를 입력해 주세요.", f.current);
    if (f.next.value.trim().length < 6) return fail("새 비밀번호는 6자 이상으로 정해 주세요.", f.next);
    if (f.next.value.trim() !== f.confirm.value.trim()) return fail("새 비밀번호가 서로 달라요. 다시 입력해 주세요.", f.confirm);
    pwSave.disabled = true;
    pwSave.textContent = "바꾸는 중…";
    try {
      await request("POST", "/password", { current: f.current.value, next: f.next.value });
      current.user.mustChangePassword = false;
      pwMsg.textContent = "비밀번호를 바꿨어요. 다음부터 새 비밀번호로 로그인하세요.";
      pwMsg.classList.add("is-ok");
      pwForm.reset();
      setTimeout(closePassword, 1600);
    } catch (err) {
      if (err.status === 401) { closePassword(); return go("#/"); }
      fail(err.message, f[(err.field === "next" ? "next" : "current")]);
    } finally {
      pwSave.disabled = false;
      pwSave.textContent = "바꾸기";
    }
  });

  for (const dlg of [modal, editor, pwDialog]) {
    dlg.addEventListener("click", (e) => {
      if (!e.target.closest("[data-close]")) return;
      if (dlg === editor) closeEditor(); else if (dlg === pwDialog) closePassword(); else closeModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (!viewer.hidden && viewing) {
      if (e.key === "Escape") return closeViewer();
      if (e.key === "ArrowLeft") return showPhoto(viewing.index - 1);
      if (e.key === "ArrowRight") return showPhoto(viewing.index + 1);
    }
    const dlg = !viewer.hidden ? viewer : !pwDialog.hidden ? pwDialog : !editor.hidden ? editor : !modal.hidden ? modal : null;
    if (!dlg) return;
    if (e.key === "Escape") { dlg === editor ? closeEditor() : dlg === pwDialog ? closePassword() : dlg === viewer ? closeViewer() : closeModal(); return; }
    if (e.key === "Tab") {
      const items = [...dlg.querySelectorAll("button:not([disabled]), textarea, input, [tabindex]:not([tabindex='-1'])")]
        .filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (editorDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  window.addEventListener("hashchange", render);
  render();
})();
