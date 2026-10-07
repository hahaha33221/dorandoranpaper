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
  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  async function render() {
    closeModal();
    closeEditor(true);
    hideDialog(pwDialog);
    window.removeEventListener("resize", onPuzzleResize);
    const route = location.hash;
    if ((route === "#/letters" || route === "#/write") && !current && store.get(TOKEN_KEY, "")) {
      try { current = { user: (await request("GET", "/me")).user }; } catch (e) { current = null; }
    }
    app.replaceChildren();
    try {
      if (current && current.user.role === "mentee" && route === "#/letters") {
        const data = await request("GET", "/letters");
        renderLetters({ id: data.name, name: data.name, letters: data.letters });
        promptPasswordChange();
      } else if (current && current.user.role === "mentor" && route === "#/write") {
        const data = await request("GET", "/mentor/mentees");
        renderMentor(current.user, data.mentees);
        promptPasswordChange();
      } else if (current) {
        return go(current.user.role === "mentor" ? "#/write" : "#/letters");
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
          go(data.user.role === "mentor" ? "#/write" : "#/letters");
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
        frame([h("div", { class: "letters" }, [h("h1", { class: "title title--name", text: student.name }), tabs, body])])
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
    if (modal.hidden && editor.hidden && pwDialog.hidden) document.body.classList.remove("is-locked");
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
    const dlg = !pwDialog.hidden ? pwDialog : !editor.hidden ? editor : !modal.hidden ? modal : null;
    if (!dlg) return;
    if (e.key === "Escape") { dlg === editor ? closeEditor() : dlg === pwDialog ? closePassword() : closeModal(); return; }
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
