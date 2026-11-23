// 80×52 육각(Hex) 월드 + 통합 전술 전투 화면.
// 문명식 육각 지형·영토 경계·도로망(스크롤/다단계 줌/전체 보기/모바일 90도 회전),
// 지휘망 1+2 제안, 보급권 정비/개조, 충돌 시 실제 전술 전투 진입과 복귀를 담당한다.

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f", "#37725e"];
const SAVE_KEY = "crispy-octo-umbrella/world-hex-v1";
const SAVE_VERSION = 4;
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const TICK_MS = 35;
const HOLD_MS = 350;
const PULSE_MS_PER_TICK = 18;
const PULSE_REST = 4;
const SQRT3 = Math.sqrt(3);

// 거점 글리프 테이블 (SiteKind::code 1..=10)
const SITE_GLYPH = ["", "◉", "◉", "◎", "◌", "○", "◈", "△", "▣", "┴", "⊞"];
// 지형 글리프 테이블 (Terrain::code 0..=4)
const TERRAIN_GLYPH = ["·", "∴", "△", "▲", ""];
// 부대 마커 (1: 특수부대, 2: 매복, 3: 정찰, 4: 아군AI, 5: 제국, 6: 충돌)
const FORCE_GLYPH = ["", "◆", "∩", "◇", "▪", "◆", "×"];

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");
const canvasBox = $("canvas-box");
const menu = $("menu");
const pop = $("pop");
const refitModal = $("refit-modal");
const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;
const W_COLS = wasm.w_cols();
const W_ROWS = wasm.w_rows();
const B_COLS = wasm.cols();
const B_ROWS = wasm.rows();

let save = { v: SAVE_VERSION, seed: 0, events: [] };
let playing = false;
let inBattle = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 헥스 카메라 및 뷰 상태
let view = {
  narrow: false,
  rot: false,
  overview: false,
  cssW: 800,
  cssH: 500,
  R: 20,        // 현재 헥스 반지름(px)
  zoomR: 20,    // 전술 뷰 반지름(px, 11..34)
  worldW: 0,    // 회전 전 전체 지도 폭
  worldH: 0,    // 회전 전 전체 지도 높이
  dispW: 0,     // 회전 후 전체 지도 폭
  dispH: 0,     // 회전 후 전체 지도 높이
  camX: 0,
  camY: 0,
};

let parsedProposals = [];
let activeMobTab = "prop";
let sheetOpen = false;

// 반지름 R 기준 헥스 중심 좌표(회전 전)
function hexCenterRaw(q, r, R = view.R) {
  return [R * 1.5 * q + R, R * SQRT3 * (r + (q & 1) * 0.5) + (R * SQRT3) / 2];
}

// 화면 디스플레이 공간 좌표(90도 회전 반영, 카메라 오프셋 미적용)
function hexCenterDisp(q, r) {
  const [gx, gy] = hexCenterRaw(q, r);
  return view.rot ? [gy, view.worldW - gx] : [gx, gy];
}

// 현재 뷰에서 헥스 6개 꼭짓점의 중심 대비 오프셋 (인덱스 0..5, 시계 방향)
function hexVertsOffset(R = view.R) {
  const h = (R * SQRT3) / 2;
  const raw = [
    [R, 0],
    [R * 0.5, h],
    [-R * 0.5, h],
    [-R, 0],
    [-R * 0.5, -h],
    [R * 0.5, -h],
  ];
  return view.rot ? raw.map(([vx, vy]) => [vy, -vx]) : raw;
}

// 픽셀 좌표(clientX, clientY) -> 정확한 odd-q 헥스 (q, r)
function hexAtClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const dispX = clientX - rect.left + view.camX;
  const dispY = clientY - rect.top + view.camY;
  const gx = view.rot ? view.worldW - dispY : dispX;
  const gy = view.rot ? dispX : dispY;
  const R = view.R;
  const px = gx - R;
  const py = gy - (R * SQRT3) / 2;
  const qf = ((2 / 3) * px) / R;
  const rf = ((-1 / 3) * px + (SQRT3 / 3) * py) / R;
  const sf = -qf - rf;
  let rq = Math.round(qf);
  let rr = Math.round(rf);
  const rs = Math.round(sf);
  const dq = Math.abs(rq - qf);
  const dr = Math.abs(rr - rf);
  const ds = Math.abs(rs - sf);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  const q = rq;
  const r = rr + ((rq - (rq & 1)) >> 1);
  return [q, r];
}

function clampCam() {
  if (view.dispW <= view.cssW) view.camX = -(view.cssW - view.dispW) / 2;
  else view.camX = Math.max(0, Math.min(view.camX, view.dispW - view.cssW));
  if (view.dispH <= view.cssH) view.camY = -(view.cssH - view.dispH) / 2;
  else view.camY = Math.max(0, Math.min(view.camY, view.dispH - view.cssH));
}

function centerOn(q, r) {
  const [dx, dy] = hexCenterDisp(q, r);
  view.camX = dx - view.cssW / 2;
  view.camY = dy - view.cssH / 2;
  clampCam();
}

