// 월드 화면. 그리기, 입력, 시간 넘기기, 세이브만 한다. 규칙은 전부 game.wasm 안에 있다.
// 전투 화면(main.js)과 겹치는 그리기 코드가 있다. 두 화면을 한 페이지로 합칠 때 같이 정리한다.

// 여섯 번째는 아군 색을 바탕에 반쯤 섞은 것이다. 고르지 않은 부대의 길에만 쓴다.
const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f", "#37725e"];
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

// 세이브는 (시드, 입력과 틱의 순서)다. 하루는 24틱이다.
// ["t", n]은 n틱이 흘렀다는 뜻, [x, y]는 그 칸을 눌렀다는 뜻, ["o", k]는 k번 명령을 골랐다는 뜻.
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
  drawPulses(frame);
  drawLabels();
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.w_text_ptr(), wasm.w_text_len());
  const parts = new TextDecoder().decode(bytes).split("\u001f");
  TEXT_REGIONS.forEach((id, i) => {
    const el = $(id);
    const next = parts[i] ?? "";
    if (el.textContent !== next) el.textContent = next;
  });
  $("seed").textContent = `시드 ${save.seed}`;
  $("day").disabled = playing || !!wasm.w_halted();
  placeMenu();
}

// 명령 고르기. 부대를 고르고 칸을 찍으면 그 칸 옆에 뜬다. 고르기 전까지는 아무 일도 일어나지 않는다.
const menu = $("menu");

function placeMenu() {
  const m = playing ? 0 : wasm.w_menu();
  if (!m) {
    menu.hidden = true;
    return;
  }
  menu.querySelector('[data-cmd="2"]').disabled = !(m & 2);
  menu.hidden = false;
  const r = canvas.getBoundingClientRect();
  const [dx, dy] = toDisplay((m >>> 8) & 0xff, (m >>> 16) & 0xff);
  const cellW = r.width / view.cols;
  const cellH = r.height / view.rows;
  const pageRight = window.scrollX + document.documentElement.clientWidth;
  // 찍은 칸의 오른쪽에. 자리가 없으면 왼쪽에. 화면 밖으로 나가지 않게 당긴다.
  let left = r.left + window.scrollX + (dx + 1) * cellW + 6;
  if (left + menu.offsetWidth > pageRight - 4) left = r.left + window.scrollX + dx * cellW - menu.offsetWidth - 6;
  let top = r.top + window.scrollY + dy * cellH;
  const pageBottom = window.scrollY + window.innerHeight;
  if (top + menu.offsetHeight > pageBottom - 4) top = pageBottom - menu.offsetHeight - 4;
  menu.style.left = `${Math.max(left, window.scrollX + 4)}px`;
  menu.style.top = `${Math.max(top, window.scrollY + 4)}px`;
}

function giveCommand(kind) {
  if (playing || !wasm.w_command(kind)) return;
  save.events.push(["o", kind]);
  persist();
  draw();
}

for (const b of menu.querySelectorAll("[data-cmd]")) {
  b.addEventListener("click", () => giveCommand(Number(b.dataset.cmd)));
}

// 가는 방향을 보여주는 빛. 부대에서 출발해 길을 따라 한 칸씩 흘러간다. 빠른 부대의 빛이 더 빨리 흐른다.
// 길이 겹쳐도 빛은 부대마다 따로 흐르므로 누가 어느 쪽으로 가는지 가려진다.
const PULSE_MS_PER_TICK = 18;
/// 한 번 흐른 뒤 다시 출발하기까지 쉬는 칸 수.
const PULSE_REST = 5;
const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");

