(function () {
  "use strict";

  const DATA = window.ROLLING_DATA;
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
  const ICON_USER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/></svg>';

  function frame(children) {
    const svg = '<svg class="frame__border" aria-hidden="true"><rect x="1.5" y="1.5" width="100%" height="100%" rx="18" ry="18" style="width:calc(100% - 3px);height:calc(100% - 3px)"/></svg>';
    const back = h("button", { class: "back", type: "button", "aria-label": "나가기", html: ICON_BACK, onclick: logout });
    const el = h("div", { class: "frame", html: svg }, [back].concat(children));
    return el;
  }

  /* ---------- 아이디 → 편지 복호화 ---------- */
  const SESSION_KEY = "doran:id";
  let current = null; // { id, name, letters }

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  const normalizeId = (s) => s.normalize("NFC").trim().toLowerCase();

  async function unlock(rawId) {
    const id = normalizeId(rawId);
    if (!id) return null;
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(id), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: b64(DATA.salt), iterations: DATA.iterations }, base, 512
    ));
    const token = hex(bits.slice(0, 16));
    const entry = DATA.entries[token];
    if (!entry) return null;
    const key = await crypto.subtle.importKey("raw", bits.slice(32, 64), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(entry.iv) }, key, b64(entry.data));
    const mentee = JSON.parse(new TextDecoder().decode(plain));
    return { id: token, name: mentee.name, letters: mentee.letters || [] };
  }

  function logout() {
    current = null;
    store.remove(SESSION_KEY);
    go("#/");
  }

  /* ---------- 라우팅 ---------- */
  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  async function render() {
    closeModal();
    window.removeEventListener("resize", onPuzzleResize);
    if (location.hash === "#/letters" && !current) {
      const saved = store.get(SESSION_KEY, "");
      if (saved) {
        try { current = await unlock(saved); } catch (e) { current = null; }
      }
    }
    app.replaceChildren();
    if (location.hash === "#/letters" && current) renderLetters(current);
    else {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      renderHome();
    }
    window.scrollTo(0, 0);
  }

  /* ---------- 1. 홈: 아이디 로그인 ---------- */
  function renderHome() {
    document.title = DATA.title + " 롤링페이퍼";
    const input = h("input", {
      id: "login-id",
      type: "text",
      placeholder: "아이디",
      autocomplete: "off",
      autocapitalize: "none",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "go",
      "aria-label": "아이디",
      "aria-describedby": "login-msg"
    });
    const field = h("label", { class: "search", html: ICON_USER }, [input]);
    const submit = h("button", { class: "pill", type: "submit", text: "들어가기" });
    const msg = h("p", { class: "lock__msg", id: "login-msg", role: "alert" });

    const form = h("form", {
      class: "login",
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        if (!input.value.trim()) return fail("아이디를 입력해 주세요.");
        submit.disabled = true;
        submit.textContent = "확인 중…";
        msg.textContent = "";
        let mentee = null;
        try { mentee = await unlock(input.value); } catch (err) { mentee = null; }
        submit.disabled = false;
        submit.textContent = "들어가기";
        if (!mentee) return fail("아이디를 다시 확인해 주세요.");
        current = mentee;
        store.set(SESSION_KEY, normalizeId(input.value));
        go("#/letters");
      }
    }, [field, submit, msg]);

    function fail(text) {
      msg.textContent = text;
      field.classList.remove("shake");
      void field.offsetWidth;
      field.classList.add("shake");
      input.select();
    }

    app.append(
      h("section", { class: "page page--home" }, [
        h("div", { class: "home__inner" }, [h("h1", { class: "title title--brand", text: DATA.title }), form])
      ])
    );
    setTimeout(() => input.focus({ preventScroll: true }), 50);
  }

  /* ---------- 3. 편지 보기 ---------- */
  let puzzleState = null;

  function renderLetters(student) {
    document.title = student.name + " · " + DATA.title;
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
    const cell = Math.max(78, Math.min(140, Math.floor((width - 16) / (cols + 0.3))));
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

  /* ---------- 모달 ---------- */
  let lastFocus = null;

  function openModal(letter, trigger) {
    lastFocus = trigger || document.activeElement;
    modalTitle.textContent = letter.from;
    modalBody.textContent = letter.body;
    modalBody.scrollTop = 0;
    modal.hidden = false;
    document.body.classList.add("is-locked");
    modal.querySelector(".modal__close").focus({ preventScroll: true });
  }

  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("is-locked");
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") closeModal();
    if (e.key === "Tab") { e.preventDefault(); modal.querySelector(".modal__close").focus(); }
  });

  window.addEventListener("hashchange", render);
  if (!window.crypto || !crypto.subtle) {
    app.innerHTML = '<p class="empty" style="padding:40px 20px">이 브라우저에서는 열 수 없어요. https 주소로 접속해 주세요.</p>';
  } else {
    render();
  }
})();