function layout() {
  if (inBattle) {
    battleLayout();
    return;
  }
  view.narrow = window.innerWidth < 700;
  view.rot = view.narrow && window.innerHeight > window.innerWidth;
  const rect = canvasBox.getBoundingClientRect();
  view.cssW = Math.max(200, Math.floor(rect.width));
  view.cssH = Math.max(200, Math.floor(rect.height));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(view.cssW * dpr);
  canvas.height = Math.floor(view.cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // R=1 기준 전체 헥스 맵 치수
  const unitW = 1.5 * (W_COLS - 1) + 2;
  const unitH = SQRT3 * (W_ROWS + 0.5);
  const dispUnitW = view.rot ? unitH : unitW;
  const dispUnitH = view.rot ? unitW : unitH;

  if (view.overview) {
    view.R = Math.max(2.5, Math.min((view.cssW - 12) / dispUnitW, (view.cssH - 12) / dispUnitH));
  } else {
    view.R = view.zoomR;
  }
  view.worldW = unitW * view.R;
  view.worldH = unitH * view.R;
  view.dispW = view.rot ? view.worldH : view.worldW;
  view.dispH = view.rot ? view.worldW : view.worldH;
  clampCam();
  updateModeUI();
}

function setOverview(on, focusHex) {
  if (view.overview === on && !focusHex) return;
  let focus = focusHex;
  if (!focus) {
    const rect = canvas.getBoundingClientRect();
    focus = hexAtClient(rect.left + view.cssW / 2, rect.top + view.cssH / 2);
  }
  view.overview = on;
  layout();
  if (!on && focus) centerOn(focus[0], focus[1]);
  draw();
}

function updateModeUI() {
  const modeEl = $("view-mode");
  if (view.overview) {
    modeEl.innerHTML = "<strong>전구 전체 보기 (80×52 헥스)</strong> · 클릭/휠로 확대 · 1/2/3: 지휘망 제안";
  } else {
    modeEl.innerHTML = "<strong>전술 헥스 뷰</strong> · 드래그/WASD 이동 · 휠 줌 · 특수부대 클릭 후 명령";
  }
  $("btn-overview").style.borderColor = view.overview ? "var(--brood)" : "";
  $("btn-overview").style.color = view.overview ? "var(--brood)" : "";
  $("fab-overview").classList.toggle("active", view.overview);
  $("fab-overview").textContent = view.overview ? "전술" : "전체";
}

function drawHexPath(cx, cy, verts) {
  ctx.beginPath();
  ctx.moveTo(cx + verts[0][0], cy + verts[0][1]);
  for (let i = 1; i < 6; i++) ctx.lineTo(cx + verts[i][0], cy + verts[i][1]);
  ctx.closePath();
}

function draw() {
  if (inBattle) {
    battleDraw();
    return;
  }
  const hexes = new Uint32Array(wasm.memory.buffer, wasm.w_hex_ptr(), W_COLS * W_ROWS);
  const { R, camX, camY, cssW, cssH, overview } = view;
  const verts = hexVertsOffset(R);

  ctx.fillStyle = "#080a0c";
  ctx.fillRect(0, 0, cssW, cssH);

  // 가시 영역 헥스 바운딩 계산
  let qMin = 0, qMax = W_COLS - 1, rMin = 0, rMax = W_ROWS - 1;
  if (!overview) {
    const pad = R * 2.5;
    if (!view.rot) {
      qMin = Math.max(0, Math.floor((camX - pad) / (1.5 * R)));
      qMax = Math.min(W_COLS - 1, Math.ceil((camX + cssW + pad) / (1.5 * R)));
      rMin = Math.max(0, Math.floor((camY - pad) / (SQRT3 * R)) - 1);
      rMax = Math.min(W_ROWS - 1, Math.ceil((camY + cssH + pad) / (SQRT3 * R)) + 1);
    } else {
      const gxMin = view.worldW - (camY + cssH + pad);
      const gxMax = view.worldW - (camY - pad);
      const gyMin = camX - pad;
      const gyMax = camX + cssW + pad;
      qMin = Math.max(0, Math.floor(gxMin / (1.5 * R)) - 1);
      qMax = Math.min(W_COLS - 1, Math.ceil(gxMax / (1.5 * R)) + 1);
      rMin = Math.max(0, Math.floor(gyMin / (SQRT3 * R)) - 1);
      rMax = Math.min(W_ROWS - 1, Math.ceil(gyMax / (SQRT3 * R)) + 1);
    }
  }

  // 패스 1: 헥스 바탕(지형·영토 색조) + 얇은 육각 그리드
  ctx.lineWidth = overview ? 0.5 : 1;
  for (let r = rMin; r <= rMax; r++) {
    for (let q = qMin; q <= qMax; q++) {
      const h = hexes[r * W_COLS + q];
      const terr = h & 0x7;
      if (terr === 4) continue; // 불모 해역은 어두운 배경 그대로

      const [dx, dy] = hexCenterDisp(q, r);
      const cx = dx - camX;
      const cy = dy - camY;
      if (cx < -R * 1.5 || cx > cssW + R * 1.5 || cy < -R * 1.5 || cy > cssH + R * 1.5) continue;

      const owner = (h >>> 4) & 0x3;
      const inSup = !!(h & (1 << 12));
      const selected = !!(h & (1 << 28));
      const isTarget = !!(h & (1 << 29));

      drawHexPath(cx, cy, verts);
      if (terr === 3) {
        ctx.fillStyle = "#161d21";
      } else if (owner === 1) {
        ctx.fillStyle = "#12231e"; // 아군 영토
      } else if (owner === 2) {
        ctx.fillStyle = "#221610"; // 제국 영토
      } else if (terr === 1) {
        ctx.fillStyle = "#0e1514"; // 숲
      } else if (terr === 2) {
        ctx.fillStyle = "#131719"; // 고지
      } else {
        ctx.fillStyle = "#0c0f11"; // 평지
      }
      ctx.fill();

      if (!overview) {
        ctx.strokeStyle = selected || isTarget ? PALETTE[3] : inSup ? "#213630" : "#1a2327";
        ctx.stroke();
      }
    }
  }

  // 패스 2: Civ식 영토 외곽 경계선 (border_mask)
  ctx.lineCap = "round";
  ctx.lineWidth = overview ? 1.6 : 2.2;
  for (let r = rMin; r <= rMax; r++) {
    for (let q = qMin; q <= qMax; q++) {
      const h = hexes[r * W_COLS + q];
      const bmask = (h >>> 19) & 0x3f;
      if (!bmask) continue;
      const owner = (h >>> 4) & 0x3;
      const [dx, dy] = hexCenterDisp(q, r);
      const cx = dx - camX;
      const cy = dy - camY;
      ctx.strokeStyle = owner === 1 ? PALETTE[5] : PALETTE[4];
      ctx.beginPath();
      for (let d = 0; d < 6; d++) {
        if (!(bmask & (1 << d))) continue;
        const v1 = verts[(d + 5) % 6];
        const v2 = verts[d];
        ctx.moveTo(cx + v1[0], cy + v1[1]);
        ctx.lineTo(cx + v2[0], cy + v2[1]);
      }
      ctx.stroke();
    }
  }

  // 패스 3: 전략 도로망 (도로 헥스 중심 ↔ 인접 도로 헥스 변 중점)
  ctx.strokeStyle = overview ? "#4c5d63" : "#51636a";
  ctx.lineWidth = overview ? 1.1 : Math.max(1.8, R * 0.12);
  ctx.beginPath();
  for (let r = rMin; r <= rMax; r++) {
    for (let q = qMin; q <= qMax; q++) {
      const h = hexes[r * W_COLS + q];
      if (!(h & 0x8)) continue;
      const rmask = (h >>> 13) & 0x3f;
      const [dx, dy] = hexCenterDisp(q, r);
      const cx = dx - camX;
      const cy = dy - camY;
      for (let d = 0; d < 6; d++) {
        if (!(rmask & (1 << d))) continue;
        const v1 = verts[(d + 5) % 6];
        const v2 = verts[d];
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (v1[0] + v2[0]) * 0.5, cy + (v1[1] + v2[1]) * 0.5);
      }
    }
  }
  ctx.stroke();

  // 패스 4: 이동 경로 & 흐르는 빛 펄스 & 하루 경계 눈금
  drawRoutes();

  // 패스 5: 지형 기호, 거점 시설, 부대 마커
  const glyphFont = Math.max(9, Math.round(R * 0.85));
  ctx.font = `${glyphFont}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let r = rMin; r <= rMax; r++) {
    for (let q = qMin; q <= qMax; q++) {
      const h = hexes[r * W_COLS + q];
      const terr = h & 0x7;
      if (terr === 4) continue;
      const skind = (h >>> 6) & 0xf;
      const sowner = (h >>> 10) & 0x3;
      const fmark = (h >>> 25) & 0x7;
      const selected = !!(h & (1 << 28));
      const isTarget = !!(h & (1 << 29));

      const [dx, dy] = hexCenterDisp(q, r);
      const cx = dx - camX;
      const cy = dy - camY;

      if (overview) {
        // 전체 보기: 거점·부대·산맥만 깔끔하게 점/기호 표시
        if (fmark === 6) {
          ctx.fillStyle = PALETTE[4];
          ctx.fillRect(cx - 4, cy - 4, 8, 8);
        } else if (fmark >= 1 && fmark <= 3) {
          ctx.fillStyle = PALETTE[3];
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(3.5, R * 0.8), 0, Math.PI * 2);
          ctx.fill();
        } else if (skind > 0) {
          ctx.fillStyle = sowner === 1 ? PALETTE[3] : sowner === 2 ? PALETTE[4] : PALETTE[2];
          const rad = skind <= 2 ? Math.max(3.5, R * 0.75) : Math.max(2, R * 0.45);
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fill();
        } else if (fmark === 5) {
          ctx.fillStyle = PALETTE[4];
          ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
        }
        continue;
      }

      // 전술 헥스 뷰
      if (selected || isTarget) {
        drawHexPath(cx, cy, verts);
        ctx.fillStyle = PALETTE[3];
        ctx.fill();
      }

      if (fmark === 6) {
        // 충돌 강조
        ctx.fillStyle = PALETTE[4];
        drawHexPath(cx, cy, verts);
        ctx.fill();
        ctx.fillStyle = PALETTE[0];
        ctx.fillText("×", cx, cy + 1);
      } else if (skind > 0) {
        // 거점 공존: 거점 글리프를 유지한 채 색/반전으로 점유·특수부대 표시
        const g = SITE_GLYPH[skind];
        if (selected || isTarget) ctx.fillStyle = PALETTE[0];
        else if (fmark >= 1 && fmark <= 3) ctx.fillStyle = PALETTE[3];
        else if (sowner === 1) ctx.fillStyle = PALETTE[3];
        else if (sowner === 2) ctx.fillStyle = PALETTE[4];
        else ctx.fillStyle = PALETTE[2];
        ctx.fillText(g, cx, cy + 1);
      } else if (fmark > 0) {
        const g = FORCE_GLYPH[fmark];
        if (selected || isTarget) ctx.fillStyle = PALETTE[0];
        else if (fmark <= 3) ctx.fillStyle = PALETTE[3];
        else if (fmark === 4) ctx.fillStyle = PALETTE[5];
        else ctx.fillStyle = PALETTE[4];
        ctx.fillText(g, cx, cy + 1);
      } else {
        const tg = TERRAIN_GLYPH[terr];
        if (tg) {
          ctx.fillStyle = terr === 3 ? "#4b5a61" : PALETTE[1];
          ctx.fillText(tg, cx, cy + 1);
        }
      }
    }
  }

  if (!overview) {
    drawLabels();
    drawSectorCoords();
  } else {
    drawOverviewOverlays();
  }

  syncTextAndPanels();
  placeMenu();
}

function drawRoutes() {
  const len = wasm.w_routes_len();
  if (!len) return;
  const routes = new Uint32Array(wasm.memory.buffer, wasm.w_routes_ptr(), len);
  const { R, camX, camY, overview } = view;
  const now = performance.now();

  for (let i = 0, k = 0; i < len; k++) {
    const head = routes[i];
    const n = head & 0xffff;
    const isSpecial = !!(head & (1 << 16));
    const isPreview = !!(head & (1 << 17));
    const avgTicks = Math.max(2, head >>> 20);
    const bright = isSpecial || isPreview;

    // 경로 폴리라인 (출발 헥스 포함 n+1개)
    ctx.strokeStyle = bright ? PALETTE[3] : PALETTE[5];
    ctx.lineWidth = overview ? (bright ? 2 : 1) : (bright ? Math.max(2.5, R * 0.16) : Math.max(1.5, R * 0.1));
    ctx.setLineDash(isPreview ? [5, 4] : []);
    ctx.beginPath();
    for (let s = 0; s <= n; s++) {
      const node = routes[i + 1 + s];
      const [dx, dy] = hexCenterDisp(node & 0xff, (node >>> 8) & 0xff);
      const px = dx - camX;
      const py = dy - camY;
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 흐르는 방향 빛 펄스 (실제 이동 중인 경로만)
    if (!isPreview && !stillness.matches && n > 0) {
      const interval = avgTicks * PULSE_MS_PER_TICK;
      const at = Math.floor(((now + k * 290) % ((n + PULSE_REST) * interval)) / interval);
      if (at < n) {
        const node = routes[i + 2 + at];
        const [dx, dy] = hexCenterDisp(node & 0xff, (node >>> 8) & 0xff);
        ctx.fillStyle = isSpecial ? PALETTE[2] : PALETTE[3];
        ctx.beginPath();
        ctx.arc(dx - camX, dy - camY, overview ? 2.5 : Math.max(3.5, R * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 하루 경계 눈금(1, 2, 3...) — 전술 뷰에서 특수부대/미리보기 경로에 표시
    if (!overview && bright) {
      ctx.font = `10px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let s = 1; s <= n; s++) {
        const node = routes[i + 1 + s];
        const mark = (node >>> 16) & 0xff;
        if (!mark) continue;
        const [dx, dy] = hexCenterDisp(node & 0xff, (node >>> 8) & 0xff);
        const px = dx - camX;
        const py = dy - camY;
        ctx.fillStyle = PALETTE[3];
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = PALETTE[0];
        ctx.fillText(String(mark), px, py + 0.5);
      }
    }

    i += 2 + n;
  }
}

