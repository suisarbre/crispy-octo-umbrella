// 월드 화면. 대규모 전구 캔버스(스크롤/줌/90도 회전), 지휘망 제안, 사건 점프, 세이브를 담당한다.

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f", "#37725e"];
const SAVE_KEY = "crispy-octo-umbrella/world-v2";
const SAVE_VERSION = 2;
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const TICK_MS = 35;
const HOLD_MS = 350;
const PULSE_MS_PER_TICK = 18;
const PULSE_REST = 5;

// 세로 화면 90도 반시계 회전 시 Box-drawing 선 글리프 매핑.
const ROT_GLYPH = new Map([
  [0x2500, 0x2502], [0x2502, 0x2500], // ─ ↔ │
  [0x250c, 0x2514], [0x2514, 0x2518], [0x2518, 0x2510], [0x2510, 0x250c], // ┌→└→┘→┐
  [0x251c, 0x2534], [0x2534, 0x2524], [0x2524, 0x252c], [0x252c, 0x251c], // ├→┴→┤→┬
  [0x2550, 0x2551], [0x2551, 0x2550], // ═ ↔ ║
  [0x2554, 0x255a], [0x255a, 0x255d], [0x255d, 0x2557], [0x2557, 0x2554], // ╔→╚→╝→╗
  [0x2560, 0x2569], [0x2569, 0x2563], [0x2563, 0x2566], [0x2566, 0x2560], // ╠→╩→╣→╦
]);

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");
const canvasBox = $("canvas-box");
const menu = $("menu");
const pop = $("pop");
const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;
const W_COLS = wasm.w_cols();
const W_ROWS = wasm.w_rows();

// 세이브: (시드, 이벤트 목록). ["t", n], [x, y], ["o", cmd], ["s", 0](특수부대 선택), ["p", idx](제안 수락)
let save = { v: SAVE_VERSION, seed: 0, events: [] };
let playing = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 카메라 및 뷰 상태
let view = {
  narrow: false,
  rot: false,
  overview: false,
  cssW: 800,
  cssH: 500,
  cw: 18,
  ch: 20,
  font: 16,
  // 디스플레이 공간 기준 카메라 오프셋(픽셀)
  camX: 0,
  camY: 0,
  // 전술 뷰 셀 크기 (줌 조절 가능)
  zoomCw: 18,
};

let parsedProposals = [];
let activeMobTab = "prop";
let sheetOpen = false;

const dispCols = () => (view.rot ? W_ROWS : W_COLS);
const dispRows = () => (view.rot ? W_COLS : W_ROWS);
const toDisplay = (gx, gy) => (view.rot ? [gy, W_COLS - 1 - gx] : [gx, gy]);
const toGame = (dx, dy) => (view.rot ? [W_COLS - 1 - dy, dx] : [dx, dy]);

function clampCam() {
  const totalW = dispCols() * view.cw;
  const totalH = dispRows() * view.ch;
  if (totalW <= view.cssW) {
    view.camX = -(view.cssW - totalW) / 2;
  } else {
    view.camX = Math.max(0, Math.min(view.camX, totalW - view.cssW));
  }
  if (totalH <= view.cssH) {
    view.camY = -(view.cssH - totalH) / 2;
  } else {
    view.camY = Math.max(0, Math.min(view.camY, totalH - view.cssH));
  }
}

function centerOn(gx, gy) {
  const [dx, dy] = toDisplay(gx, gy);
  view.camX = (dx + 0.5) * view.cw - view.cssW / 2;
  view.camY = (dy + 0.5) * view.ch - view.cssH / 2;
  clampCam();
}

