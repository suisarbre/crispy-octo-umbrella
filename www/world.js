// 월드 화면. 그리기, 입력, 시간 넘기기, 세이브만 한다. 규칙은 전부 game.wasm 안에 있다.
// 전투 화면(main.js)과 겹치는 그리기 코드가 있다. 두 화면을 한 페이지로 합칠 때 같이 정리한다.

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f"];
const SAVE_KEY = "crispy-octo-umbrella/world";
const SAVE_VERSION = 1;
const FONT_PX = 18;
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const TEXT_REGIONS = ["clock", "force", "notice"];
/// 하루를 넘길 때 틱 하나를 보여주는 시간(ms). 하루가 1초쯤 걸린다.
const TICK_MS = 40;
const HOLD_MS = 350;

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;
const COLS = wasm.w_cols();
const ROWS = wasm.w_rows();

// 세이브는 (시드, 입력과 틱의 순서)다. 하루는 24틱이다. ["t", n]은 n틱이 흘렀다는 뜻, [x, y]는 그 칸을 눌렀다는 뜻.
let save = { v: SAVE_VERSION, seed: 0, events: [] };
let view = { rot: false, cols: COLS, rows: ROWS, cw: 16, ch: 20, font: FONT_PX };
// 하루가 재생되는 중인가. 그동안은 명령을 받지 않는다.
let playing = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function layout() {
  const narrow = window.innerWidth < 700;
  const rot = narrow && window.innerHeight > window.innerWidth;
  const cols = rot ? ROWS : COLS;
  const rows = rot ? COLS : ROWS;
  const pad = narrow ? 16 : 40;
  const avail = document.documentElement.clientWidth - pad;
  const cw = Math.max(8, Math.min(22, Math.floor(avail / cols)));
  const ch = cw + 2;
  const font = Math.min(FONT_PX, Math.floor(ch * 0.8));
  view = { rot, cols, rows, cw, ch, font };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cols * cw * dpr;
  canvas.height = rows * ch * dpr;
  canvas.style.width = `${cols * cw}px`;
  canvas.style.height = `${rows * ch}px`;
  // 본문 폭을 지도에 맞춘다. 아래 글자가 바뀌어도 지도가 옆으로 밀리지 않는다.
  document.querySelector("main").style.width = `${cols * cw}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 세로 화면에서는 지도를 90도 돌린다. 아군 본진(서쪽)이 아래로 온다.
const toDisplay = (gx, gy) => (view.rot ? [gy, COLS - 1 - gx] : [gx, gy]);
const toGame = (dx, dy) => (view.rot ? [COLS - 1 - dy, dx] : [dx, dy]);

function draw() {
  const frame = new Uint32Array(wasm.memory.buffer, wasm.w_frame_ptr(), COLS * ROWS);
  const { cw, ch } = view;
  ctx.font = `${view.font}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = frame[y * COLS + x];
      const glyph = c & 0x1fffff;
      const [dx, dy] = toDisplay(x, y);
      ctx.fillStyle = PALETTE[c >>> 28];
      ctx.fillRect(dx * cw, dy * ch, cw, ch);
      if (glyph === 0x20) continue;
      ctx.fillStyle = PALETTE[(c >>> 24) & 0xf];
      ctx.fillText(String.fromCodePoint(glyph), dx * cw + cw / 2, dy * ch + ch / 2 + 1);
    }
  }
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.w_text_ptr(), wasm.w_text_len());
  const parts = new TextDecoder().decode(bytes).split("\u001f");
  TEXT_REGIONS.forEach((id, i) => {
    const el = $(id);
    const next = parts[i] ?? "";
    if (el.textContent !== next) el.textContent = next;
  });
  $("seed").textContent = `시드 ${save.seed}`;
  $("day").disabled = playing || !!wasm.w_halted();
}

function persist() {
  save.fp = wasm.w_fingerprint_lo();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // 저장 공간을 못 쓰는 환경이면 저장 없이 간다.
  }
}

function noteTicks(done) {
  if (!done) return;
  const tail = save.events[save.events.length - 1];
  if (Array.isArray(tail) && tail[0] === "t") tail[1] += done;
  else save.events.push(["t", done]);
}

// 하루를 넘긴다. 양쪽이 동시에 움직이는 것을 틱 하나씩 보여준다. 충돌이 나면 거기서 멈춘다.
async function passDay() {
  if (playing || wasm.w_halted()) return;
  playing = true;
  const quick = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

function newGame(seed) {
  save = { v: SAVE_VERSION, seed, events: [] };
  wasm.w_init(seed);
  persist();
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
    else wasm.w_click(e[0] | 0, e[1] | 0);
  }
  if (data.fp !== undefined && data.fp !== wasm.w_fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

function cellAt(ev) {
  const r = canvas.getBoundingClientRect();
  const dx = Math.floor(((ev.clientX - r.left) / r.width) * view.cols);
  const dy = Math.floor(((ev.clientY - r.top) / r.height) * view.rows);
  return toGame(dx, dy);
}

// 칸 정보 창. 마우스는 올리면, 터치는 길게 누르면 뜬다.
const pop = $("pop");
let holdTimer = 0;
let holdStart = null;
let swallowClick = false;

function showPop(x, y) {
  const len = wasm.w_inspect(x, y);
  if (!len) {
    pop.hidden = true;
    return false;
  }
  pop.textContent = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.w_popup_ptr(), len));
  pop.hidden = false;
  const r = canvas.getBoundingClientRect();
  const [dx, dy] = toDisplay(x, y);
  const cellX = r.left + window.scrollX + ((dx + 0.5) * r.width) / view.cols;
  const cellY = r.top + window.scrollY + (dy * r.height) / view.rows;
  const left = Math.min(Math.max(cellX - pop.offsetWidth / 2, window.scrollX + 4), window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 4);
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
  swallowClick = false;
  if (ev.pointerType === "mouse") return;
  holdStart = [ev.clientX, ev.clientY];
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    const [x, y] = cellAt(ev);
    if (showPop(x, y)) swallowClick = true;
  }, HOLD_MS);
});
canvas.addEventListener("pointerup", (ev) => {
  if (ev.pointerType !== "mouse") hidePop();
});
canvas.addEventListener("pointercancel", hidePop);
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
canvas.addEventListener("pointermove", (ev) => {
  if (ev.pointerType !== "mouse") {
    if (holdStart && Math.hypot(ev.clientX - holdStart[0], ev.clientY - holdStart[1]) > 10) hidePop();
    return;
  }
  const [x, y] = cellAt(ev);
  showPop(x, y);
});
canvas.addEventListener("pointerleave", (ev) => {
  if (ev.pointerType === "mouse") hidePop();
});

// 월드의 명령은 언제든 다시 내릴 수 있어서 한 번 누르면 바로 들어간다.
canvas.addEventListener("click", (ev) => {
  if (swallowClick) {
    swallowClick = false;
    return;
  }
  if (playing) return;
  const [x, y] = cellAt(ev);
  if (wasm.w_click(x, y)) {
    save.events.push([x, y]);
    persist();
  }
  draw();
});

$("day").addEventListener("click", passDay);
$("new").addEventListener("click", () => {
  if (!playing) newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
});

document.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLButtonElement && ev.code === "Space") return;
  if (ev.code === "Space" || ev.code === "Enter") {
    ev.preventDefault();
    passDay();
  }
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layout();
    draw();
  }, 100);
});

layout();
try {
  load(JSON.parse(localStorage.getItem(SAVE_KEY)));
  draw();
} catch {
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
}