setInterval(() => {
  if (!inBattle && !playing && !stillness.matches && !document.hidden && wasm.w_routes_len()) draw();
}, 70);

function drawLabels() {
  const labels = new Uint32Array(wasm.memory.buffer, wasm.w_labels_ptr(), wasm.w_labels_len());
  const { R, camX, camY, cssW, cssH } = view;
  const size = Math.max(10, Math.round(R * 0.52));
  const line = size + 3;
  ctx.font = `${size}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < labels.length; ) {
    let n = 1;
    while (i + n < labels.length && (labels[i + n] & 0xffff) === (labels[i] & 0xffff)) n++;
    const [dx, dy] = hexCenterDisp(labels[i] & 0xff, (labels[i] >>> 8) & 0xff);
    const cx = dx - camX;
    const baseTop = dy - camY - R * 0.85 - n * line;
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
      const w = Math.max(line, ctx.measureText(text).width + 5);
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

function drawSectorCoords() {
  const { R, camX, camY, cssW, cssH } = view;
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.fillStyle = PALETTE[1];
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  if (!view.rot) {
    for (let sx = 0; sx < 10; sx++) {
      const [dx] = hexCenterDisp(sx * 8 + 4, 0);
      const px = dx - camX;
      if (px > 18 && px < cssW - 18) ctx.fillText(String.fromCharCode(65 + sx), px, 4);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let sy = 0; sy < 6; sy++) {
      const [, dy] = hexCenterDisp(0, Math.round((sy + 0.5) * (W_ROWS / 6)));
      const py = dy - camY;
      if (py > 18 && py < cssH - 18) ctx.fillText(String(sy + 1).padStart(2, "0"), 4, py);
    }
  } else {
    for (let sy = 0; sy < 6; sy++) {
      const [dx] = hexCenterDisp(0, Math.round((sy + 0.5) * (W_ROWS / 6)));
      const px = dx - camX;
      if (px > 14 && px < cssW - 14) ctx.fillText(String(sy + 1).padStart(2, "0"), px, 4);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let sx = 0; sx < 10; sx++) {
      const [, dy] = hexCenterDisp(sx * 8 + 4, 0);
      const py = dy - camY;
      if (py > 14 && py < cssH - 14) ctx.fillText(String.fromCharCode(65 + sx), 4, py);
    }
  }
}

function drawOverviewOverlays() {
  const { camX, camY } = view;
  const sp = wasm.w_special_pos();
  const [sdx, sdy] = hexCenterDisp(sp & 0xff, (sp >>> 8) & 0xff);
  ctx.strokeStyle = PALETTE[3];
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(sdx - camX, sdy - camY, 9, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  parsedProposals.forEach((p, idx) => {
    const [dx, dy] = hexCenterDisp(p.x, p.y);
    const px = dx - camX;
    const py = dy - camY - 10;
    ctx.fillStyle = idx === 0 ? PALETTE[3] : PALETTE[2];
    ctx.fillRect(px - 7, py - 6, 14, 12);
    ctx.fillStyle = PALETTE[0];
    ctx.fillText(String(idx + 1), px, py + 0.5);
  });
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
  const hasClash = !!wasm.w_has_clash();
  $("day").disabled = playing || halted;
  $("until").disabled = playing || halted;
  $("btn-refit").disabled = playing || !wasm.w_in_supply();

  $("clash-bar").hidden = !hasClash;
  if (hasClash) $("clash-msg").textContent = parts[6] ?? "적과 조우";

  const spPos = wasm.w_special_pos();
  const spSelected = !!(spPos & (1 << 16));
  $("fab-squad").classList.toggle("active", spSelected);
  $("btn-squad").style.borderColor = spSelected ? "var(--brood)" : "";
  $("btn-squad").style.color = spSelected ? "var(--brood)" : "";

  if (raw === lastTextRaw) return;
  lastTextRaw = raw;

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
      if (!playing) { wasm.w_preview_proposal(idx); draw(); }
    });
    div.addEventListener("mouseleave", () => {
      if (!playing) { wasm.w_preview_proposal(-1); draw(); }
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

  renderRefitModal(parts[7] ?? "", parts[8] ?? "");
}

const GENE_LABELS = [
  { id: 0, glyph: "ν", name: "원형" },
  { id: 1, glyph: "ψ", name: "저격" },
  { id: 2, glyph: "θ", name: "화력" },
  { id: 3, glyph: "λ", name: "잠복" },
];

function renderRefitModal(rowsRaw, metaRaw) {
  const [inSup, bio, missingHp, healCost, canRecruit, recruitCost, regeneCost] = metaRaw.split("\t").map(Number);
  $("refit-bio").textContent = `생체질 ${bio || 0}`;
  const healBtn = $("btn-heal");
  healBtn.textContent = missingHp > 0 ? `전원 치료 (−${missingHp}HP · 생체질 ${healCost})` : "부상 없음";
  healBtn.disabled = !inSup || !missingHp || bio < 2;
  const recBtn = $("btn-recruit");
  recBtn.textContent = `신병 충원 ν (생체질 ${recruitCost || 12})`;
  recBtn.disabled = !canRecruit;

  const list = $("refit-list");
  list.innerHTML = "";
  for (const line of rowsRaw.split("\n").filter(Boolean)) {
    const [slotStr, glyph, name, pips, hpStr, battles, gidStr] = line.split("\t");
    const slot = Number(slotStr);
    const gid = Number(gidStr);
    const row = document.createElement("div");
    row.className = "tr-row";
    row.innerHTML = `
      <span class="tr-glyph">${glyph}</span>
      <span>${name}</span>
      <span>${pips}</span>
      <span class="tr-meta">${hpStr} · ${battles}전</span>
      <div class="tr-genes"></div>`;
    const gWrap = row.querySelector(".tr-genes");
    for (const g of GENE_LABELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${g.glyph}${g.name}`;
      if (g.id === gid) {
        b.className = "on";
        b.disabled = true;
      } else {
        b.title = `생체질 ${regeneCost || 4}`;
        b.disabled = !inSup || bio < (regeneCost || 4);
        b.addEventListener("click", () => {
          if (wasm.w_regene(slot, g.id)) {
            save.events.push(["g", [slot, g.id]]);
            persist();
            draw();
          }
        });
      }
      gWrap.appendChild(b);
    }
    list.appendChild(row);
  }
}