function layout() {
  view.narrow = window.innerWidth < 700;
  view.rot = view.narrow && window.innerHeight > window.innerWidth;
  const r = canvasBox.getBoundingClientRect();
  view.cssW = Math.max(200, Math.floor(r.width));
  view.cssH = Math.max(200, Math.floor(r.height));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(view.cssW * dpr);
  canvas.height = Math.floor(view.cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (view.overview) {
    const fitW = view.cssW / dispCols();
    const fitH = view.cssH / dispRows();
    const s = Math.max(5, Math.min(fitW, fitH));
    view.cw = s;
    view.ch = s;
    view.font = Math.max(8, Math.floor(s * 0.95));
  } else {
    view.cw = view.zoomCw;
    view.ch = Math.round(view.zoomCw * 1.12);
    view.font = Math.max(11, Math.floor(view.ch * 0.82));
  }
  clampCam();
  updateModeUI();
}

function setOverview(on, focusGamePos) {
  if (view.overview === on && !focusGamePos) return;
  // 전술 뷰 → 전체 보기로 갈 때 현재 중심 기억
  let centerGame = focusGamePos;
  if (!centerGame) {
    const cx = (view.camX + view.cssW / 2) / view.cw;
    const cy = (view.camY + view.cssH / 2) / view.ch;
    centerGame = toGame(cx, cy);
  }
  view.overview = on;
  layout();
  if (!on && centerGame) {
    centerOn(centerGame[0], centerGame[1]);
  }
  draw();
}

function updateModeUI() {
  const modeEl = $("view-mode");
  if (view.overview) {
    modeEl.innerHTML = "<strong>전구 전체 보기</strong> · 클릭/휠로 확대 · 1/2/3: 지휘망 제안 위치";
  } else {
    modeEl.innerHTML = "<strong>전술 뷰</strong> · 드래그/WASD 이동 · 휠 줌 · 특수부대 클릭 후 명령";
  }
  $("btn-overview").style.borderColor = view.overview ? "var(--brood)" : "";
  $("btn-overview").style.color = view.overview ? "var(--brood)" : "";
  $("fab-overview").classList.toggle("active", view.overview);
  $("fab-overview").textContent = view.overview ? "전술" : "전체";
}

function draw() {
  const frame = new Uint32Array(wasm.memory.buffer, wasm.w_frame_ptr(), W_COLS * W_ROWS);
  const { cw, ch, camX, camY, cssW, cssH } = view;

  ctx.fillStyle = PALETTE[0];
  ctx.fillRect(0, 0, cssW, cssH);

  // 보이는 디스플레이 칸 범위만 렌더링
  const minDx = Math.max(0, Math.floor(camX / cw) - 1);
  const maxDx = Math.min(dispCols() - 1, Math.ceil((camX + cssW) / cw) + 1);
  const minDy = Math.max(0, Math.floor(camY / ch) - 1);
  const maxDy = Math.min(dispRows() - 1, Math.ceil((camY + cssH) / ch) + 1);

  ctx.font = `${view.font}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let dy = minDy; dy <= maxDy; dy++) {
    for (let dx = minDx; dx <= maxDx; dx++) {
      const [gx, gy] = toGame(dx, dy);
      const c = frame[gy * W_COLS + gx];
      let glyph = c & 0x1fffff;
      if (view.rot && ROT_GLYPH.has(glyph)) glyph = ROT_GLYPH.get(glyph);
      const bgIdx = c >>> 28;
      const fgIdx = (c >>> 24) & 0xf;
      const px = dx * cw - camX;
      const py = dy * ch - camY;
      if (bgIdx !== 0) {
        ctx.fillStyle = PALETTE[bgIdx];
        ctx.fillRect(px, py, cw + 0.5, ch + 0.5);
      }
      if (glyph === 0x20) continue;
      // 전체 보기에서는 배경 기준점(+)을 생략해 가독성 확보
      if (view.overview && glyph === 0x2b) continue;
      ctx.fillStyle = PALETTE[fgIdx];
      ctx.fillText(String.fromCodePoint(glyph), px + cw / 2, py + ch / 2 + 1);
    }
  }

  drawPulses(frame);
  if (!view.overview) {
    drawLabels();
    drawSectorCoords();
  } else {
    drawOverviewOverlays();
  }

  syncTextAndPanels();
  placeMenu();
}

function drawSectorCoords() {
  const { cw, ch, camX, camY, cssW, cssH } = view;
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.fillStyle = PALETTE[1];
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // 상단 열 좌표 (게임 X축 8칸마다 A, B, C...)
  if (!view.rot) {
    for (let cx = 0; cx < Math.floor(W_COLS / 8); cx++) {
      const px = (cx * 8 + 4) * cw - camX;
      if (px > 16 && px < cssW - 16) {
        ctx.fillText(String.fromCharCode(65 + cx), px, 3);
      }
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let cy = 0; cy < Math.floor(W_ROWS / 8); cy++) {
      const py = (cy * 8 + 4) * ch - camY;
      if (py > 16 && py < cssH - 16) {
        ctx.fillText(String(cy + 1).padStart(2, "0"), 4, py);
      }
    }
  } else {
    // 90도 회전: 가로=행(01..06), 세로=열(A..K, 아래→위)
    for (let cy = 0; cy < Math.floor(W_ROWS / 8); cy++) {
      const px = (cy * 8 + 4) * cw - camX;
      if (px > 14 && px < cssW - 14) {
        ctx.fillText(String(cy + 1).padStart(2, "0"), px, 3);
      }
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let cx = 0; cx < Math.floor(W_COLS / 8); cx++) {
      const py = (W_COLS - 1 - (cx * 8 + 4)) * ch - camY;
      if (py > 14 && py < cssH - 14) {
        ctx.fillText(String.fromCharCode(65 + cx), 4, py);
      }
    }
  }
}

function drawOverviewOverlays() {
  const { cw, ch, camX, camY } = view;
  // 특수부대 위치 강조 링
  const sp = wasm.w_special_pos();
  const [sdx, sdy] = toDisplay(sp & 0xff, (sp >>> 8) & 0xff);
  const spx = sdx * cw - camX + cw / 2;
  const spy = sdy * ch - camY + ch / 2;
  ctx.strokeStyle = PALETTE[3];
  ctx.lineWidth = 1.5;
  ctx.strokeRect(spx - cw, spy - ch, cw * 2, ch * 2);

  // 지휘망 제안 마커 [1], [2], [3]
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  parsedProposals.forEach((p, idx) => {
    const [dx, dy] = toDisplay(p.x, p.y);
    const px = dx * cw - camX + cw / 2;
    const py = dy * ch - camY - 8;
    const tag = String(idx + 1);
    ctx.fillStyle = idx === 0 ? PALETTE[3] : PALETTE[2];
    ctx.fillRect(px - 7, py - 6, 14, 12);
    ctx.fillStyle = PALETTE[0];
    ctx.fillText(tag, px, py + 0.5);
  });
}

function drawPulses(frame) {
  const len = wasm.w_routes_len();
  if (!len || stillness.matches) return;
  const routes = new Uint32Array(wasm.memory.buffer, wasm.w_routes_ptr(), len);
  const { cw, ch, camX, camY } = view;
  const now = performance.now();
  ctx.font = `${view.font}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0, k = 0; i < len; k++) {
    const head = routes[i];
    const n = head & 0xffff;
    const selected = !!(head & (1 << 16));
    const interval = Math.max(1, head >>> 20) * PULSE_MS_PER_TICK;
    const at = Math.floor(((now + k * 310) % ((n + PULSE_REST) * interval)) / interval);
    if (at < n) {
      const cell = routes[i + 1 + at];
      const x = cell & 0xff;
      const y = (cell >>> 8) & 0xff;
      let glyph = frame[y * W_COLS + x] & 0x1fffff;
      // 도로 선 위에서만 빛을 흘린다.
      if (glyph >= 0x2500 && glyph <= 0x257f) {
        if (view.rot && ROT_GLYPH.has(glyph)) glyph = ROT_GLYPH.get(glyph);
        const [dx, dy] = toDisplay(x, y);
        const px = dx * cw - camX;
        const py = dy * ch - camY;
        ctx.fillStyle = PALETTE[0];
        ctx.fillRect(px, py, cw, ch);
        ctx.fillStyle = PALETTE[selected ? 2 : 3];
        ctx.fillText(String.fromCodePoint(glyph), px + cw / 2, py + ch / 2 + 1);
      }
    }
    i += 1 + n;
  }
}

