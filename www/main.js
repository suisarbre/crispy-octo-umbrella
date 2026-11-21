// 그리기와 입력, 세이브만 한다. 규칙은 전부 game.wasm 안에 있다.

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f", "#37725e"];
const SAVE_KEY = "crispy-octo-umbrella/save";
const SAVE_VERSION = 1;
const FONT_PX = 20;
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

// game.wasm이 넘기는 문구 구역 순서: status, ledger, result, ability, roster.
const TEXT_REGIONS = ["status", "ledger", "result"];

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;
const COLS = wasm.cols();
const ROWS = wasm.rows();

ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
const BASE_W = Math.ceil(ctx.measureText("M").width) + 4;
const BASE_H = Math.ceil(FONT_PX * 1.3);
// 유닛이 아닌 글리프: 바닥, 엄폐물, 벽, 길 표시, 연막, 시체.
const TERRAIN = new Set([0xb7, 0x2584, 0x2588, 0x2022, 0x2248, 0xd7]);
const BROOD = 3;
/// 탭이 유닛 칸 중심에서 이만큼(칸 단위) 안이면 그 유닛을 누른 것으로 친다.
const SNAP = 0.95;

// 세이브는 (시드, 입력 목록)이다. 코어가 결정론적이라 다시 돌리면 같은 판이 나온다.
let save = { v: SAVE_VERSION, seed: 0, events: [] };
// 화면 배치. 좁은 세로 화면에서는 전장을 90도 돌려 칸을 키운다. 규칙 쪽 좌표는 그대로다.
let view = { rot: false, cols: COLS, rows: ROWS, cw: BASE_W, ch: BASE_H, font: FONT_PX };
// 터치에서는 첫 탭이 조준, 같은 칸을 한 번 더 누르면 실행이다. 게임 좌표.
let pending = null;
let lastPointer = "mouse";
// 코어가 계산을 끝낸 뒤 그 과정을 박자별로 보여주는 중인가. 그동안 입력은 건너뛰기로만 쓴다.
let playing = false;
let skipRequested = false;
const BEAT_HIT = 3;
const BEAT_KILL = 5;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// 맞았을 때 화면이 한 번 튄다.
function kick(kind) {
  if (reducedMotion.matches || !canvas.animate) return;
  const d = kind === BEAT_KILL ? 3 : 2;
  canvas.animate(
    [{ transform: `translate(${d}px, ${d - 1}px)` }, { transform: `translate(${-d + 1}px, -1px)` }, { transform: "none" }],
    { duration: kind === BEAT_KILL ? 140 : 90, easing: "ease-out" },
  );
}

async function play() {
  if (playing) return;
  playing = true;
  skipRequested = false;
  for (;;) {
    const beat = wasm.advance();
    if (!beat) break;
    const kind = beat >>> 16;
    draw();
    if (kind === BEAT_HIT || kind === BEAT_KILL) kick(kind);
    await sleep(beat & 0xffff);
    if (skipRequested) {
      wasm.skip();
      break;
    }
  }
  playing = false;
  draw();
}

/// 재생 중이면 건너뛰기를 걸고 true.
function skipIfPlaying() {
  if (playing) skipRequested = true;
  return playing;
}