$("btn-refit").addEventListener("click", () => {
  if (!playing && wasm.w_in_supply()) refitModal.hidden = false;
});
$("refit-close").addEventListener("click", () => { refitModal.hidden = true; });
refitModal.addEventListener("click", (ev) => { if (ev.target === refitModal) refitModal.hidden = true; });
$("btn-heal").addEventListener("click", () => {
  if (wasm.w_heal_squad()) { save.events.push(["h", 0]); persist(); draw(); }
});
$("btn-recruit").addEventListener("click", () => {
  if (wasm.w_recruit()) { save.events.push(["r", 0]); persist(); draw(); }
});

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
  const rect = canvas.getBoundingClientRect();
  const [dx, dy] = hexCenterDisp((m >>> 8) & 0xff, (m >>> 16) & 0xff);
  const px = rect.left + dx - view.camX;
  const py = rect.top + dy - view.camY;
  let left = px + view.R + 10;
  if (left + menu.offsetWidth > window.innerWidth - 8) left = px - view.R - menu.offsetWidth - 10;
  let top = py - 20;
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
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {}
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
    else if (e[0] === "h") wasm.w_heal_squad();
    else if (e[0] === "g") wasm.w_regene(e[1][0] | 0, e[1][1] | 0);
    else if (e[0] === "r") wasm.w_recruit();
    else if (e[0] === "b") wasm.w_apply_battle(e[1][0] | 0, e[1][1] | 0, e[1][2] | 0, e[1][3] >>> 0);
    else wasm.w_click(e[0] | 0, e[1] | 0);
  }
  if (data.fp !== undefined && data.fp !== wasm.w_fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

function showPop(q, r, clientX, clientY) {
  const len = wasm.w_inspect(q, r);
  if (!len) { pop.hidden = true; return false; }
  pop.textContent = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.w_popup_ptr(), len));
  pop.hidden = false;
  const left = Math.min(Math.max(clientX + 12, 8), window.innerWidth - pop.offsetWidth - 8);
  let top = clientY - pop.offsetHeight - 10;
  if (top < 8) top = clientY + 16;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  return true;
}