setInterval(() => {
  if (!playing && !stillness.matches && !document.hidden && wasm.w_routes_len()) draw();
}, 60);

function drawLabels() {
  const labels = new Uint32Array(wasm.memory.buffer, wasm.w_labels_ptr(), wasm.w_labels_len());
  const { cw, ch, camX, camY, cssW, cssH } = view;
  const size = Math.max(10, Math.round(view.font * 0.72));
  const line = size + 2;
  ctx.font = `${size}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < labels.length; ) {
    let n = 1;
    while (i + n < labels.length && (labels[i + n] & 0xffff) === (labels[i] & 0xffff)) n++;
    const [dx, dy] = toDisplay(labels[i] & 0xff, (labels[i] >>> 8) & 0xff);
    const cx = dx * cw - camX + cw / 2;
    const baseTop = dy * ch - camY - n * line;
    if (cx < -30 || cx > cssW + 30 || baseTop < -40 || baseTop > cssH + 40) {
      i += n;
      continue;
    }
    for (let k = 0; k < n; k++) {
      const l = labels[i + k];
      const num = (l >>> 16) & 0xfff;
      const isEmpire = !!(l & (1 << 28));
      const isSelected = !!(l & (1 << 29));
      const isSpecial = !!(l & (1 << 30));
      const isGarrison = !!(l & (1 << 31));
      const text = isGarrison ? `[${num}]` : String(num);
      const color = isEmpire ? PALETTE[4] : isSpecial ? PALETTE[3] : PALETTE[5];
      const w = Math.max(line, ctx.measureText(text).width + 4);
      const x = cx - w / 2;
      const y = baseTop + k * line;
      ctx.fillStyle = isSelected ? color : PALETTE[0];
      ctx.fillRect(x, y, w, line);
      ctx.fillStyle = isSelected ? PALETTE[0] : color;
      ctx.fillText(text, x + w / 2, y + line / 2 + 0.5);
    }
    i += n;
  }
}

let lastTextRaw = "";
function syncTextAndPanels() {
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.w_text_ptr(), wasm.w_text_len());
  const raw = new TextDecoder().decode(bytes);
  const parts = raw.split("\u001f");
  $("hdr-desktop").textContent = parts[0] ?? "";
  $("hdr-mobile").textContent = parts[1] ?? "";
  $("sp-summary").textContent = parts[2] ?? "";
  $("menu-head").textContent = parts[5] ?? "";
  $("mob-cmd-title").textContent = parts[5] ?? "";
  $("notice").textContent = parts[6] ?? "";
  $("seed").textContent = `시드 ${save.seed}`;
  const halted = !!wasm.w_halted();
  $("day").disabled = playing || halted;
  $("until").disabled = playing || halted;

  const spPos = wasm.w_special_pos();
  const spSelected = !!(spPos & (1 << 16));
  $("fab-squad").classList.toggle("active", spSelected);
  $("btn-squad").style.borderColor = spSelected ? "var(--brood)" : "";
  $("btn-squad").style.color = spSelected ? "var(--brood)" : "";

  if (raw === lastTextRaw) return;
  lastTextRaw = raw;

  // 지휘망 제안 렌더
  const propLines = (parts[3] ?? "").split("\n").filter(Boolean);
  parsedProposals = propLines.map((line) => {
    const [tag, title, reason, eta, x, y] = line.split("\t");
    return { tag, title, reason, eta, x: Number(x), y: Number(y) };
  });
  const propBox = $("proposals");
  propBox.innerHTML = "";
  parsedProposals.forEach((p, idx) => {
    const div = document.createElement("div");
    div.className = idx === 0 ? "prop primary" : "prop";
    div.innerHTML = `
      <div class="prop-title"><span><span class="tag">[${p.tag}]</span>${p.title}</span><span>${p.eta}</span></div>
      <div class="prop-reason">${p.reason}</div>
      <div class="prop-foot">
        <span></span>
        <div class="prop-btns">
          <button type="button" class="jump">경로</button>
          <button type="button" class="accept">수락</button>
        </div>
      </div>`;
    div.addEventListener("mouseenter", () => {
      if (!playing) {
        wasm.w_preview_proposal(idx);
        draw();
      }
    });
    div.addEventListener("mouseleave", () => {
      if (!playing) {
        wasm.w_preview_proposal(-1);
        draw();
      }
    });
    div.querySelector(".jump").addEventListener("click", () => {
      wasm.w_preview_proposal(idx);
      setOverview(false, [p.x, p.y]);
    });
    div.querySelector(".accept").addEventListener("click", () => {
      if (playing) return;
      if (wasm.w_accept_proposal(idx)) {
        save.events.push(["p", idx]);
        persist();
        if (view.narrow) toggleSheet(false);
        draw();
      }
    });
    propBox.appendChild(div);
  });

  if (parsedProposals[0]) {
    $("sheet-preview").innerHTML = `<span class="tag">▸ [${parsedProposals[0].tag}]</span>${parsedProposals[0].title}`;
  }

  // 전선 사건 로그 렌더
  const evLines = (parts[4] ?? "").split("\n").filter(Boolean);
  const evBox = $("events");
  evBox.innerHTML = "";
  evLines.forEach((line) => {
    const [day, x, y, alert, text] = line.split("\t");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = alert === "1" ? "ev-item alert" : "ev-item";
    btn.innerHTML = `<span class="ev-day">${day}</span><span class="ev-text">${text}</span>`;
    btn.addEventListener("click", () => {
      if (view.narrow) toggleSheet(false);
      setOverview(false, [Number(x), Number(y)]);
    });
    evBox.appendChild(btn);
  });
}

function placeMenu() {
  const m = playing ? 0 : wasm.w_menu();
  const canGarrison = !!(m & 2);
  if (!m) {
    menu.hidden = true;
    $("mob-cmd").classList.remove("open");
    return;
  }
  if (view.narrow) {
    menu.hidden = true;
    $("mob-cmd").querySelector('[data-cmd="2"]').disabled = !canGarrison;
    $("mob-cmd").classList.add("open");
    return;
  }
  $("mob-cmd").classList.remove("open");
  menu.querySelector('[data-cmd="2"]').disabled = !canGarrison;
  menu.hidden = false;
  const r = canvas.getBoundingClientRect();
  const [dx, dy] = toDisplay((m >>> 8) & 0xff, (m >>> 16) & 0xff);
  const px = r.left + dx * view.cw - view.camX;
  const py = r.top + dy * view.ch - view.camY;
  let left = px + view.cw + 8;
  if (left + menu.offsetWidth > window.innerWidth - 8) left = px - menu.offsetWidth - 8;
  let top = py;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = window.innerHeight - menu.offsetHeight - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function giveCommand(kind) {
  if (playing || !wasm.w_command(kind)) return;
  save.events.push(["o", kind]);
  persist();
  draw();
}

for (const b of document.querySelectorAll("[data-cmd]")) {
  b.addEventListener("click", () => giveCommand(Number(b.dataset.cmd)));
}

function persist() {
  save.fp = wasm.w_fingerprint_lo();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {}
}

function noteTicks(done) {
  if (!done) return;
  const tail = save.events[save.events.length - 1];
  if (Array.isArray(tail) && tail[0] === "t") tail[1] += done;
  else save.events.push(["t", done]);
}

async function passDay() {
  if (playing || wasm.w_halted()) return;
  playing = true;
  const quick = stillness.matches;
  for (let left = wasm.w_ticks_left_today(); left > 0; left--) {
    const done = wasm.w_tick(1);
    noteTicks(done);
    if (!done) break;
    draw();
    if (!quick) await sleep(TICK_MS);
  }
  playing = false;
  persist();
  draw();
}

async function passUntilEvent() {
  if (playing || wasm.w_halted()) return;
  playing = true;
  const quick = stillness.matches;
  // 최대 10일(240틱)까지 진행하며 충돌/도착/주요 알림 시 정지
  for (let step = 0; step < 240; step++) {
    const done = wasm.w_tick(1);
    noteTicks(done);
    if (!done) break;
    draw();
    if (wasm.w_stop_reason() !== 0) break;
    if (!quick) await sleep(18);
  }
  playing = false;
  persist();
  draw();
}

function focusAndSelectSpecial() {
  if (playing) return;
  if (wasm.w_select_special()) {
    save.events.push(["s", 0]);
    persist();
  }
  const sp = wasm.w_special_pos();
  setOverview(false, [sp & 0xff, (sp >>> 8) & 0xff]);
}

function newGame(seed) {
  save = { v: SAVE_VERSION, seed, events: [] };
  wasm.w_init(seed);
  persist();
  const sp = wasm.w_special_pos();
  view.overview = false;
  layout();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff);
  draw();
}

function load(data) {
  if (!data || data.v !== SAVE_VERSION || !Number.isInteger(data.seed) || !Array.isArray(data.events)) {
    throw new Error("세이브 형식이 맞지 않음");
  }
  wasm.w_init(data.seed);
  for (const e of data.events) {
    if (!Array.isArray(e) || e.length !== 2) throw new Error("세이브 형식이 맞지 않음");
    if (e[0] === "t") wasm.w_tick(e[1] | 0);
    else if (e[0] === "o") wasm.w_command(e[1] | 0);
    else if (e[0] === "s") wasm.w_select_special();
    else if (e[0] === "p") wasm.w_accept_proposal(e[1] | 0);
    else wasm.w_click(e[0] | 0, e[1] | 0);
  }
  if (data.fp !== undefined && data.fp !== wasm.w_fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

function cellAtClient(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const dx = Math.floor((clientX - r.left + view.camX) / view.cw);
  const dy = Math.floor((clientY - r.top + view.camY) / view.ch);
  return toGame(dx, dy);
}

function showPop(gx, gy, clientX, clientY) {
  const len = wasm.w_inspect(gx, gy);
  if (!len) {
    pop.hidden = true;
    return false;
  }
  pop.textContent = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.w_popup_ptr(), len));
  pop.hidden = false;
  const left = Math.min(Math.max(clientX + 12, 8), window.innerWidth - pop.offsetWidth - 8);
  let top = clientY - pop.offsetHeight - 10;
  if (top < 8) top = clientY + 16;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  return true;
}

function hidePop() {
  pop.hidden = true;
}

// 포인터 입력: 드래그 팬, 핀치 줌, 클릭/탭 선택·조사
const pointers = new Map();
let dragState = null;
let pinchStartDist = 0;
let holdTimer = 0;

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  clearTimeout(holdTimer);
  if (pointers.size === 1) {
    dragState = { x: ev.clientX, y: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false };
    if (ev.pointerType !== "mouse") {
      holdTimer = setTimeout(() => {
        if (dragState && !dragState.moved) {
          const [gx, gy] = cellAtClient(ev.clientX, ev.clientY);
          showPop(gx, gy, ev.clientX, ev.clientY);
          dragState.held = true;
        }
      }, HOLD_MS);
    }
  } else if (pointers.size === 2) {
    dragState = null;
    const pts = [...pointers.values()];
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (pointers.has(ev.pointerId)) {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  }
  if (pointers.size === 2 && pinchStartDist > 0) {
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d < pinchStartDist * 0.78 && !view.overview) {
      pinchStartDist = d;
      setOverview(true);
    } else if (d > pinchStartDist * 1.25 && view.overview) {
      pinchStartDist = d;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      setOverview(false, cellAtClient(mx, my));
    }
    return;
  }
  if (dragState) {
    const dx = ev.clientX - dragState.x;
    const dy = ev.clientY - dragState.y;
    if (Math.hypot(ev.clientX - dragState.startX, ev.clientY - dragState.startY) > 6) {
      dragState.moved = true;
      clearTimeout(holdTimer);
      hidePop();
    }
    if (dragState.moved && !view.overview) {
      view.camX -= dx;
      view.camY -= dy;
      clampCam();
      draw();
    }
    dragState.x = ev.clientX;
    dragState.y = ev.clientY;
    return;
  }
  if (ev.pointerType === "mouse") {
    const [gx, gy] = cellAtClient(ev.clientX, ev.clientY);
    if (gx >= 0 && gy >= 0 && gx < W_COLS && gy < W_ROWS) {
      $("coords-hint").textContent = `${String.fromCharCode(65 + Math.floor(gx / 8))}${Math.floor(gy / 8) + 1} (${gx},${gy})`;
      if (!view.overview) showPop(gx, gy, ev.clientX, ev.clientY);
    } else {
      hidePop();
    }
  }
});

canvas.addEventListener("pointerup", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchStartDist = 0;
  const st = dragState;
  dragState = null;
  if (!st || st.moved || st.held || playing) {
    if (ev.pointerType !== "mouse") hidePop();
    return;
  }
  const [gx, gy] = cellAtClient(ev.clientX, ev.clientY);
  if (view.overview) {
    setOverview(false, [gx, gy]);
    return;
  }
  const changed = wasm.w_click(gx, gy);
  if (changed) {
    save.events.push([gx, gy]);
    persist();
    hidePop();
  } else {
    // 비선택 상태에서 다른 칸을 클릭하면 조사 팝업을 띄운다.
    showPop(gx, gy, ev.clientX, ev.clientY);
  }
  draw();
});

canvas.addEventListener("pointercancel", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  dragState = null;
  hidePop();
});
canvas.addEventListener("pointerleave", (ev) => {
  if (ev.pointerType === "mouse") hidePop();
});
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const focus = cellAtClient(ev.clientX, ev.clientY);
    if (ev.deltaY > 0) {
      if (!view.overview && view.zoomCw > 13) {
        view.zoomCw -= 2;
        layout();
        centerOn(focus[0], focus[1]);
        draw();
      } else {
        setOverview(true, focus);
      }
    } else if (ev.deltaY < 0) {
      if (view.overview) {
        setOverview(false, focus);
      } else if (view.zoomCw < 24) {
        view.zoomCw += 2;
        layout();
        centerOn(focus[0], focus[1]);
        draw();
      }
    }
  },
  { passive: false },
);

// 모바일 하단 시트 제어
function toggleSheet(open) {
  sheetOpen = open;
  $("side").classList.toggle("open", sheetOpen);
  $("sheet-arrow").textContent = sheetOpen ? "▼" : "▲";
  updateMobTabs();
  setTimeout(() => {
    layout();
    draw();
  }, 20);
}

function updateMobTabs() {
  for (const b of $("mob-tabs").querySelectorAll("[data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === activeMobTab);
  }
  for (const s of $("side").querySelectorAll("[data-sec]")) {
    s.classList.toggle("active", !view.narrow || s.dataset.sec === activeMobTab);
  }
}

$("sheet-bar").addEventListener("click", () => toggleSheet(!sheetOpen));
$("mob-close").addEventListener("click", () => toggleSheet(false));
for (const b of $("mob-tabs").querySelectorAll("[data-tab]")) {
  b.addEventListener("click", () => {
    activeMobTab = b.dataset.tab;
    updateMobTabs();
  });
}
$("mob-cmd-cancel").addEventListener("click", () => {
  const sp = wasm.w_special_pos();
  wasm.w_click(sp & 0xff, (sp >>> 8) & 0xff);
  draw();
});

$("btn-overview").addEventListener("click", () => setOverview(!view.overview));
$("fab-overview").addEventListener("click", () => setOverview(!view.overview));
$("btn-squad").addEventListener("click", focusAndSelectSpecial);
$("btn-select-sp").addEventListener("click", focusAndSelectSpecial);
$("fab-squad").addEventListener("click", focusAndSelectSpecial);
$("day").addEventListener("click", passDay);
$("until").addEventListener("click", passUntilEvent);
$("new").addEventListener("click", () => {
  if (!playing) newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
});

document.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLButtonElement && ev.code === "Space") return;
  const pick = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(ev.code);
  if (pick >= 0 && !menu.hidden) {
    ev.preventDefault();
    giveCommand(pick);
    return;
  }
  if (ev.code === "KeyM" || ev.code === "Tab") {
    ev.preventDefault();
    setOverview(!view.overview);
  } else if (ev.code === "KeyF") {
    ev.preventDefault();
    focusAndSelectSpecial();
  } else if (ev.code === "Space" || ev.code === "Enter") {
    ev.preventDefault();
    if (ev.shiftKey) passUntilEvent();
    else passDay();
  } else if (!view.overview) {
    const step = view.cw * 4;
    if (ev.code === "KeyW" || ev.code === "ArrowUp") { view.camY -= step; clampCam(); draw(); }
    else if (ev.code === "KeyS" || ev.code === "ArrowDown") { view.camY += step; clampCam(); draw(); }
    else if (ev.code === "KeyA" || ev.code === "ArrowLeft") { view.camX -= step; clampCam(); draw(); }
    else if (ev.code === "KeyD" || ev.code === "ArrowRight") { view.camX += step; clampCam(); draw(); }
  }
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    updateMobTabs();
    layout();
    draw();
  }, 100);
});

updateMobTabs();
layout();
try {
  load(JSON.parse(localStorage.getItem(SAVE_KEY)));
  const sp = wasm.w_special_pos();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff);
  draw();
} catch {
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
}