function layout() {
  const narrow = window.innerWidth < 700;
  const rot = narrow && window.innerHeight > window.innerWidth;
  const cols = rot ? ROWS : COLS;
  const rows = rot ? COLS : ROWS;
  let cw = BASE_W;
  let ch = BASE_H;
  let font = FONT_PX;
  if (narrow) {
    const avail = document.documentElement.clientWidth - 16;
    cw = Math.min(28, Math.floor(avail / cols));
    ch = rot ? cw + 2 : Math.round((cw * BASE_H) / BASE_W);
    font = Math.min(22, Math.floor(Math.min(ch * 0.8, cw * 1.4)));
  }
  view = { rot, cols, rows, cw, ch, font };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cols * cw * dpr;
  canvas.height = rows * ch * dpr;
  canvas.style.width = `${cols * cw}px`;
  canvas.style.height = `${rows * ch}px`;
  // 본문 폭을 전장에 맞춘다. 아래 버튼이나 글자가 바뀌어도 전장이 옆으로 밀리지 않는다.
  document.querySelector("main").style.width = narrow ? "" : `${cols * cw}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const toDisplay = (gx, gy) => (view.rot ? [gy, COLS - 1 - gx] : [gx, gy]);
const toGame = (dx, dy) => (view.rot ? [COLS - 1 - dy, dx] : [dx, dy]);
const frameNow = () => new Uint32Array(wasm.memory.buffer, wasm.frame_ptr(), COLS * ROWS);

function draw() {
  const frame = frameNow();
  const { cw, ch } = view;
  ctx.font = `${view.font}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = frame[y * COLS + x];
      const glyph = c & 0x1fffff;
      const [dx, dy] = toDisplay(x, y);
      const px = dx * cw;
      const py = dy * ch;
      ctx.fillStyle = PALETTE[c >>> 28];
      ctx.fillRect(px, py, cw, ch);
      ctx.fillStyle = PALETTE[(c >>> 24) & 0xf];
      if (glyph === 0x2588) {
        ctx.fillRect(px, py, cw, ch);
      } else if (glyph === 0x2584) {
        ctx.fillRect(px + 2, py + ch / 2, cw - 4, ch / 2 - 2);
      } else {
        ctx.fillText(String.fromCodePoint(glyph), px + cw / 2, py + ch / 2 + 1);
      }
    }
  }
  if (pending) {
    const [dx, dy] = toDisplay(pending[0], pending[1]);
    ctx.strokeStyle = PALETTE[2];
    ctx.lineWidth = 1;
    ctx.strokeRect(dx * cw + 0.5, dy * ch + 0.5, cw - 1, ch - 1);
  }
  // 맞은 순간에는 깎인 체력을, 빗나간 순간에는 빗나감을 표적 위에 띄운다.
  const float = wasm.damage_float();
  if (float) {
    const [dx, dy] = toDisplay((float >>> 8) & 0xff, (float >>> 16) & 0xff);
    const label = float & (1 << 24) ? "빗나감!" : `−${float & 0xff}`;
    const row = dy > 0 ? dy - 1 : dy + 1;
    const w = Math.max(cw, ctx.measureText(label).width + 6);
    const left = Math.min(Math.max(dx * cw + cw / 2 - w / 2, 0), view.cols * cw - w);
    ctx.fillStyle = PALETTE[0];
    ctx.fillRect(left, row * ch, w, ch);
    ctx.fillStyle = PALETTE[2];
    ctx.fillText(label, left + w / 2, row * ch + ch / 2 + 1);
  }
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.text_ptr(), wasm.text_len());
  const parts = new TextDecoder().decode(bytes).split("\u001f");
  TEXT_REGIONS.forEach((id, i) => {
    const el = $(id);
    const next = parts[i] ?? "";
    if (el.textContent !== next) el.textContent = next;
  });
  // 네 번째 구역은 지금 쓸 수 있는 능력의 이름, 다섯 번째 구역은 분대원 목록이다.
  const ability = parts[3] ?? "";
  $("ability-name").textContent = ability;
  // 자리는 그대로 두고 감춘다. 버튼이 생겼다 없어질 때 화면이 밀리지 않게.
  $("ability").toggleAttribute("data-off", !ability);
  renderRoster(parts[4] ?? "");
  // 하단 바: 조준 중인 칸의 장부를 한 줄로.
  // 좁은 화면에서 잘려도 결과가 먼저 보이게 결과를 앞에 둔다.
  const aim = pending ? [parts[2] ?? "", ...(parts[1] ?? "").split("\n").slice(1), (parts[1] ?? "").split("\n")[0]].filter((t) => t && t !== "—").join("  ").replace(/ {3,}/g, " ") : "";
  $("aim").textContent = pending ? aim || "이동" : "";
  $("confirm").hidden = !pending;
  $("seed").textContent = `시드 ${save.seed}`;
}

const rosterModal = $("roster-modal");
let lastRosterRaw = "";
function renderRoster(raw) {
  if (raw === lastRosterRaw) return;
  lastRosterRaw = raw;
  const list = $("roster-list");
  list.innerHTML = "";
  for (const line of raw.split("\n").filter(Boolean)) {
    const [x, y, sel, glyph, name, pips, ap, tag] = line.split("\t");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = sel === "1" ? "roster-row selected" : "roster-row";
    btn.innerHTML = `<span class="roster-glyph">${glyph}</span><span>${name}</span><span class="roster-pips">${pips}</span><span class="roster-ap">${ap}</span><span class="roster-tag">${tag || ""}</span>`;
    btn.addEventListener("click", () => {
      rosterModal.hidden = true;
      if (skipIfPlaying()) return;
      clearPending();
      act(Number(x), Number(y));
      draw();
    });
    list.appendChild(btn);
  }
}