function hidePop() { pop.hidden = true; }

// 월드 포인터 입력: 드래그 팬, 핀치 줌, 헥스 클릭/조사
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
          const [q, r] = hexAtClient(ev.clientX, ev.clientY);
          showPop(q, r, ev.clientX, ev.clientY);
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
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2 && pinchStartDist > 0) {
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d < pinchStartDist * 0.78 && !view.overview) {
      pinchStartDist = d;
      setOverview(true);
    } else if (d > pinchStartDist * 1.25 && view.overview) {
      pinchStartDist = d;
      setOverview(false, hexAtClient((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2));
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
    const [q, r] = hexAtClient(ev.clientX, ev.clientY);
    if (q >= 0 && r >= 0 && q < W_COLS && r < W_ROWS) {
      const col = Math.min(9, Math.floor((q * 10) / W_COLS));
      const row = Math.min(5, Math.floor((r * 6) / W_ROWS));
      $("coords-hint").textContent = `${String.fromCharCode(65 + col)}${row + 1} (${q},${r})`;
      if (!view.overview) showPop(q, r, ev.clientX, ev.clientY);
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
  const [q, r] = hexAtClient(ev.clientX, ev.clientY);
  if (q < 0 || r < 0 || q >= W_COLS || r >= W_ROWS) return;
  if (view.overview) {
    setOverview(false, [q, r]);
    return;
  }
  const changed = wasm.w_click(q, r);
  if (changed) {
    save.events.push([q, r]);
    persist();
    hidePop();
  } else {
    showPop(q, r, ev.clientX, ev.clientY);
  }
  draw();
});

canvas.addEventListener("pointercancel", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  dragState = null;
  hidePop();
});
canvas.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") hidePop(); });
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const focus = hexAtClient(ev.clientX, ev.clientY);
    if (ev.deltaY > 0) {
      if (!view.overview && view.zoomR > 12) {
        view.zoomR = Math.max(12, view.zoomR - 3);
        layout();
        centerOn(focus[0], focus[1]);
        draw();
      } else {
        setOverview(true, focus);
      }
    } else if (ev.deltaY < 0) {
      if (view.overview) {
        setOverview(false, focus);
      } else if (view.zoomR < 34) {
        view.zoomR = Math.min(34, view.zoomR + 3);
        layout();
        centerOn(focus[0], focus[1]);
        draw();
      }
    }
  },
  { passive: false },
);

