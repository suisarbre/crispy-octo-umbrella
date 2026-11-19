// 그리기와 입력, 세이브만 한다. 규칙은 전부 game.wasm 안에 있다.

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f"];
const SAVE_KEY = "crispy-octo-umbrella/save";
const SAVE_VERSION = 1;
const FONT_PX = 20;
const FONT = `${FONT_PX}px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;
const COLS = wasm.cols();
const ROWS = wasm.rows();

ctx.font = FONT;
const CELL_W = Math.ceil(ctx.measureText("M").width) + 4;
const CELL_H = Math.ceil(FONT_PX * 1.3);
const dpr = window.devicePixelRatio || 1;
canvas.width = COLS * CELL_W * dpr;
canvas.height = ROWS * CELL_H * dpr;
canvas.style.width = `${COLS * CELL_W}px`;
ctx.scale(dpr, dpr);

// 세이브는 (시드, 입력 목록)이다. 코어가 결정론적이라 다시 돌리면 같은 판이 나온다.
let save = { v: SAVE_VERSION, seed: 0, events: [] };

function draw() {
  const frame = new Uint32Array(wasm.memory.buffer, wasm.frame_ptr(), COLS * ROWS);
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = frame[y * COLS + x];
      const glyph = c & 0x1fffff;
      const px = x * CELL_W;
      const py = y * CELL_H;
      ctx.fillStyle = PALETTE[c >>> 28];
      ctx.fillRect(px, py, CELL_W, CELL_H);
      ctx.fillStyle = PALETTE[(c >>> 24) & 0xf];
      if (glyph === 0x2588) {
        ctx.fillRect(px, py, CELL_W, CELL_H);
      } else if (glyph === 0x2584) {
        ctx.fillRect(px + 2, py + CELL_H / 2, CELL_W - 4, CELL_H / 2 - 2);
      } else {
        ctx.fillText(String.fromCodePoint(glyph), px + CELL_W / 2, py + CELL_H / 2 + 1);
      }
    }
  }
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.text_ptr(), wasm.text_len());
  $("text").textContent = new TextDecoder().decode(bytes);
  $("seed").textContent = `시드 ${save.seed}`;
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
    else if (Array.isArray(e) && e.length === 2) wasm.click(e[0] | 0, e[1] | 0);
    else throw new Error("세이브 형식이 맞지 않음");
  }
  if (data.fp !== undefined && data.fp !== wasm.fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

function fail(message) {
  $("err").textContent = message;
}

function cellAt(ev) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - r.left) / r.width) * COLS);
  const y = Math.floor(((ev.clientY - r.top) / r.height) * ROWS);
  return [x, y];
}

canvas.addEventListener("click", (ev) => {
  const [x, y] = cellAt(ev);
  if (wasm.click(x, y)) {
    save.events.push([x, y]);
    persist();
  }
  draw();
});

canvas.addEventListener("mousemove", (ev) => {
  const [x, y] = cellAt(ev);
  wasm.hover(x, y);
  draw();
});

canvas.addEventListener("mouseleave", () => {
  wasm.hover(-1, -1);
  draw();
});

function endTurn() {
  wasm.end_turn();
  save.events.push("e");
  persist();
  draw();
}

$("end").addEventListener("click", endTurn);
$("new").addEventListener("click", () => {
  fail("");
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
});

document.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLButtonElement) return;
  if (ev.code === "Space" || ev.code === "Enter") {
    ev.preventDefault();
    endTurn();
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

try {
  load(JSON.parse(localStorage.getItem(SAVE_KEY)));
  draw();
} catch {
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
}