function persist() {
  save.fp = wasm.fingerprint_lo();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // 저장 공간을 못 쓰는 환경이면 파일 내보내기만 쓴다.
  }
}

function newGame(seed) {
  pending = null;
  skipRequested = true;
  save = { v: SAVE_VERSION, seed, events: [] };
  wasm.init(seed);
  persist();
  draw();
}

function load(data) {
  if (!data || data.v !== SAVE_VERSION || !Number.isInteger(data.seed) || !Array.isArray(data.events)) {
    throw new Error("세이브 형식이 맞지 않음");
  }
  wasm.init(data.seed);
  for (const e of data.events) {
    if (e === "e") wasm.end_turn();
    else if (e === "b") wasm.ability();
    else if (Array.isArray(e) && e.length === 2) wasm.click(e[0] | 0, e[1] | 0);
    else throw new Error("세이브 형식이 맞지 않음");
  }
  wasm.skip();
  if (data.fp !== undefined && data.fp !== wasm.fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

function fail(message) {
  $("err").textContent = message;
}

/// 탭 위치를 게임 좌표로. 터치면 근처 유닛에 붙인다.
function cellAt(ev, snap) {
  const r = canvas.getBoundingClientRect();
  const fx = ((ev.clientX - r.left) / r.width) * view.cols;
  const fy = ((ev.clientY - r.top) / r.height) * view.rows;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  if (!snap) return toGame(cx, cy);
  const frame = frameNow();
  const isUnit = (dx, dy) => {
    if (dx < 0 || dy < 0 || dx >= view.cols || dy >= view.rows) return false;
    const [gx, gy] = toGame(dx, dy);
    return !TERRAIN.has(frame[gy * COLS + gx] & 0x1fffff);
  };
  if (isUnit(cx, cy)) return toGame(cx, cy);
  let best = null;
  let bestD = SNAP;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!isUnit(cx + ox, cy + oy)) continue;
      const d = Math.hypot(fx - (cx + ox + 0.5), fy - (cy + oy + 0.5));
      if (d < bestD) {
        bestD = d;
        best = [cx + ox, cy + oy];
      }
    }
  }
  return best ? toGame(best[0], best[1]) : toGame(cx, cy);
}

function act(x, y) {
  if (wasm.click(x, y)) {
    save.events.push([x, y]);
    persist();
  }
  play();
}

function clearPending() {
  pending = null;
  wasm.hover(-1, -1);
}

function isOwnUnit(x, y) {
  const c = frameNow()[y * COLS + x];
  const fg = (c >>> 24) & 0xf;
  const bg = c >>> 28;
  return !TERRAIN.has(c & 0x1fffff) && (fg === BROOD || bg === BROOD || fg === 1);
}

function isReachable(x, y) {
  const c = frameNow()[y * COLS + x];
  const glyph = c & 0x1fffff;
  return (glyph === 0xb7 || glyph === 0x2022) && ((c >>> 24) & 0xf) === BROOD;
}

function isEnemyUnit(x, y) {
  return !TERRAIN.has(frameNow()[y * COLS + x] & 0x1fffff) && !isOwnUnit(x, y);
}

// 유닛 정보 창. 마우스는 올리면, 터치는 길게 누르면 뜬다.
const pop = $("pop");
const HOLD_MS = 350;
let holdTimer = 0;
let holdStart = null;
// 길게 눌러 창을 본 손가락을 뗄 때 생기는 클릭은 버린다.
let swallowClick = false;

function showPop(x, y) {
  const len = x >= 0 && y >= 0 && x < COLS && y < ROWS ? wasm.inspect(x, y) : 0;
  if (!len) {
    pop.hidden = true;
    return false;
  }
  pop.textContent = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.popup_ptr(), len));
  pop.hidden = false;
  const r = canvas.getBoundingClientRect();
  const [dx, dy] = toDisplay(x, y);
  const cellX = r.left + window.scrollX + ((dx + 0.5) * r.width) / view.cols;
  const cellY = r.top + window.scrollY + (dy * r.height) / view.rows;
  const left = Math.min(Math.max(cellX - pop.offsetWidth / 2, window.scrollX + 4), window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 4);
  // 손가락에 가리지 않게 위쪽에. 자리가 없으면 아래쪽에.
  let top = cellY - pop.offsetHeight - 8;
  if (top < window.scrollY + 4) top = cellY + r.height / view.rows + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  return true;
}

function hidePop() {
  clearTimeout(holdTimer);
  holdStart = null;
  pop.hidden = true;
}