function toggleSheet(open) {
  sheetOpen = open;
  $("side").classList.toggle("open", sheetOpen);
  $("sheet-arrow").textContent = sheetOpen ? "▼" : "▲";
  updateMobTabs();
  setTimeout(() => { layout(); draw(); }, 20);
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
  b.addEventListener("click", () => { activeMobTab = b.dataset.tab; updateMobTabs(); });
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

// ============================================================
// 통합 전술 전투 뷰 (충돌 시 전환, 전투 종료 후 월드로 복귀)
// ============================================================
const bCanvas = $("b-screen");
const bCtx = bCanvas.getContext("2d");
const bRosterModal = $("b-roster-modal");
const B_FONT_PX = 20;
const B_TERRAIN = new Set([0xb7, 0x2584, 0x2588, 0x2022, 0x2248, 0xd7, 0x25c1]);
const B_BROOD = 3;
const B_SNAP = 0.95;
const BEAT_HIT = 3;
const BEAT_KILL = 5;

bCtx.font = `${B_FONT_PX}px ${FONT_FAMILY}`;
const B_BASE_W = Math.ceil(bCtx.measureText("M").width) + 4;
const B_BASE_H = Math.ceil(B_FONT_PX * 1.3);

let bView = { rot: false, cols: B_COLS, rows: B_ROWS, cw: B_BASE_W, ch: B_BASE_H, font: B_FONT_PX };
let bPending = null;
let bLastPointer = "mouse";
let bPlaying = false;
let bSkip = false;
let bLastRosterRaw = "";
let bHoldTimer = 0;
let bHoldStart = null;
let bSwallowClick = false;

const bToDisplay = (gx, gy) => (bView.rot ? [gy, B_COLS - 1 - gx] : [gx, gy]);
const bToGame = (dx, dy) => (bView.rot ? [B_COLS - 1 - dy, dx] : [dx, dy]);
const bFrameNow = () => new Uint32Array(wasm.memory.buffer, wasm.frame_ptr(), B_COLS * B_ROWS);

function enterBattle() {
  if (playing || inBattle || !wasm.w_has_clash()) return;
  if (!wasm.w_enter_battle()) return;
  hidePop();
  refitModal.hidden = true;
  menu.hidden = true;
  inBattle = true;
  bPending = null;
  bPlaying = false;
  bSkip = false;
  bLastRosterRaw = "";
  $("app").hidden = true;
  $("battle-app").hidden = false;
  battleLayout();
  battleDraw();
}

function finishBattleAndReturn() {
  if (!inBattle || bPlaying || !wasm.battle_done()) return;
  if (!wasm.w_finish_battle()) return;
  const record = [
    wasm.w_last_battle_word(0),
    wasm.w_last_battle_word(1),
    wasm.w_last_battle_word(2),
    wasm.w_last_battle_word(3) >>> 0,
  ];
  save.events.push(["b", record]);
  persist();
  inBattle = false;
  bRosterModal.hidden = true;
  hidePop();
  $("battle-app").hidden = true;
  $("app").hidden = false;
  lastTextRaw = "";
  layout();
  const sp = wasm.w_special_pos();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff);
  draw();
}

$("btn-enter-battle").addEventListener("click", enterBattle);
$("b-return").addEventListener("click", finishBattleAndReturn);
$("b-return-mob").addEventListener("click", finishBattleAndReturn);