function drawPulses(frame) {
  const len = wasm.w_routes_len();
  if (!len || stillness.matches) return;
  const routes = new Uint32Array(wasm.memory.buffer, wasm.w_routes_ptr(), len);
  const { cw, ch } = view;
  const now = performance.now();
  for (let i = 0, k = 0; i < len; k++) {
    const head = routes[i];
    const n = head & 0xffff;
    const selected = !!(head & (1 << 16));
    const interval = (head >>> 20) * PULSE_MS_PER_TICK;
    // 길마다 출발 시각을 조금씩 어긋나게 해서 겹친 길의 빛이 한 덩어리로 보이지 않게 한다.
    const at = Math.floor(((now + k * 310) % ((n + PULSE_REST) * interval)) / interval);
    if (at < n) {
      const cell = routes[i + 1 + at];
      const [x, y] = [cell & 0xff, (cell >>> 8) & 0xff];
      const glyph = frame[y * COLS + x] & 0x1fffff;
      // 부대나 거점 위는 건너뛴다.
      if (glyph === 0x2022 || glyph === 0x25c7) {
        const [dx, dy] = toDisplay(x, y);
        ctx.fillStyle = PALETTE[0];
        ctx.fillRect(dx * cw, dy * ch, cw, ch);
        ctx.fillStyle = PALETTE[selected ? 2 : 3];
        ctx.fillText(String.fromCodePoint(glyph), dx * cw + cw / 2, dy * ch + ch / 2 + 1);
      }
    }
    i += 1 + n;
  }
}

// 움직이는 부대가 있는 동안에만 빛을 흘린다. 하루가 재생되는 중에는 재생이 화면을 그린다.
setInterval(() => {
  if (!playing && !stillness.matches && !document.hidden && wasm.w_routes_len()) draw();
}, 60);

// 부대 위에 인원을 적는다. 한 칸에 여러 부대가 있으면 위에서 아래로 쌓는다. 고른 부대는 뒤집어 칠한다.
function drawLabels() {
  const labels = new Uint32Array(wasm.memory.buffer, wasm.w_labels_ptr(), wasm.w_labels_len());
  const { cw, ch } = view;
  const size = Math.max(10, Math.round(view.font * 0.72));
  const line = size + 2;
  ctx.font = `${size}px ${FONT_FAMILY}`;
  // 표시가 옆 칸의 다른 부대를 덮지 않게, 부대가 선 칸들을 먼저 적어 둔다.
  const taken = new Set();
  for (const l of labels) taken.add(toDisplay(l & 0xff, (l >>> 8) & 0xff).join());
  for (let i = 0; i < labels.length; ) {
    // 같은 칸의 표시는 연달아 온다.
    let n = 1;
    while (i + n < labels.length && (labels[i + n] & 0xffff) === (labels[i] & 0xffff)) n++;
    const [dx, dy] = toDisplay(labels[i] & 0xff, (labels[i] >>> 8) & 0xff);
    let cx = dx * cw + cw / 2;
    // 부대 바로 위에 쌓는다. 위에 다른 부대가 있거나 자리가 없으면 아래에, 아래도 막혔으면 오른쪽에.
    let top = dy * ch - n * line;
    if (top < 0 || taken.has([dx, dy - 1].join())) {
      top = (dy + 1) * ch;
      if (taken.has([dx, dy + 1].join()) || top + n * line > view.rows * ch) {
        top = dy * ch + ch / 2 - (n * line) / 2;
        cx = (dx + 1) * cw + line / 2;
      }
    }
    for (let k = 0; k < n; k++) {
      const l = labels[i + k];
      const text = String((l >>> 16) & 0xfff);
      const color = PALETTE[l & (1 << 28) ? 4 : 3];
      const selected = !!(l & (1 << 29));
      const w = Math.max(line, ctx.measureText(text).width + 4);
      const x = Math.min(Math.max(cx - w / 2, 0), view.cols * cw - w);
      const y = top + k * line;
      ctx.fillStyle = selected ? color : PALETTE[0];
      ctx.fillRect(x, y, w, line);
      ctx.fillStyle = selected ? PALETTE[0] : color;
      ctx.fillText(text, x + w / 2, y + line / 2 + 1);
    }
    i += n;
  }
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
    else if (e[0] === "o") wasm.w_command(e[1] | 0);
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
  const pick = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(ev.code);
  if (pick >= 0 && !menu.hidden) {
    ev.preventDefault();
    giveCommand(pick);
  } else if (ev.code === "Space" || ev.code === "Enter") {
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