canvas.addEventListener("pointerdown", (ev) => {
  lastPointer = ev.pointerType;
  swallowClick = false;
  if (ev.pointerType === "mouse") return;
  holdStart = [ev.clientX, ev.clientY];
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    const [x, y] = cellAt(ev, true);
    if (showPop(x, y)) swallowClick = true;
  }, HOLD_MS);
});

canvas.addEventListener("pointerup", (ev) => {
  if (ev.pointerType !== "mouse") hidePop();
});
canvas.addEventListener("pointercancel", hidePop);
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

canvas.addEventListener("click", (ev) => {
  if (swallowClick) {
    swallowClick = false;
    return;
  }
  if (skipIfPlaying()) return;
  if (lastPointer === "mouse") {
    const [x, y] = cellAt(ev, false);
    act(x, y);
    showPop(x, y);
    draw();
    return;
  }
  const [x, y] = cellAt(ev, true);
  if (pending && pending[0] === x && pending[1] === y) {
    clearPending();
    act(x, y);
  } else if (isOwnUnit(x, y)) {
    // 아군 선택은 되돌릴 게 없으니 바로.
    clearPending();
    act(x, y);
  } else if (isEnemyUnit(x, y) || isReachable(x, y)) {
    pending = [x, y];
    wasm.hover(x, y);
  } else {
    // 행동 범위 밖: 선택을 푼다.
    clearPending();
    act(x, y);
  }
  draw();
});

canvas.addEventListener("pointermove", (ev) => {
  if (ev.pointerType !== "mouse") {
    // 누른 채 손가락이 움직이면 길게 누르기가 아니다.
    if (holdStart && Math.hypot(ev.clientX - holdStart[0], ev.clientY - holdStart[1]) > 10) hidePop();
    return;
  }
  lastPointer = "mouse";
  const [x, y] = cellAt(ev, false);
  showPop(x, y);
  if (playing) return;
  wasm.hover(x, y);
  draw();
});

canvas.addEventListener("pointerleave", (ev) => {
  if (ev.pointerType !== "mouse") return;
  hidePop();
  if (playing) return;
  wasm.hover(-1, -1);
  draw();
});

$("confirm").addEventListener("click", () => {
  if (skipIfPlaying() || !pending) return;
  const [x, y] = pending;
  clearPending();
  act(x, y);
  draw();
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layout();
    draw();
  }, 100);
});

function endTurn() {
  if (skipIfPlaying()) return;
  clearPending();
  wasm.end_turn();
  save.events.push("e");
  persist();
  play();
}

function useAbility() {
  if ($("ability").hasAttribute("data-off") || skipIfPlaying()) return;
  clearPending();
  if (wasm.ability()) {
    save.events.push("b");
    persist();
  }
  play();
}

$("ability").addEventListener("click", useAbility);
$("end").addEventListener("click", endTurn);
$("end2").addEventListener("click", endTurn);
$("new").addEventListener("click", () => {
  fail("");
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
});

$("btn-roster").addEventListener("click", () => {
  rosterModal.hidden = !rosterModal.hidden;
});
$("roster-close").addEventListener("click", () => {
  rosterModal.hidden = true;
});
rosterModal.addEventListener("click", (ev) => {
  if (ev.target === rosterModal) rosterModal.hidden = true;
});

document.addEventListener("keydown", (ev) => {
  if (ev.code === "Tab") {
    ev.preventDefault();
    rosterModal.hidden = !rosterModal.hidden;
    return;
  }
  if (ev.code === "Escape" && !rosterModal.hidden) {
    rosterModal.hidden = true;
    return;
  }
  if (!rosterModal.hidden) return;
  if (ev.target instanceof HTMLButtonElement) return;
  if (ev.code === "Space" || ev.code === "Enter") {
    ev.preventDefault();
    endTurn();
  } else if (ev.code === "KeyB" && !$("ability").hasAttribute("data-off")) {
    useAbility();
  }
});

$("export").addEventListener("click", () => {
  persist();
  const url = URL.createObjectURL(new Blob([JSON.stringify(save)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `save-${save.seed}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const before = save;
  try {
    load(JSON.parse(await file.text()));
    fail("");
    persist();
  } catch (e) {
    load(before);
    fail(`불러오기 실패: ${e.message}`);
  }
  draw();
});

layout();
try {
  load(JSON.parse(localStorage.getItem(SAVE_KEY)));
  draw();
} catch {
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
}