function battleLayout() {
  const narrow = window.innerWidth < 700;
  const rot = narrow && window.innerHeight > window.innerWidth;
  const cols = rot ? B_ROWS : B_COLS;
  const rows = rot ? B_COLS : B_ROWS;
  let cw = B_BASE_W;
  let ch = B_BASE_H;
  let font = B_FONT_PX;
  if (narrow) {
    const avail = document.documentElement.clientWidth - 18;
    cw = Math.min(28, Math.floor(avail / cols));
    ch = rot ? cw + 2 : Math.round((cw * B_BASE_H) / B_BASE_W);
    font = Math.min(22, Math.floor(Math.min(ch * 0.8, cw * 1.4)));
  }
  bView = { rot, cols, rows, cw, ch, font };
  const dpr = window.devicePixelRatio || 1;
  bCanvas.width = cols * cw * dpr;
  bCanvas.height = rows * ch * dpr;
  bCanvas.style.width = `${cols * cw}px`;
  bCanvas.style.height = `${rows * ch}px`;
  $("b-main").style.width = narrow ? "" : `${cols * cw}px`;
  bCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function battleKick(kind) {
  if (stillness.matches || !bCanvas.animate) return;
  const d = kind === BEAT_KILL ? 3 : 2;
  bCanvas.animate(
    [{ transform: `translate(${d}px, ${d - 1}px)` }, { transform: `translate(${-d + 1}px, -1px)` }, { transform: "none" }],
    { duration: kind === BEAT_KILL ? 140 : 90, easing: "ease-out" },
  );
}

async function battlePlay() {
  if (bPlaying) return;
  bPlaying = true;
  bSkip = false;
  for (;;) {
    const beat = wasm.advance();
    if (!beat) break;
    const kind = beat >>> 16;
    battleDraw();
    if (kind === BEAT_HIT || kind === BEAT_KILL) battleKick(kind);
    await sleep(beat & 0xffff);
    if (bSkip) { wasm.skip(); break; }
  }
  bPlaying = false;
  battleDraw();
}

function bSkipIfPlaying() {
  if (bPlaying) bSkip = true;
  return bPlaying;
}

function battleDraw() {
  const frame = bFrameNow();
  const { cw, ch } = bView;
  bCtx.font = `${bView.font}px ${FONT_FAMILY}`;
  bCtx.textAlign = "center";
  bCtx.textBaseline = "middle";
  for (let y = 0; y < B_ROWS; y++) {
    for (let x = 0; x < B_COLS; x++) {
      const c = frame[y * B_COLS + x];
      const glyph = c & 0x1fffff;
      const [dx, dy] = bToDisplay(x, y);
      const px = dx * cw;
      const py = dy * ch;
      bCtx.fillStyle = PALETTE[c >>> 28];
      bCtx.fillRect(px, py, cw, ch);
      bCtx.fillStyle = PALETTE[(c >>> 24) & 0xf];
      if (glyph === 0x2588) bCtx.fillRect(px, py, cw, ch);
      else if (glyph === 0x2584) bCtx.fillRect(px + 2, py + ch / 2, cw - 4, ch / 2 - 2);
      else bCtx.fillText(String.fromCodePoint(glyph), px + cw / 2, py + ch / 2 + 1);
    }
  }
  if (bPending) {
    const [dx, dy] = bToDisplay(bPending[0], bPending[1]);
    bCtx.strokeStyle = PALETTE[2];
    bCtx.lineWidth = 1;
    bCtx.strokeRect(dx * cw + 0.5, dy * ch + 0.5, cw - 1, ch - 1);
  }
  const fl = wasm.damage_float();
  if (fl) {
    const [dx, dy] = bToDisplay((fl >>> 8) & 0xff, (fl >>> 16) & 0xff);
    const label = fl & (1 << 24) ? "빗나감!" : `−${fl & 0xff}`;
    const row = dy > 0 ? dy - 1 : dy + 1;
    const w = Math.max(cw, bCtx.measureText(label).width + 6);
    const left = Math.min(Math.max(dx * cw + cw / 2 - w / 2, 0), bView.cols * cw - w);
    bCtx.fillStyle = PALETTE[0];
    bCtx.fillRect(left, row * ch, w, ch);
    bCtx.fillStyle = PALETTE[2];
    bCtx.fillText(label, left + w / 2, row * ch + ch / 2 + 1);
  }

  const bytes = new Uint8Array(wasm.memory.buffer, wasm.text_ptr(), wasm.text_len());
  const parts = new TextDecoder().decode(bytes).split("\u001f");
  $("b-status").textContent = parts[0] ?? "";
  $("b-ledger").textContent = parts[1] ?? "";
  $("b-result").textContent = parts[2] ?? "";
  const ability = parts[3] ?? "";
  $("b-ability-name").textContent = ability;
  $("b-ability").toggleAttribute("data-off", !ability);
  $("b-retreat").toggleAttribute("data-off", !(parts[5] ?? ""));
  $("b-header").textContent = parts[6] ?? "";
  $("b-ai-note").textContent = parts[7] ?? "";
  renderBattleRoster(parts[4] ?? "");

  const done = !!wasm.battle_done();
  $("b-return").hidden = !done;
  $("b-return-mob").hidden = !done;
  $("b-end").disabled = done;
  $("b-end2").hidden = done;

  const aim = bPending
    ? [parts[2] ?? "", ...(parts[1] ?? "").split("\n").slice(1), (parts[1] ?? "").split("\n")[0]]
        .filter((t) => t && t !== "—")
        .join("  ")
        .replace(/ {3,}/g, " ")
    : "";
  $("b-aim").textContent = done ? parts[0] ?? "" : bPending ? aim || "이동" : "";
  $("b-confirm").hidden = done || !bPending;
}

function renderBattleRoster(raw) {
  if (raw === bLastRosterRaw) return;
  bLastRosterRaw = raw;
  const list = $("b-roster-list");
  list.innerHTML = "";
  for (const line of raw.split("\n").filter(Boolean)) {
    const [x, y, sel, glyph, name, pips, ap, tag] = line.split("\t");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = sel === "1" ? "roster-row selected" : "roster-row";
    btn.innerHTML = `<span class="roster-glyph">${glyph}</span><span>${name}</span><span class="roster-pips">${pips}</span><span class="roster-ap">${ap}</span><span class="roster-tag">${tag || ""}</span>`;
    btn.addEventListener("click", () => {
      bRosterModal.hidden = true;
      if (bSkipIfPlaying()) return;
      bClearPending();
      wasm.click(Number(x), Number(y));
      battlePlay();
    });
    list.appendChild(btn);
  }
}

function bCellAt(ev, snap) {
  const r = bCanvas.getBoundingClientRect();
  const fx = ((ev.clientX - r.left) / r.width) * bView.cols;
  const fy = ((ev.clientY - r.top) / r.height) * bView.rows;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  if (!snap) return bToGame(cx, cy);
  const frame = bFrameNow();
  const isUnit = (dx, dy) => {
    if (dx < 0 || dy < 0 || dx >= bView.cols || dy >= bView.rows) return false;
    const [gx, gy] = bToGame(dx, dy);
    return !B_TERRAIN.has(frame[gy * B_COLS + gx] & 0x1fffff);
  };
  if (isUnit(cx, cy)) return bToGame(cx, cy);
  let best = null;
  let bestD = B_SNAP;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!isUnit(cx + ox, cy + oy)) continue;
      const d = Math.hypot(fx - (cx + ox + 0.5), fy - (cy + oy + 0.5));
      if (d < bestD) { bestD = d; best = [cx + ox, cy + oy]; }
    }
  }
  return best ? bToGame(best[0], best[1]) : bToGame(cx, cy);
}

function bClearPending() { bPending = null; wasm.hover(-1, -1); }
function bIsOwnUnit(x, y) {
  const c = bFrameNow()[y * B_COLS + x];
  const fg = (c >>> 24) & 0xf;
  const bg = c >>> 28;
  return !B_TERRAIN.has(c & 0x1fffff) && (fg === B_BROOD || bg === B_BROOD || fg === 1);
}
function bIsReachable(x, y) {
  const c = bFrameNow()[y * B_COLS + x];
  const glyph = c & 0x1fffff;
  return (glyph === 0xb7 || glyph === 0x2022 || glyph === 0x25c1) && ((c >>> 24) & 0xf) === B_BROOD;
}
function bIsEnemyUnit(x, y) {
  const c = bFrameNow()[y * B_COLS + x];
  return !B_TERRAIN.has(c & 0x1fffff) && ((c >>> 24) & 0xf) === 4;
}

function bShowPop(x, y, clientX, clientY) {
  const len = x >= 0 && y >= 0 && x < B_COLS && y < B_ROWS ? wasm.inspect(x, y) : 0;
  if (!len) { pop.hidden = true; return false; }
  pop.textContent = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.popup_ptr(), len));
  pop.hidden = false;
  const left = Math.min(Math.max(clientX + 12, 8), window.innerWidth - pop.offsetWidth - 8);
  let top = clientY - pop.offsetHeight - 10;
  if (top < 8) top = clientY + 16;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  return true;
}

bCanvas.addEventListener("pointerdown", (ev) => {
  bLastPointer = ev.pointerType;
  bSwallowClick = false;
  if (ev.pointerType === "mouse") return;
  bHoldStart = [ev.clientX, ev.clientY];
  clearTimeout(bHoldTimer);
  bHoldTimer = setTimeout(() => {
    const [x, y] = bCellAt(ev, true);
    if (bShowPop(x, y, ev.clientX, ev.clientY)) bSwallowClick = true;
  }, HOLD_MS);
});
bCanvas.addEventListener("pointerup", (ev) => { if (ev.pointerType !== "mouse") hidePop(); });
bCanvas.addEventListener("pointercancel", () => { clearTimeout(bHoldTimer); hidePop(); });
bCanvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

bCanvas.addEventListener("click", (ev) => {
  if (bSwallowClick) { bSwallowClick = false; return; }
  if (bSkipIfPlaying() || wasm.battle_done()) return;
  if (bLastPointer === "mouse") {
    const [x, y] = bCellAt(ev, false);
    wasm.click(x, y);
    battlePlay();
    bShowPop(x, y, ev.clientX, ev.clientY);
    battleDraw();
    return;
  }
  const [x, y] = bCellAt(ev, true);
  if (bPending && bPending[0] === x && bPending[1] === y) {
    bClearPending(); wasm.click(x, y); battlePlay();
  } else if (bIsOwnUnit(x, y)) {
    bClearPending(); wasm.click(x, y); battlePlay();
  } else if (bIsEnemyUnit(x, y) || bIsReachable(x, y)) {
    bPending = [x, y]; wasm.hover(x, y);
  } else {
    bClearPending(); wasm.click(x, y); battlePlay();
  }
  battleDraw();
});

bCanvas.addEventListener("pointermove", (ev) => {
  if (ev.pointerType !== "mouse") {
    if (bHoldStart && Math.hypot(ev.clientX - bHoldStart[0], ev.clientY - bHoldStart[1]) > 10) {
      clearTimeout(bHoldTimer); hidePop();
    }
    return;
  }
  bLastPointer = "mouse";
  const [x, y] = bCellAt(ev, false);
  bShowPop(x, y, ev.clientX, ev.clientY);
  if (bPlaying) return;
  wasm.hover(x, y);
  battleDraw();
});
bCanvas.addEventListener("pointerleave", (ev) => {
  if (ev.pointerType !== "mouse") return;
  hidePop();
  if (bPlaying) return;
  wasm.hover(-1, -1);
  battleDraw();
});

$("b-confirm").addEventListener("click", () => {
  if (bSkipIfPlaying() || !bPending) return;
  const [x, y] = bPending;
  bClearPending();
  wasm.click(x, y);
  battlePlay();
});
function bEndTurn() {
  if (bSkipIfPlaying() || wasm.battle_done()) return;
  bClearPending();
  wasm.end_turn();
  battlePlay();
}
function bUseAbility() {
  if ($("b-ability").hasAttribute("data-off") || bSkipIfPlaying()) return;
  bClearPending();
  wasm.ability();
  battlePlay();
}
function bUseRetreat() {
  if ($("b-retreat").hasAttribute("data-off") || bSkipIfPlaying()) return;
  bClearPending();
  wasm.retreat();
  battlePlay();
}
$("b-end").addEventListener("click", bEndTurn);
$("b-end2").addEventListener("click", bEndTurn);
$("b-ability").addEventListener("click", bUseAbility);
$("b-retreat").addEventListener("click", bUseRetreat);
$("b-btn-roster").addEventListener("click", () => { bRosterModal.hidden = !bRosterModal.hidden; });
$("b-roster-close").addEventListener("click", () => { bRosterModal.hidden = true; });
bRosterModal.addEventListener("click", (ev) => { if (ev.target === bRosterModal) bRosterModal.hidden = true; });

document.addEventListener("keydown", (ev) => {
  if (inBattle) {
    if (ev.code === "Tab") { ev.preventDefault(); bRosterModal.hidden = !bRosterModal.hidden; return; }
    if (ev.code === "Escape" && !bRosterModal.hidden) { bRosterModal.hidden = true; return; }
    if (!bRosterModal.hidden) return;
    if (ev.target instanceof HTMLButtonElement) return;
    if (ev.code === "Space" || ev.code === "Enter") {
      ev.preventDefault();
      if (wasm.battle_done()) finishBattleAndReturn();
      else bEndTurn();
    } else if (ev.code === "KeyB" && !$("b-ability").hasAttribute("data-off")) bUseAbility();
    else if (ev.code === "KeyR" && !$("b-retreat").hasAttribute("data-off")) bUseRetreat();
    return;
  }

  if (ev.code === "Escape" && !refitModal.hidden) { refitModal.hidden = true; return; }
  if (!refitModal.hidden) return;
  if (ev.target instanceof HTMLButtonElement && ev.code === "Space") return;
  const pick = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(ev.code);
  if (pick >= 0 && !menu.hidden) { ev.preventDefault(); giveCommand(pick); return; }
  if (ev.code === "KeyG" && !playing && wasm.w_in_supply()) {
    ev.preventDefault();
    refitModal.hidden = false;
  } else if (ev.code === "KeyM" || ev.code === "Tab") {
    ev.preventDefault();
    setOverview(!view.overview);
  } else if (ev.code === "KeyF") {
    ev.preventDefault();
    focusAndSelectSpecial();
  } else if (ev.code === "Space" || ev.code === "Enter") {
    ev.preventDefault();
    if (wasm.w_has_clash()) enterBattle();
    else if (ev.shiftKey) passUntilEvent();
    else passDay();
  } else if (!view.overview) {
    const step = view.R * 5;
    if (ev.code === "KeyW" || ev.code === "ArrowUp") { view.camY -= step; clampCam(); draw(); }
    else if (ev.code === "KeyS" || ev.code === "ArrowDown") { view.camY += step; clampCam(); draw(); }
    else if (ev.code === "KeyA" || ev.code === "ArrowLeft") { view.camX -= step; clampCam(); draw(); }
    else if (ev.code === "KeyD" || ev.code === "ArrowRight") { view.camX += step; clampCam(); draw(); }
  }
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { updateMobTabs(); layout(); draw(); }, 100);
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
