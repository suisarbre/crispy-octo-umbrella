// 80×52 육각(Hex) 월드 + 통합 전술 전투 화면.
// 오프스크린 지형/미니맵 캐시 + 단일 rAF 루프 + A* 경량 호버 미리보기로 60fps를 유지하며,
// 좌드래그 관성 팬 · 우클릭 즉시 행군 · 커서 기준 연속 줌 · 재생/일시정지 배속 제어를 제공한다.
import { createBattleView } from "./battle_view.js";
import { sfx } from "./sfx.js";

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f", "#37725e"];
const SAVE_KEY = "crispy-octo-umbrella/world-hex-v1";
const SAVE_VERSION = 4;
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const HOLD_MS = 350;
const PULSE_MS_PER_TICK = 18;
const PULSE_REST = 4;
const SQRT3 = Math.sqrt(3);
const CACHE_R = 20;
const MAX_R = 36;
const TICKS_PER_DAY = 24;
const SPEED_MS = { 1: 95, 2: 45, 4: 16 };
const CMD_NAMES = ["이동", "매복", "주둔", "정찰"];

// 거점 글리프 테이블 (SiteKind::code 1..=10)
const SITE_GLYPH = ["", "◉", "◉", "◎", "◌", "○", "◈", "△", "▣", "┴", "⊞"];
// 부대 마커 (1: 특수부대, 2: 매복, 3: 정찰, 4: 아군AI, 5: 제국, 6: 충돌)
const FORCE_GLYPH = ["", "◆", "∩", "◇", "▪", "◆", "×"];

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");
const canvasBox = $("canvas-box");
const minimapEl = $("minimap");
const minimapCtx = minimapEl ? minimapEl.getContext("2d") : null;
const minimapWrap = $("minimap-wrap");
const menu = $("menu");
const pop = $("pop");
const refitModal = $("refit-modal");
const briefingModal = $("briefing-modal");
const campaignModal = $("campaign-modal");
const helpModal = $("help-modal");
const hoverInfoEl = $("hover-info");
const coordsHintEl = $("coords-hint");
const btnPlay = $("btn-play");
const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");

const DEFAULT_HINT_HTML =
  '좌드래그 <span class="hi-dim">지도 이동</span> · 우클릭 <span class="hi-brood">즉시 행군</span> · Shift+우클릭 <span class="hi-dim">메뉴</span> · 휠 <span class="hi-dim">커서 줌</span> · Space <span class="hi-brood">재생/정지</span>';

let campaignDismissed = false;
let lastCampaignRaw = "";
let lastBriefingRaw = "";

function syncSfxBtns() {
  const txt = sfx.isMuted() ? "음향 OFF" : "음향 ON";
  if ($("btn-sfx")) $("btn-sfx").textContent = txt;
  if ($("b-btn-sfx")) $("b-btn-sfx").textContent = txt;
}
syncSfxBtns();
for (const id of ["btn-sfx", "b-btn-sfx"]) {
  if ($(id)) {
    $(id).addEventListener("click", (ev) => {
      ev.currentTarget.blur();
      sfx.toggleMute();
      syncSfxBtns();
    });
  }
}

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;
const W_COLS = wasm.w_cols();
const W_ROWS = wasm.w_rows();
const UNIT_W = 1.5 * (W_COLS - 1) + 2;
const UNIT_H = SQRT3 * (W_ROWS + 0.5);

let save = { v: SAVE_VERSION, seed: 0, events: [] };
let inBattle = false;

// 실시간 재생 / 배속 상태
let timePlaying = false;
let timeMode = "play"; // "play" | "day" | "until"
let dayTicksLeft = 0;
let speedMul = 2;
let tickAccumMs = 0;
let dirtySave = false;

// 명령 모드 상태 (기본: 0=이동, 우클릭 즉시 실행 / 1~4로 무장 시 좌·우클릭 즉시 실행)
let activeCmdMode = 0;
let cmdArmed = false;

// 카메라 & 뷰 상태
let view = {
  narrow: false,
  rot: false,
  overview: false,
  cssW: 800,
  cssH: 500,
  dpr: 1,
  rect: { left: 0, top: 0, width: 800, height: 500 },
  R: 20,
  savedZoomR: 20,
  minR: 5,
  worldW: 0,
  worldH: 0,
  dispW: 0,
  dispH: 0,
  camX: 0,
  camY: 0,
};

// 부드러운 카메라 이동 (WASD 연속 이동 + 드래그 관성 + 목표점 글라이드)
const keysHeld = new Set();
let panVel = { vx: 0, vy: 0 };
let camGlide = null; // { x, y }

// 오프스크린 정적 지형 캐시 + 미니맵 캐시
const CACHE_W = Math.ceil(UNIT_W * CACHE_R);
const CACHE_H = Math.ceil(UNIT_H * CACHE_R);
const terrainCanvas = document.createElement("canvas");
terrainCanvas.width = CACHE_W;
terrainCanvas.height = CACHE_H;
const terrainCtx = terrainCanvas.getContext("2d", { alpha: false });

const MINI_W = 196;
const MINI_H = 128;
const miniCacheCanvas = document.createElement("canvas");
const miniCacheCtx = miniCacheCanvas.getContext("2d", { alpha: false });
let miniLayout = { scale: 1, offX: 0, offY: 0, drawW: MINI_W, drawH: MINI_H };

let cachedStaticVer = -1;
let lastStateVer = -1;
let lastTextRaw = "";
let lastHoverKey = "";
let parsedProposals = [];
let activeMobTab = "prop";
let sheetOpen = false;

// 인터랙션 & FX 상태
let hoverHex = null;
let inspectedHex = null;
let fxList = []; // { kind: 'pulse'|'invalid', q, r, color, start, dur }

// 단일 rAF 렌더 스케줄러
let rafId = 0;
let needsDraw = true;
let lastFrameTime = 0;
let lastIdlePulseAt = 0;

function requestDraw() {
  needsDraw = true;
  if (!rafId) rafId = requestAnimationFrame(frameLoop);
}

// ============================================================
// 헥스 기하 계산
// ============================================================
function hexCenterRaw(q, r, R = view.R) {
  return [R * 1.5 * q + R, R * SQRT3 * (r + (q & 1) * 0.5) + (R * SQRT3) / 2];
}

function hexCenterDisp(q, r, R = view.R) {
  const [gx, gy] = hexCenterRaw(q, r, R);
  const wW = UNIT_W * R;
  return view.rot ? [gy, wW - gx] : [gx, gy];
}

function hexVertsOffset(R = view.R, rot = view.rot) {
  const h = (R * SQRT3) / 2;
  const raw = [
    [R, 0],
    [R * 0.5, h],
    [-R * 0.5, h],
    [-R, 0],
    [-R * 0.5, -h],
    [R * 0.5, -h],
  ];
  return rot ? raw.map(([vx, vy]) => [vy, -vx]) : raw;
}

function hexNeighbors(q, r) {
  return (q & 1) === 0
    ? [[q + 1, r - 1], [q + 1, r], [q, r + 1], [q - 1, r], [q - 1, r - 1], [q, r - 1]]
    : [[q + 1, r], [q + 1, r + 1], [q, r + 1], [q - 1, r + 1], [q - 1, r], [q, r - 1]];
}

function hexAtClient(clientX, clientY) {
  const dispX = clientX - view.rect.left + view.camX;
  const dispY = clientY - view.rect.top + view.camY;
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

function syncWorldDims() {
  view.worldW = UNIT_W * view.R;
  view.worldH = UNIT_H * view.R;
  view.dispW = view.rot ? view.worldH : view.worldW;
  view.dispH = view.rot ? view.worldW : view.worldH;
  view.overview = view.R <= view.minR + 0.4;
}

function clampCam() {
  if (view.dispW <= view.cssW) view.camX = -(view.cssW - view.dispW) / 2;
  else view.camX = Math.max(0, Math.min(view.camX, view.dispW - view.cssW));
  if (view.dispH <= view.cssH) view.camY = -(view.cssH - view.dispH) / 2;
  else view.camY = Math.max(0, Math.min(view.camY, view.dispH - view.cssH));
}

function centerOn(q, r, smooth = false) {
  const [dx, dy] = hexCenterDisp(q, r);
  const tx = dx - view.cssW / 2;
  const ty = dy - view.cssH / 2;
  panVel.vx = 0;
  panVel.vy = 0;
  if (smooth && !stillness.matches && !view.overview) {
    const cx = view.dispW <= view.cssW ? -(view.cssW - view.dispW) / 2 : Math.max(0, Math.min(tx, view.dispW - view.cssW));
    const cy = view.dispH <= view.cssH ? -(view.cssH - view.dispH) / 2 : Math.max(0, Math.min(ty, view.dispH - view.cssH));
    camGlide = { x: cx, y: cy };
  } else {
    camGlide = null;
    view.camX = tx;
    view.camY = ty;
    clampCam();
  }
  requestDraw();
}

// 커서(screenX, screenY) 아래의 월드 지점을 제자리에 고정한 채 부드럽게 줌
function zoomAtScreenPoint(nextR, screenX, screenY) {
  const clampedR = Math.max(view.minR, Math.min(MAX_R, nextR));
  if (Math.abs(clampedR - view.R) < 0.01) return;
  const uX = (screenX + view.camX) / view.R;
  const uY = (screenY + view.camY) / view.R;
  view.R = clampedR;
  if (clampedR > view.minR + 0.5) view.savedZoomR = clampedR;
  syncWorldDims();
  view.camX = uX * view.R - screenX;
  view.camY = uY * view.R - screenY;
  clampCam();
  camGlide = null;
  updateModeUI();
  requestDraw();
}

function refreshCanvasRect() {
  const r = canvas.getBoundingClientRect();
  view.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
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
  view.dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.floor(view.cssW * view.dpr);
  const ph = Math.floor(view.cssH * view.dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  refreshCanvasRect();

  const dispUnitW = view.rot ? UNIT_H : UNIT_W;
  const dispUnitH = view.rot ? UNIT_W : UNIT_H;
  view.minR = Math.max(2.5, Math.min((view.cssW - 12) / dispUnitW, (view.cssH - 12) / dispUnitH));
  if (view.overview) {
    view.R = view.minR;
  } else {
    view.R = Math.max(view.minR, Math.min(MAX_R, view.R));
  }
  syncWorldDims();
  clampCam();
  setupMinimapCanvas();
  updateModeUI();
  requestDraw();
}

function setupMinimapCanvas() {
  if (!minimapEl || !minimapCtx) return;
  const dpr = view.dpr;
  const pw = Math.floor(MINI_W * dpr);
  const ph = Math.floor(MINI_H * dpr);
  if (minimapEl.width !== pw || minimapEl.height !== ph) {
    minimapEl.width = pw;
    minimapEl.height = ph;
  }
  minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (miniCacheCanvas.width !== pw || miniCacheCanvas.height !== ph) {
    miniCacheCanvas.width = pw;
    miniCacheCanvas.height = ph;
    cachedStaticVer = -1; // DPR 변경 시 미니맵 캐시도 재생성
  }
  miniCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scale = Math.min((MINI_W - 6) / UNIT_W, (MINI_H - 6) / UNIT_H);
  const drawW = UNIT_W * scale;
  const drawH = UNIT_H * scale;
  miniLayout = {
    scale,
    drawW,
    drawH,
    offX: (MINI_W - drawW) / 2,
    offY: (MINI_H - drawH) / 2,
  };
}

function setOverview(on, focusHex) {
  if (on) {
    if (view.R > view.minR + 0.5) view.savedZoomR = view.R;
    view.R = view.minR;
    syncWorldDims();
    clampCam();
    camGlide = null;
  } else {
    const targetR = Math.max(view.minR + 2, Math.min(MAX_R, view.savedZoomR || 20));
    view.R = targetR;
    syncWorldDims();
    if (focusHex) {
      centerOn(focusHex[0], focusHex[1], false);
    } else {
      clampCam();
    }
  }
  updateModeUI();
  requestDraw();
}

function updateModeUI() {
  $("btn-overview").style.borderColor = view.overview ? "var(--brood)" : "";
  $("btn-overview").style.color = view.overview ? "var(--brood)" : "";
  $("fab-overview").classList.toggle("active", view.overview);
  $("fab-overview").textContent = view.overview ? "전술" : "전체";
  canvas.classList.toggle("targeting", cmdArmed);
}

function spawnFx(kind, q, r, color, dur = 340) {
  if (stillness.matches) return;
  fxList.push({ kind, q, r, color, start: performance.now(), dur });
  requestDraw();
}

function drawHexPath(targetCtx, cx, cy, verts, scale = 1) {
  targetCtx.beginPath();
  targetCtx.moveTo(cx + verts[0][0] * scale, cy + verts[0][1] * scale);
  for (let i = 1; i < 6; i++) targetCtx.lineTo(cx + verts[i][0] * scale, cy + verts[i][1] * scale);
  targetCtx.closePath();
}

// ============================================================
// 오프스크린 정적 지형 & 미니맵 캐시 빌더 (정적 비트 변경 시에만 1회 실행)
// ============================================================
function drawMountainSymbolFast(c, cx, cy, R) {
  // ctx.clip() 없이 육각 내부로 딱 맞게 그린 산맥 해칭 + 쌍봉 + 능선
  const s = R * 0.56;
  c.strokeStyle = "#162026";
  c.lineWidth = Math.max(1, R * 0.075);
  c.beginPath();
  c.moveTo(cx - R * 0.52, cy - R * 0.15);
  c.lineTo(cx - R * 0.08, cy + R * 0.56);
  c.moveTo(cx - R * 0.25, cy - R * 0.54);
  c.lineTo(cx + R * 0.36, cy + R * 0.54);
  c.moveTo(cx + R * 0.12, cy - R * 0.52);
  c.lineTo(cx + R * 0.58, cy + R * 0.22);
  c.stroke();

  c.fillStyle = "#3c4b53";
  c.beginPath();
  c.moveTo(cx - s * 1.12, cy + s * 0.62);
  c.lineTo(cx - s * 0.34, cy - s * 0.72);
  c.lineTo(cx + s * 0.14, cy + s * 0.1);
  c.lineTo(cx + s * 0.5, cy - s * 0.48);
  c.lineTo(cx + s * 1.12, cy + s * 0.62);
  c.closePath();
  c.fill();

  c.strokeStyle = "#95a7b0";
  c.lineWidth = Math.max(1.2, R * 0.09);
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(cx - s * 0.94, cy + s * 0.4);
  c.lineTo(cx - s * 0.34, cy - s * 0.72);
  c.lineTo(cx + s * 0.12, cy + s * 0.08);
  c.lineTo(cx + s * 0.5, cy - s * 0.48);
  c.lineTo(cx + s * 0.94, cy + s * 0.4);
  c.stroke();
}

function drawForestSymbolFast(c, cx, cy, R) {
  const s = R * 0.25;
  c.fillStyle = "#526e3c";
  c.beginPath();
  const pts = [
    [cx - s * 1.15, cy + s * 0.55],
    [cx + s * 1.15, cy + s * 0.55],
    [cx, cy - s * 0.75],
  ];
  for (const [tx, ty] of pts) {
    c.moveTo(tx, ty - s * 1.05);
    c.lineTo(tx + s * 0.85, ty + s * 0.65);
    c.lineTo(tx - s * 0.85, ty + s * 0.65);
    c.closePath();
  }
  c.fill();
}

function drawHillSymbolFast(c, cx, cy, R) {
  const s = R * 0.45;
  c.lineWidth = Math.max(1.2, R * 0.08);
  c.lineCap = "round";
  c.strokeStyle = "#5c6d76";
  c.beginPath();
  c.arc(cx, cy + s * 0.55, s * 0.95, Math.PI * 1.18, Math.PI * 1.82);
  c.stroke();
  c.strokeStyle = "#414f57";
  c.beginPath();
  c.arc(cx, cy + s * 0.95, s * 0.65, Math.PI * 1.15, Math.PI * 1.85);
  c.stroke();
}

function rebuildStaticCaches(hexes) {
  const c = terrainCtx;
  const R = CACHE_R;
  const verts = hexVertsOffset(R, false);

  c.fillStyle = "#050708";
  c.fillRect(0, 0, CACHE_W, CACHE_H);

  // 패스 1: 지형·영토 바탕 + 육각 그리드 + 해역 파형 눈금
  c.lineWidth = 1;
  c.strokeStyle = "#10171b";
  c.beginPath();
  for (let r = 0; r < W_ROWS; r++) {
    for (let q = 0; q < W_COLS; q++) {
      const h = hexes[r * W_COLS + q];
      if ((h & 0x7) === 4 && ((q + r) & 1) === 0) {
        const [cx, cy] = hexCenterRaw(q, r, R);
        c.moveTo(cx - R * 0.28, cy);
        c.lineTo(cx + R * 0.28, cy);
      }
    }
  }
  c.stroke();

  for (let r = 0; r < W_ROWS; r++) {
    for (let q = 0; q < W_COLS; q++) {
      const h = hexes[r * W_COLS + q];
      const terr = h & 0x7;
      if (terr === 4) continue;
      const owner = (h >>> 4) & 0x3;
      const inSup = !!(h & (1 << 12));
      const [cx, cy] = hexCenterRaw(q, r, R);

      drawHexPath(c, cx, cy, verts);
      if (terr === 3) {
        c.fillStyle = "#243037";
      } else if (owner === 1) {
        c.fillStyle = terr === 1 ? "#152a20" : terr === 2 ? "#122a2f" : "#0e2228";
      } else if (owner === 2) {
        c.fillStyle = terr === 1 ? "#251a12" : terr === 2 ? "#281c15" : "#221610";
      } else if (terr === 1) {
        c.fillStyle = "#151f11";
      } else if (terr === 2) {
        c.fillStyle = "#181f24";
      } else {
        c.fillStyle = "#0c0f11";
      }
      c.fill();

      c.strokeStyle = terr === 3 ? "#394850" : inSup ? "#223b34" : "#1b2429";
      c.stroke();
    }
  }

  // 패스 1.5: 산맥·해역 경계 능선 테두리 (배치 stroke)
  c.lineCap = "round";
  const drawBarrierEdges = (targetTerr, color, width) => {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    for (let r = 0; r < W_ROWS; r++) {
      for (let q = 0; q < W_COLS; q++) {
        if ((hexes[r * W_COLS + q] & 0x7) !== targetTerr) continue;
        const [cx, cy] = hexCenterRaw(q, r, R);
        const nbs = hexNeighbors(q, r);
        for (let d = 0; d < 6; d++) {
          const [nq, nr] = nbs[d];
          if (nq < 0 || nr < 0 || nq >= W_COLS || nr >= W_ROWS) continue;
          if ((hexes[nr * W_COLS + nq] & 0x7) <= 2) {
            const v1 = verts[(d + 5) % 6];
            const v2 = verts[d];
            c.moveTo(cx + v1[0], cy + v1[1]);
            c.lineTo(cx + v2[0], cy + v2[1]);
          }
        }
      }
    }
    c.stroke();
  };
  drawBarrierEdges(4, "#1f2e36", 1.5);
  drawBarrierEdges(3, "#627680", 2.2);

  // 패스 2: Civ식 영토 외곽 경계선 (아군 민트 / 제국 주황, 배치 stroke)
  const drawBorderPass = (targetOwner, stroke, width) => {
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.beginPath();
    for (let r = 0; r < W_ROWS; r++) {
      for (let q = 0; q < W_COLS; q++) {
        const h = hexes[r * W_COLS + q];
        const bmask = (h >>> 19) & 0x3f;
        if (!bmask) continue;
        const owner = (h >>> 4) & 0x3;
        if (targetOwner !== 0 && owner !== targetOwner) continue;
        const [cx, cy] = hexCenterRaw(q, r, R);
        for (let d = 0; d < 6; d++) {
          if (!(bmask & (1 << d))) continue;
          const v1 = verts[(d + 5) % 6];
          const v2 = verts[d];
          c.moveTo(cx + v1[0], cy + v1[1]);
          c.lineTo(cx + v2[0], cy + v2[1]);
        }
      }
    }
    c.stroke();
  };
  drawBorderPass(0, "rgba(12, 15, 17, 0.72)", 4.4);
  drawBorderPass(1, PALETTE[3], 2.5);
  drawBorderPass(2, PALETTE[4], 2.5);

  // 패스 3: 전략 도로망
  const drawRoadPass = (stroke, width) => {
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.beginPath();
    for (let r = 0; r < W_ROWS; r++) {
      for (let q = 0; q < W_COLS; q++) {
        const h = hexes[r * W_COLS + q];
        if (!(h & 0x8)) continue;
        const rmask = (h >>> 13) & 0x3f;
        const [cx, cy] = hexCenterRaw(q, r, R);
        for (let d = 0; d < 6; d++) {
          if (!(rmask & (1 << d))) continue;
          const v1 = verts[(d + 5) % 6];
          const v2 = verts[d];
          c.moveTo(cx, cy);
          c.lineTo(cx + (v1[0] + v2[0]) * 0.5, cy + (v1[1] + v2[1]) * 0.5);
        }
      }
    }
    c.stroke();
  };
  drawRoadPass("#161f24", Math.max(3.6, R * 0.22));
  drawRoadPass("#7c8e96", Math.max(1.8, R * 0.11));

  // 패스 4: 정적 지형 심볼 (산맥/숲/고지/평지 점) + 거점 글리프
  c.font = `${Math.round(R * 0.85)}px ${FONT_FAMILY}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (let r = 0; r < W_ROWS; r++) {
    for (let q = 0; q < W_COLS; q++) {
      const h = hexes[r * W_COLS + q];
      const terr = h & 0x7;
      if (terr === 4) continue;
      const skind = (h >>> 6) & 0xf;
      const sowner = (h >>> 10) & 0x3;
      const [cx, cy] = hexCenterRaw(q, r, R);

      if (terr === 3) {
        drawMountainSymbolFast(c, cx, cy, R);
      } else if (skind > 0) {
        c.fillStyle = sowner === 1 ? PALETTE[3] : sowner === 2 ? PALETTE[4] : PALETTE[2];
        c.fillText(SITE_GLYPH[skind], cx, cy + 1);
      } else if (terr === 1) {
        drawForestSymbolFast(c, cx, cy, R);
      } else if (terr === 2) {
        drawHillSymbolFast(c, cx, cy, R);
      } else {
        c.fillStyle = "#263137";
        c.fillText("·", cx, cy + 1);
      }
    }
  }

  // 미니맵 정적 캐시 동시 생성
  if (miniCacheCtx) {
    const mc = miniCacheCtx;
    const { scale, offX, offY } = miniLayout;
    const cw = Math.max(1.8, scale * 1.65);
    const ch = Math.max(1.8, scale * SQRT3 * 1.05);
    mc.fillStyle = "#050708";
    mc.fillRect(0, 0, MINI_W, MINI_H);

    for (let r = 0; r < W_ROWS; r++) {
      for (let q = 0; q < W_COLS; q++) {
        const h = hexes[r * W_COLS + q];
        const terr = h & 0x7;
        if (terr === 4) continue;
        const owner = (h >>> 4) & 0x3;
        const hasRoad = !!(h & 0x8);
        const skind = (h >>> 6) & 0xf;
        const sowner = (h >>> 10) & 0x3;
        const [gx, gy] = hexCenterRaw(q, r, scale);
        const mx = offX + gx;
        const my = offY + gy;

        if (terr === 3) mc.fillStyle = "#485861";
        else if (owner === 1) mc.fillStyle = "#19443e";
        else if (owner === 2) mc.fillStyle = "#3f2416";
        else if (terr === 1) mc.fillStyle = "#223018";
        else if (terr === 2) mc.fillStyle = "#232d34";
        else mc.fillStyle = "#141a1e";
        mc.fillRect(mx - cw * 0.5, my - ch * 0.5, cw, ch);

        if (hasRoad) {
          mc.fillStyle = "#7a8c94";
          mc.fillRect(mx - 0.7, my - 0.7, 1.4, 1.4);
        }
        if (skind > 0) {
          mc.fillStyle = sowner === 1 ? PALETTE[3] : sowner === 2 ? PALETTE[4] : PALETTE[2];
          const sr = skind <= 2 ? 2.6 : 1.7;
          mc.beginPath();
          mc.arc(mx, my, sr, 0, Math.PI * 2);
          mc.fill();
        }
      }
    }
  }
}

// ============================================================
// 고속 프레임 렌더러 (오프스크린 캐시 blit + 동적 레이어만 그림)
// ============================================================
function drawBlockedSymbol(cx, cy, R, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const rad = Math.max(5, R * 0.44);
  ctx.strokeStyle = PALETTE[4];
  ctx.lineWidth = Math.max(2, R * 0.13);
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.moveTo(cx - rad * 0.72, cy - rad * 0.72);
  ctx.lineTo(cx + rad * 0.72, cy + rad * 0.72);
  ctx.stroke();
  ctx.restore();
}

function draw(now = performance.now()) {
  if (inBattle) {
    battleDraw();
    return;
  }

  const hexes = new Uint32Array(wasm.memory.buffer, wasm.w_hex_ptr(), W_COLS * W_ROWS);
  const sver = wasm.w_static_version();
  if (sver !== cachedStaticVer) {
    cachedStaticVer = sver;
    rebuildStaticCaches(hexes);
  }

  const { R, camX, camY, cssW, cssH } = view;
  const scale = R / CACHE_R;
  const wideView = R < 9;

  // 1. 정적 지형 캐시 1방 blit
  ctx.fillStyle = "#050708";
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.imageSmoothingEnabled = true;
  if (!view.rot) {
    const sx0 = Math.max(0, camX / scale);
    const sy0 = Math.max(0, camY / scale);
    const sx1 = Math.min(CACHE_W, (camX + cssW) / scale);
    const sy1 = Math.min(CACHE_H, (camY + cssH) / scale);
    if (sx1 > sx0 && sy1 > sy0) {
      const dx = sx0 * scale - camX;
      const dy = sy0 * scale - camY;
      ctx.drawImage(terrainCanvas, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, (sx1 - sx0) * scale, (sy1 - sy0) * scale);
    }
  } else {
    ctx.save();
    ctx.translate(-camX, view.worldW - camY);
    ctx.rotate(-Math.PI / 2);
    ctx.scale(scale, scale);
    ctx.drawImage(terrainCanvas, 0, 0);
    ctx.restore();
  }

  // 2. 이동 경로 & 미리보기 경로 & 펄스
  drawRoutes(now, wideView);

  // 3. 동적 마커 (부대 · 충돌 · 선택/목표 헥스만 스캔)
  let qMin = 0, qMax = W_COLS - 1, rMin = 0, rMax = W_ROWS - 1;
  if (!wideView) {
    const pad = R * 2.2;
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

  const verts = hexVertsOffset(R, view.rot);
  const glyphFont = Math.max(9, Math.round(R * 0.85));
  ctx.font = `${glyphFont}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let r = rMin; r <= rMax; r++) {
    const rowOff = r * W_COLS;
    for (let q = qMin; q <= qMax; q++) {
      const h = hexes[rowOff + q];
      if ((h >>> 25) === 0) continue; // 정적 헥스는 캐시가 이미 그림!

      const skind = (h >>> 6) & 0xf;
      const fmark = (h >>> 25) & 0x7;
      const selected = !!(h & (1 << 28));
      const isTarget = !!(h & (1 << 29));
      const [dx, dy] = hexCenterDisp(q, r);
      const cx = dx - camX;
      const cy = dy - camY;
      if (cx < -R * 1.5 || cx > cssW + R * 1.5 || cy < -R * 1.5 || cy > cssH + R * 1.5) continue;

      if (wideView) {
        if (fmark === 6) {
          ctx.fillStyle = PALETTE[4];
          ctx.fillRect(cx - 4.5, cy - 4.5, 9, 9);
        } else if (fmark >= 1 && fmark <= 3) {
          ctx.fillStyle = PALETTE[3];
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(4, R * 0.72), 0, Math.PI * 2);
          ctx.fill();
        } else if (fmark === 5) {
          ctx.fillStyle = PALETTE[4];
          ctx.fillRect(cx - 2, cy - 2, 4, 4);
        } else if (fmark === 4) {
          ctx.fillStyle = PALETTE[5];
          ctx.fillRect(cx - 1.8, cy - 1.8, 3.6, 3.6);
        }
        continue;
      }

      if (selected || isTarget) {
        drawHexPath(ctx, cx, cy, verts, 0.92);
        ctx.fillStyle = PALETTE[3];
        ctx.fill();
      }

      if (fmark === 6) {
        ctx.fillStyle = PALETTE[4];
        drawHexPath(ctx, cx, cy, verts, 0.92);
        ctx.fill();
        ctx.fillStyle = PALETTE[0];
        ctx.fillText("×", cx, cy + 1);
      } else if (skind > 0) {
        if (selected || isTarget || (fmark >= 1 && fmark <= 3)) {
          if (!selected && !isTarget) {
            // 특수부대가 거점 위에 있으면 민트 강조
            ctx.fillStyle = PALETTE[0];
            ctx.beginPath();
            ctx.arc(cx, cy, R * 0.45, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = selected || isTarget ? PALETTE[0] : PALETTE[3];
          ctx.fillText(SITE_GLYPH[skind], cx, cy + 1);
        }
      } else if (fmark > 0) {
        if (!selected && !isTarget) {
          ctx.fillStyle = "rgba(12, 15, 17, 0.72)";
          ctx.beginPath();
          ctx.arc(cx, cy, R * 0.46, 0, Math.PI * 2);
          ctx.fill();
        }
        const g = FORCE_GLYPH[fmark];
        if (selected || isTarget) ctx.fillStyle = PALETTE[0];
        else if (fmark <= 3) ctx.fillStyle = PALETTE[3];
        else if (fmark === 4) ctx.fillStyle = PALETTE[5];
        else ctx.fillStyle = PALETTE[4];
        ctx.fillText(g, cx, cy + 1);
      }
    }
  }

  // 4. 인터랙션 오버레이 · 인원 라벨 · 섹터 좌표 · 광역 마커
  if (!wideView) {
    drawInteractionOverlays(hexes, verts, now);
    drawLabels();
    drawSectorCoords();
  } else {
    drawWideOverlays(now);
    drawInteractionOverlays(hexes, verts, now);
  }

  // 5. 미니맵 갱신
  drawMinimap(now);

  // 6. 상태 버전이 바뀌었을 때만 DOM 동기화 (팬·줌·호버 중 DOM 리플로우 0!)
  const stVer = wasm.w_state_version();
  if (stVer !== lastStateVer) {
    lastStateVer = stVer;
    syncTextAndPanels();
    refreshHoverBar(true);
  }
  placeMenu();
}

function drawInteractionOverlays(hexes, verts, now) {
  const { R, camX, camY } = view;
  const spPos = wasm.w_special_pos();
  const spQ = spPos & 0xff;
  const spR = (spPos >>> 8) & 0xff;
  const spSelected = !!(spPos & (1 << 16));

  // 1. 비선택 조사 클릭 테두리
  if (!spSelected && inspectedHex) {
    const [iq, ir] = inspectedHex;
    const [dx, dy] = hexCenterDisp(iq, ir);
    drawHexPath(ctx, dx - camX, dy - camY, verts, 0.96);
    ctx.strokeStyle = PALETTE[2];
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // 2. 특수부대 선택 또는 명령 무장 시 활성 외곽 링
  if (spSelected || cmdArmed) {
    const [sdx, sdy] = hexCenterDisp(spQ, spR);
    drawHexPath(ctx, sdx - camX, sdy - camY, verts, 1.08);
    ctx.strokeStyle = PALETTE[3];
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // 3. 마우스 호버 레티클
  if (hoverHex) {
    const [hq, hr] = hoverHex;
    if (hq >= 0 && hr >= 0 && hq < W_COLS && hr < W_ROWS) {
      const terr = hexes[hr * W_COLS + hq] & 0x7;
      const impassable = terr === 3 || terr === 4;
      const [dx, dy] = hexCenterDisp(hq, hr);
      const cx = dx - camX;
      const cy = dy - camY;
      const showOrderReticle = (spSelected || cmdArmed) && (hq !== spQ || hr !== spR);

      if (showOrderReticle) {
        if (impassable) {
          const [sdx, sdy] = hexCenterDisp(spQ, spR);
          ctx.save();
          ctx.strokeStyle = "rgba(232, 130, 63, 0.5)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(sdx - camX, sdy - camY);
          ctx.lineTo(cx, cy);
          ctx.stroke();
          ctx.restore();

          drawHexPath(ctx, cx, cy, verts, 0.96);
          ctx.fillStyle = "rgba(232, 130, 63, 0.22)";
          ctx.fill();
          ctx.strokeStyle = PALETTE[4];
          ctx.lineWidth = 2;
          ctx.stroke();
          if (R >= 10) drawBlockedSymbol(cx, cy, R, 1);
        } else {
          drawHexPath(ctx, cx, cy, verts, 0.96);
          ctx.fillStyle = cmdArmed ? "rgba(99, 214, 172, 0.22)" : "rgba(99, 214, 172, 0.12)";
          ctx.fill();
          ctx.strokeStyle = PALETTE[3];
          ctx.lineWidth = cmdArmed ? 2.2 : 1.6;
          ctx.stroke();
          if (R >= 11) {
            ctx.fillStyle = PALETTE[3];
            ctx.font = `${Math.max(10, Math.round(R * 0.72))}px ${FONT_FAMILY}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("◇", cx, cy + 1);
          }
        }
      } else {
        drawHexPath(ctx, cx, cy, verts, 0.96);
        ctx.strokeStyle = impassable ? "rgba(232, 130, 63, 0.35)" : "rgba(207, 202, 187, 0.38)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
  }

  // 4. 클릭/명령 펄스 & 통행 불가 흔들림 이펙트
  for (const fx of fxList) {
    const t = Math.min(1, (now - fx.start) / fx.dur);
    const [dx, dy] = hexCenterDisp(fx.q, fx.r);
    let cx = dx - camX;
    const cy = dy - camY;
    if (fx.kind === "pulse") {
      ctx.save();
      ctx.globalAlpha = 1 - t;
      drawHexPath(ctx, cx, cy, verts, 0.9 + t * 0.55);
      ctx.strokeStyle = fx.color;
      ctx.lineWidth = 2.4 * (1 - t * 0.5);
      ctx.stroke();
      ctx.restore();
    } else if (fx.kind === "invalid") {
      cx += Math.sin(t * Math.PI * 5) * (1 - t) * 4;
      ctx.save();
      ctx.globalAlpha = 1 - t * 0.85;
      drawHexPath(ctx, cx, cy, verts, 0.96);
      ctx.fillStyle = "rgba(232, 130, 63, 0.32)";
      ctx.fill();
      ctx.strokeStyle = PALETTE[4];
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.restore();
      if (R >= 10) drawBlockedSymbol(cx, cy, R, 1 - t * 0.7);
    }
  }
}

function drawRoutes(now, wideView) {
  const len = wasm.w_routes_len();
  if (!len) return;
  const routes = new Uint32Array(wasm.memory.buffer, wasm.w_routes_ptr(), len);
  const { R, camX, camY } = view;

  for (let i = 0, k = 0; i < len; k++) {
    const head = routes[i];
    const n = head & 0xffff;
    const isSpecial = !!(head & (1 << 16));
    const isPreview = !!(head & (1 << 17));
    const avgTicks = Math.max(2, head >>> 20);
    const bright = isSpecial || isPreview;

    ctx.strokeStyle = bright ? PALETTE[3] : PALETTE[5];
    ctx.lineWidth = wideView ? (bright ? 2 : 1) : (bright ? Math.max(2.4, R * 0.15) : Math.max(1.4, R * 0.09));
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

    if (!isPreview && !stillness.matches && n > 0) {
      const interval = avgTicks * PULSE_MS_PER_TICK;
      const at = Math.floor(((now + k * 290) % ((n + PULSE_REST) * interval)) / interval);
      if (at < n) {
        const node = routes[i + 2 + at];
        const [dx, dy] = hexCenterDisp(node & 0xff, (node >>> 8) & 0xff);
        ctx.fillStyle = isSpecial ? PALETTE[2] : PALETTE[3];
        ctx.beginPath();
        ctx.arc(dx - camX, dy - camY, wideView ? 2.5 : Math.max(3.5, R * 0.21), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (!wideView && bright && R >= 12) {
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

function drawLabels() {
  const { R, camX, camY, cssW, cssH } = view;
  if (R < 11) return;
  const labels = new Uint32Array(wasm.memory.buffer, wasm.w_labels_ptr(), wasm.w_labels_len());
  const size = Math.max(10, Math.round(R * 0.5));
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
  const { camX, camY, cssW, cssH } = view;
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

function drawWideOverlays(now) {
  const { camX, camY } = view;
  const sp = wasm.w_special_pos();
  const [sdx, sdy] = hexCenterDisp(sp & 0xff, (sp >>> 8) & 0xff);
  const pulse = stillness.matches ? 0 : Math.sin(now * 0.006) * 2;
  ctx.strokeStyle = PALETTE[3];
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(sdx - camX, sdy - camY, 9 + pulse, 0, Math.PI * 2);
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

function drawMinimap(now) {
  if (!minimapCtx || view.narrow) return;
  const mc = minimapCtx;
  const { scale, offX, offY, drawW, drawH } = miniLayout;

  mc.drawImage(miniCacheCanvas, 0, 0, MINI_W, MINI_H);

  // 동적 부대 점
  const labels = new Uint32Array(wasm.memory.buffer, wasm.w_labels_ptr(), wasm.w_labels_len());
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    const q = l & 0xff;
    const r = (l >>> 8) & 0xff;
    const isEmpire = !!(l & (1 << 28));
    const isSpecial = !!(l & (1 << 30));
    const [gx, gy] = hexCenterRaw(q, r, scale);
    const mx = offX + gx;
    const my = offY + gy;
    if (isSpecial) {
      mc.fillStyle = PALETTE[3];
      mc.beginPath();
      mc.arc(mx, my, 3, 0, Math.PI * 2);
      mc.fill();
      const ring = stillness.matches ? 5.5 : 5 + Math.sin(now * 0.007) * 1.3;
      mc.strokeStyle = PALETTE[3];
      mc.lineWidth = 1;
      mc.beginPath();
      mc.arc(mx, my, ring, 0, Math.PI * 2);
      mc.stroke();
    } else if (isEmpire) {
      mc.fillStyle = PALETTE[4];
      mc.fillRect(mx - 1.5, my - 1.5, 3, 3);
    } else {
      mc.fillStyle = PALETTE[5];
      mc.fillRect(mx - 1.2, my - 1.2, 2.4, 2.4);
    }
  }

  // 현재 카메라 뷰포트 사각형
  const vx = offX + (view.camX / view.worldW) * drawW;
  const vy = offY + (view.camY / view.worldH) * drawH;
  const vw = Math.min(drawW, (view.cssW / view.worldW) * drawW);
  const vh = Math.min(drawH, (view.cssH / view.worldH) * drawH);
  const cx0 = Math.max(offX, Math.min(offX + drawW - vw, vx));
  const cy0 = Math.max(offY, Math.min(offY + drawH - vh, vy));

  mc.fillStyle = "rgba(207, 202, 187, 0.08)";
  mc.fillRect(cx0, cy0, vw, vh);
  mc.strokeStyle = PALETTE[2];
  mc.lineWidth = 1.2;
  mc.strokeRect(cx0 + 0.5, cy0 + 0.5, Math.max(4, vw - 1), Math.max(4, vh - 1));
}

// ============================================================
// 단일 rAF 게임/카메라/애니메이션 루프
// ============================================================
function frameLoop(now) {
  rafId = 0;
  if (inBattle) return;

  const dt = lastFrameTime ? Math.min(0.05, (now - lastFrameTime) / 1000) : 0.016;
  lastFrameTime = now;
  let keepGoing = false;

  // 1. WASD / 화살표 연속 카메라 이동
  let kx = 0, ky = 0;
  if (keysHeld.has("KeyA") || keysHeld.has("ArrowLeft")) kx -= 1;
  if (keysHeld.has("KeyD") || keysHeld.has("ArrowRight")) kx += 1;
  if (keysHeld.has("KeyW") || keysHeld.has("ArrowUp")) ky -= 1;
  if (keysHeld.has("KeyS") || keysHeld.has("ArrowDown")) ky += 1;
  if ((kx !== 0 || ky !== 0) && !view.overview) {
    const len = Math.hypot(kx, ky);
    const boost = keysHeld.has("ShiftLeft") || keysHeld.has("ShiftRight") ? 1.8 : 1;
    const speed = 640 * boost;
    view.camX += (kx / len) * speed * dt;
    view.camY += (ky / len) * speed * dt;
    clampCam();
    camGlide = null;
    panVel.vx = 0;
    panVel.vy = 0;
    needsDraw = true;
    keepGoing = true;
  }

  // 2. 드래그 관성 (모멘텀)
  if (!dragState && (Math.abs(panVel.vx) > 6 || Math.abs(panVel.vy) > 6)) {
    if (!view.overview) {
      view.camX += panVel.vx * dt;
      view.camY += panVel.vy * dt;
      clampCam();
      const decay = Math.pow(0.0006, dt);
      panVel.vx *= decay;
      panVel.vy *= decay;
      needsDraw = true;
      keepGoing = true;
    } else {
      panVel.vx = 0;
      panVel.vy = 0;
    }
  }

  // 3. 목표점 부드러운 글라이드 (F / 미니맵 점프 / 제안 점프)
  if (camGlide) {
    const dx = camGlide.x - view.camX;
    const dy = camGlide.y - view.camY;
    if (Math.hypot(dx, dy) < 1.5) {
      view.camX = camGlide.x;
      view.camY = camGlide.y;
      camGlide = null;
    } else {
      const alpha = 1 - Math.pow(0.00008, dt);
      view.camX += dx * alpha;
      view.camY += dy * alpha;
      keepGoing = true;
    }
    clampCam();
    needsDraw = true;
  }

  // 4. 실시간 시간 진행 (재생 / +1일 / 사건까지)
  if (timePlaying) {
    if (wasm.w_halted()) {
      stopTime(true);
    } else {
      const interval =
        stillness.matches
          ? 1
          : timeMode === "until"
            ? 14
            : timeMode === "day"
              ? 24
              : SPEED_MS[speedMul] || 45;
      tickAccumMs += dt * 1000;
      let stepped = 0;
      const maxStepsPerFrame = stillness.matches ? 24 : 4;
      while (tickAccumMs >= interval && stepped < maxStepsPerFrame && timePlaying) {
        tickAccumMs -= interval;
        const done = wasm.w_tick(1);
        noteTicks(done);
        dirtySave = true;
        stepped++;
        if (!done || wasm.w_halted()) {
          stopTime(true);
          break;
        }
        if (timeMode === "day") {
          dayTicksLeft -= done;
          if (dayTicksLeft <= 0) {
            stopTime(true);
            break;
          }
        } else if (wasm.w_stop_reason() !== 0) {
          stopTime(true);
          break;
        }
      }
      if (stepped > 0) needsDraw = true;
      if (timePlaying) keepGoing = true;
    }
  }

  // 5. 클릭/불가 FX 수명 관리
  if (fxList.length > 0) {
    fxList = fxList.filter((f) => now - f.start < f.dur);
    needsDraw = true;
    if (fxList.length > 0) keepGoing = true;
  }

  // 6. 경로 위 흐르는 펄스 애니메이션 (유휴 시 ~15fps로 저부하 유지)
  const hasRoutes = wasm.w_routes_len() > 0;
  if (hasRoutes && !stillness.matches && !document.hidden) {
    if (now - lastIdlePulseAt >= 66) {
      lastIdlePulseAt = now;
      needsDraw = true;
    }
    keepGoing = true;
  }

  if (needsDraw) {
    needsDraw = false;
    draw(now);
  }

  if (keepGoing) {
    rafId = requestAnimationFrame(frameLoop);
  } else {
    lastFrameTime = 0;
  }
}

// ============================================================
// 하단 고정 호버 인스펙터 바 (커서 팝업 대체 · 리플로우 0)
// ============================================================
function formatEtaTicks(ticks) {
  const tenths = Math.round((ticks * 10) / TICKS_PER_DAY);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return frac === 0 ? `${whole}일` : `${whole}.${frac}일`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function refreshHoverBar(force = false) {
  if (!hoverInfoEl) return;
  const target = hoverHex || inspectedHex;
  if (!target) {
    if (force || lastHoverKey !== "") {
      lastHoverKey = "";
      hoverInfoEl.innerHTML = cmdArmed
        ? `<span class="hi-brood">[${CMD_NAMES[activeCmdMode]} 모드]</span> 목적지 헥스를 좌클릭 또는 우클릭하세요 · <span class="hi-dim">Esc/우클릭 취소</span>`
        : DEFAULT_HINT_HTML;
      if (coordsHintEl) coordsHintEl.textContent = "";
    }
    return;
  }

  const [q, r] = target;
  const pSteps = wasm.w_preview_steps();
  const pTicks = wasm.w_preview_ticks();
  const key = `${q},${r},${pSteps},${pTicks},${cmdArmed ? activeCmdMode : -1}`;
  if (!force && key === lastHoverKey) return;
  lastHoverKey = key;

  const col = Math.min(9, Math.floor((q * 10) / W_COLS));
  const row = Math.min(5, Math.floor((r * 6) / W_ROWS));
  if (coordsHintEl) coordsHintEl.textContent = `${String.fromCharCode(65 + col)}${row + 1} (${q},${r})`;

  const len = wasm.w_inspect(q, r);
  const raw = len ? new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.w_popup_ptr(), len)) : "";
  const parts = raw.split("\n").filter(Boolean).map(escapeHtml);
  const imp = isImpassableHex(q, r);

  let html = parts.join(' <span class="hi-dim">│</span> ');
  if (imp) {
    html += ' <span class="hi-emp">⊘ 통행 불가</span>';
  } else if (pSteps > 0 && hoverHex && hoverHex[0] === q && hoverHex[1] === r) {
    const verb = CMD_NAMES[activeCmdMode];
    html += ` <span class="hi-dim">│</span> <span class="hi-brood">${verb} ${pSteps}헥스 · 예상 ${formatEtaTicks(pTicks)}</span>`;
  }
  hoverInfoEl.innerHTML = html || DEFAULT_HINT_HTML;
}

// ============================================================
// DOM 패널 동기화 (w_state_version이 바뀔 때만 실행)
// ============================================================
function syncPlayControls() {
  const halted = !!wasm.w_halted();
  if (btnPlay) {
    btnPlay.disabled = halted;
    btnPlay.classList.toggle("running", timePlaying);
    btnPlay.innerHTML = timePlaying ? '⏸ 일시정지<kbd>Space</kbd>' : '▶ 재생<kbd>Space</kbd>';
  }
  $("day").disabled = halted;
  $("until").disabled = halted;
  $("btn-refit").disabled = timePlaying || !wasm.w_in_supply();
}

function syncCmdModeButtons() {
  for (const b of document.querySelectorAll("#cmd-mode-wrap [data-mode]")) {
    const m = Number(b.dataset.mode);
    b.classList.toggle("active", m === activeCmdMode && !cmdArmed);
    b.classList.toggle("armed", m === activeCmdMode && cmdArmed);
  }
  updateModeUI();
}

function syncSpeedButtons() {
  for (const b of document.querySelectorAll("#speed-wrap [data-speed]")) {
    b.classList.toggle("active", Number(b.dataset.speed) === speedMul);
  }
}

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

  const hasClash = !!wasm.w_has_clash();
  syncPlayControls();

  const clashBar = $("clash-bar");
  const clashToggled = clashBar.hidden === hasClash;
  clashBar.hidden = !hasClash;
  if (hasClash) $("clash-msg").textContent = parts[6] ?? "적과 조우";
  if (clashToggled) setTimeout(() => { layout(); requestDraw(); }, 0);

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
      if (!timePlaying) { wasm.w_preview_proposal(idx); requestDraw(); }
    });
    div.addEventListener("mouseleave", () => {
      if (!timePlaying) { wasm.w_preview_proposal(-1); requestDraw(); }
    });
    div.querySelector(".jump").addEventListener("click", () => {
      wasm.w_preview_proposal(idx);
      if (view.overview) setOverview(false, [p.x, p.y]);
      else centerOn(p.x, p.y, true);
    });
    div.querySelector(".accept").addEventListener("click", () => {
      stopTime(false);
      if (wasm.w_accept_proposal(idx)) {
        sfx.uiClick();
        save.events.push(["p", idx]);
        persist();
        if (view.narrow) toggleSheet(false);
        spawnFx("pulse", p.x, p.y, PALETTE[3], 340);
        requestDraw();
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
      if (view.overview) setOverview(false, [Number(x), Number(y)]);
      else centerOn(Number(x), Number(y), true);
    });
    evBox.appendChild(btn);
  });

  renderRefitModal(parts[7] ?? "", parts[8] ?? "");
  renderBriefingModal(parts[9] ?? "");
  renderCampaignModal(parts[10] ?? "");
}

function renderBriefingModal(raw) {
  if (!briefingModal) return;
  if (!raw || wasm.w_victory()) {
    briefingModal.hidden = true;
    lastBriefingRaw = "";
    return;
  }
  briefingModal.hidden = false;
  if (raw === lastBriefingRaw) return;
  lastBriefingRaw = raw;
  const lines = raw.split("\n");
  const [wonStr, title, objLabel, survivors, kia, kills, bio, captured] = (lines[0] || "").split("|");
  const won = wonStr === "1";
  const tEl = $("brief-title");
  tEl.textContent = won ? `■ 작전 승리 — ${title}` : `■ 교전 종료 — ${title}`;
  tEl.className = won ? "brief-win" : "brief-loss";

  const promos = lines.slice(1).filter(Boolean);
  const promoHtml = promos.length
    ? promos.map((p) => `<div class="brief-promo">▲ ${p}</div>`).join("")
    : "";
  const capHtml = captured ? `<div class="brief-cap">◆ ${captured}</div>` : "";
  $("brief-content").innerHTML = `
    <div class="brief-stats">
      <span>목표<br><b>${objLabel}</b></span>
      <span>적 격파<br><b>${kills}</b></span>
      <span>생존 / 전사<br><b>${survivors} / ${kia}</b></span>
      <span>획득 생체질<br><b>+${bio}</b></span>
    </div>
    <div class="brief-body">
      ${capHtml}
      ${promoHtml || `<span style="color:var(--dim);font-size:12px;">대원들이 전투 경험을 축적했습니다.</span>`}
    </div>
  `;
}

function renderCampaignModal(raw) {
  if (!campaignModal) return;
  if (!raw || campaignDismissed) {
    campaignModal.hidden = true;
    return;
  }
  campaignModal.hidden = false;
  if (raw === lastCampaignRaw) return;
  lastCampaignRaw = raw;
  const lines = raw.split("\n");
  const [wonStr, day, bWon, bFought, kills, bSites, tSites, bio] = (lines[0] || "").split("|");
  const won = wonStr === "1";
  const tEl = $("camp-title");
  tEl.textContent = won ? "■ 전구 작전 승리 — 인류 본진 점령" : "■ 전구 작전 실패 — 특수부대 전멸";
  tEl.className = won ? "brief-win" : "brief-loss";
  if (won) sfx.victory();
  else sfx.defeat();

  const rosterHtml = lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [cs, rk, g, name, b, k, hp, maxHp] = line.split("\t");
      return `<div class="camp-row">
        <span style="color:var(--brood);font-weight:bold;width:1.2em;text-align:center">${g}</span>
        <span><b>${cs}</b> ${name} <span style="color:var(--fg)">[${rk}]</span></span>
        <span style="margin-left:auto;color:var(--dim)">${b}전 · ${k}처치 · HP ${hp}/${maxHp}</span>
      </div>`;
    })
    .join("");

  $("camp-content").innerHTML = `
    <div class="brief-stats">
      <span>경과 일수<br><b>D+${day}</b></span>
      <span>전술 승률<br><b>${bWon} / ${bFought}</b></span>
      <span>총 적 격파<br><b>${kills}</b></span>
      <span>점령 거점<br><b>${bSites} / ${tSites}</b></span>
      <span>보유 생체질<br><b>${bio}</b></span>
    </div>
    <div class="brief-body">
      <div style="color:var(--brood);font-weight:bold;font-size:12px;">■ 생존 특수부대 명부</div>
      <div>${rosterHtml || `<span style="color:var(--empire);font-size:12px;">생존 대원 없음</span>`}</div>
    </div>
  `;
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
    const [slotStr, glyph, name, pips, hpStr, battles, gidStr, callsign, rankLabel, kills, aimBonus] = line.split("\t");
    const slot = Number(slotStr);
    const gid = Number(gidStr);
    const row = document.createElement("div");
    row.className = "tr-row";
    const rkTag = rankLabel && rankLabel !== "신병" ? ` [${rankLabel}${Number(aimBonus) > 0 ? ` +${aimBonus}` : ""}]` : "";
    row.innerHTML = `
      <span class="tr-glyph">${glyph}</span>
      <span><b>${callsign || ""}</b> ${name}<small style="color:var(--brood)">${rkTag}</small></span>
      <span>${pips}</span>
      <span class="tr-meta">${hpStr} · ${battles}전 · ${kills || 0}처치</span>
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
            sfx.uiClick();
            save.events.push(["g", [slot, g.id]]);
            persist();
            requestDraw();
          }
        });
      }
      gWrap.appendChild(b);
    }
    list.appendChild(row);
  }
}

$("btn-refit").addEventListener("click", () => {
  if (!timePlaying && wasm.w_in_supply()) {
    sfx.uiClick();
    refitModal.hidden = false;
  }
});
$("refit-close").addEventListener("click", () => { refitModal.hidden = true; });
refitModal.addEventListener("click", (ev) => { if (ev.target === refitModal) refitModal.hidden = true; });
$("btn-heal").addEventListener("click", () => {
  if (wasm.w_heal_squad()) { sfx.regen(); save.events.push(["h", 0]); persist(); requestDraw(); }
});
$("btn-recruit").addEventListener("click", () => {
  if (wasm.w_recruit()) { sfx.select(); save.events.push(["r", 0]); persist(); requestDraw(); }
});

function closeBriefing() {
  briefingModal.hidden = true;
  lastBriefingRaw = "";
  wasm.w_clear_briefing();
  lastTextRaw = "";
  requestDraw();
}
$("brief-close").addEventListener("click", closeBriefing);
$("brief-ok").addEventListener("click", closeBriefing);
briefingModal.addEventListener("click", (ev) => { if (ev.target === briefingModal) closeBriefing(); });

$("camp-close").addEventListener("click", () => {
  campaignDismissed = true;
  campaignModal.hidden = true;
});
$("camp-new").addEventListener("click", () => {
  sfx.uiClick();
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
});

for (const id of ["btn-help", "b-btn-help"]) {
  if ($(id)) {
    $(id).addEventListener("click", (ev) => {
      ev.currentTarget.blur();
      sfx.uiClick();
      helpModal.hidden = !helpModal.hidden;
    });
  }
}
$("help-close").addEventListener("click", () => { helpModal.hidden = true; });
helpModal.addEventListener("click", (ev) => { if (ev.target === helpModal) helpModal.hidden = true; });

// ============================================================
// 명령 메뉴 & 즉시 명령 실행 (우클릭 1-클릭 행군)
// ============================================================
let lastMenuState = -1;
let lastMenuPos = "";
function placeMenu() {
  const m = timePlaying ? 0 : wasm.w_menu();
  if (!m) {
    if (lastMenuState !== 0) {
      lastMenuState = 0;
      lastMenuPos = "";
      menu.hidden = true;
      $("mob-cmd").classList.remove("open");
    }
    return;
  }
  const canGarrison = !!(m & 2);
  if (view.narrow) {
    if (lastMenuState !== m) {
      lastMenuState = m;
      menu.hidden = true;
      $("mob-cmd").querySelector('[data-cmd="2"]').disabled = !canGarrison;
      $("mob-cmd").classList.add("open");
    }
    return;
  }
  if (lastMenuState !== m) {
    lastMenuState = m;
    $("mob-cmd").classList.remove("open");
    menu.querySelector('[data-cmd="2"]').disabled = !canGarrison;
    menu.hidden = false;
  }
  const [dx, dy] = hexCenterDisp((m >>> 8) & 0xff, (m >>> 16) & 0xff);
  const px = view.rect.left + dx - view.camX;
  const py = view.rect.top + dy - view.camY;
  const posKey = `${Math.round(px)},${Math.round(py)}`;
  if (posKey === lastMenuPos) return;
  lastMenuPos = posKey;
  const mw = menu.offsetWidth || 210;
  const mh = menu.offsetHeight || 160;
  let left = px + view.R + 10;
  if (left + mw > window.innerWidth - 8) left = px - view.R - mw - 10;
  let top = py - 20;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function giveCommand(kind) {
  const m = wasm.w_menu();
  if (!wasm.w_command(kind)) return false;
  sfx.uiClick();
  save.events.push(["o", kind]);
  persist();
  cmdArmed = false;
  activeCmdMode = 0;
  syncCmdModeButtons();
  wasm.w_hover(-1, -1, 0);
  if (m) spawnFx("pulse", (m >>> 8) & 0xff, (m >>> 16) & 0xff, PALETTE[3], 360);
  requestDraw();
  return true;
}

// 우클릭(또는 무장 모드 클릭)으로 목적지에 1클릭 즉시 명령 (기존 세이브 리플레이 규격 100% 호환)
function issueInstantCommand(q, r, kind) {
  if (inBattle || wasm.w_halted()) return false;
  if (isImpassableHex(q, r)) {
    sfx.invalid();
    spawnFx("invalid", q, r, PALETTE[4], 380);
    return false;
  }
  const sp = wasm.w_special_pos();
  const spQ = sp & 0xff;
  const spR = (sp >>> 8) & 0xff;
  if (q === spQ && r === spR) return false;

  // 주둔(2)은 거점이 아니면 거부하고 흔들림 피드백
  if (kind === 2) {
    const hexes = new Uint32Array(wasm.memory.buffer, wasm.w_hex_ptr(), W_COLS * W_ROWS);
    const skind = (hexes[r * W_COLS + q] >>> 6) & 0xf;
    if (skind === 0) {
      sfx.invalid();
      spawnFx("invalid", q, r, PALETTE[4], 380);
      return false;
    }
  }

  if (wasm.w_select_special()) {
    save.events.push(["s", 0]);
  }
  if (!wasm.w_click(q, r)) {
    sfx.invalid();
    spawnFx("invalid", q, r, PALETTE[4], 380);
    return false;
  }
  save.events.push([q, r]);

  if (!wasm.w_command(kind)) {
    // 실패 시 선택 해제 복원
    if (wasm.w_click(spQ, spR)) save.events.push([spQ, spR]);
    sfx.invalid();
    spawnFx("invalid", q, r, PALETTE[4], 380);
    persist();
    requestDraw();
    return false;
  }
  save.events.push(["o", kind]);
  persist();
  sfx.uiClick();
  inspectedHex = null;
  cmdArmed = false;
  activeCmdMode = 0;
  syncCmdModeButtons();
  wasm.w_hover(-1, -1, 0);
  spawnFx("pulse", q, r, PALETTE[3], 360);
  requestDraw();
  return true;
}

function armCommandMode(mode) {
  if (inBattle || wasm.w_halted()) return;
  if (cmdArmed && activeCmdMode === mode) {
    cmdArmed = false;
    activeCmdMode = 0;
    wasm.w_hover(-1, -1, 0);
  } else {
    activeCmdMode = mode;
    cmdArmed = true;
    if (hoverHex) wasm.w_hover(hoverHex[0], hoverHex[1], 2);
  }
  sfx.uiClick();
  syncCmdModeButtons();
  refreshHoverBar(true);
  requestDraw();
}

for (const b of document.querySelectorAll("[data-cmd]")) {
  b.addEventListener("click", () => giveCommand(Number(b.dataset.cmd)));
}
for (const b of document.querySelectorAll("#cmd-mode-wrap [data-mode]")) {
  b.addEventListener("click", (ev) => {
    ev.currentTarget.blur();
    armCommandMode(Number(b.dataset.mode));
  });
}

// ============================================================
// 세이브 & 실시간 시간 진행 컨트롤러
// ============================================================
function persist() {
  dirtySave = false;
  save.fp = wasm.w_fingerprint_lo();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {}
}

function noteTicks(done) {
  if (!done) return;
  const tail = save.events[save.events.length - 1];
  if (Array.isArray(tail) && tail[0] === "t") tail[1] += done;
  else save.events.push(["t", done]);
}

function startTime(mode) {
  if (inBattle || wasm.w_halted()) return;
  timeMode = mode;
  if (mode === "day") {
    dayTicksLeft = wasm.w_ticks_left_today();
  }
  timePlaying = true;
  tickAccumMs = 999; // 누르자마자 첫 틱 즉시 반응
  sfx.dayTick();
  syncPlayControls();
  requestDraw();
}

function stopTime(fromAutoStop = false) {
  if (!timePlaying) return;
  timePlaying = false;
  tickAccumMs = 0;
  if (dirtySave) persist();
  if (fromAutoStop && wasm.w_has_clash()) sfx.clashAlert();
  syncPlayControls();
  requestDraw();
}

function togglePlay() {
  if (timePlaying) stopTime(false);
  else startTime("play");
}

function passDay() {
  if (timePlaying && timeMode === "day") return;
  startTime("day");
}

function passUntilEvent() {
  if (timePlaying && timeMode === "until") {
    stopTime(false);
    return;
  }
  startTime("until");
}

for (const b of document.querySelectorAll("#speed-wrap [data-speed]")) {
  b.addEventListener("click", (ev) => {
    ev.currentTarget.blur();
    speedMul = Number(b.dataset.speed);
    sfx.uiClick();
    syncSpeedButtons();
  });
}
if (btnPlay) btnPlay.addEventListener("click", (ev) => { ev.currentTarget.blur(); togglePlay(); });
$("day").addEventListener("click", (ev) => { ev.currentTarget.blur(); passDay(); });
$("until").addEventListener("click", (ev) => { ev.currentTarget.blur(); passUntilEvent(); });

function focusAndSelectSpecial() {
  sfx.select();
  if (wasm.w_select_special()) {
    save.events.push(["s", 0]);
    persist();
  }
  const sp = wasm.w_special_pos();
  const sq = sp & 0xff;
  const sr = (sp >>> 8) & 0xff;
  inspectedHex = null;
  if (view.overview) setOverview(false, [sq, sr]);
  else centerOn(sq, sr, true);
  spawnFx("pulse", sq, sr, PALETTE[3], 360);
  requestDraw();
}

function deselectSpecial() {
  if (inBattle) return false;
  let did = false;
  if (cmdArmed) {
    cmdArmed = false;
    activeCmdMode = 0;
    syncCmdModeButtons();
    did = true;
  }
  const sp = wasm.w_special_pos();
  if (sp & (1 << 16)) {
    const sq = sp & 0xff;
    const sr = (sp >>> 8) & 0xff;
    if (wasm.w_click(sq, sr)) {
      save.events.push([sq, sr]);
      persist();
    }
    did = true;
  }
  if (!did) return false;
  wasm.w_hover(-1, -1, 0);
  sfx.uiClick();
  refreshHoverBar(true);
  requestDraw();
  return true;
}

function newGame(seed) {
  stopTime(false);
  save = { v: SAVE_VERSION, seed, events: [] };
  wasm.w_init(seed);
  persist();
  hoverHex = null;
  inspectedHex = null;
  cmdArmed = false;
  activeCmdMode = 0;
  campaignDismissed = false;
  lastCampaignRaw = "";
  lastBriefingRaw = "";
  briefingModal.hidden = true;
  campaignModal.hidden = true;
  lastTextRaw = "";
  lastStateVer = -1;
  cachedStaticVer = -1;
  syncCmdModeButtons();
  const sp = wasm.w_special_pos();
  view.R = 20;
  view.savedZoomR = 20;
  view.overview = false;
  layout();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff, false);
  requestDraw();
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
    else if (e[0] === "b") {
      wasm.w_apply_battle_ext(
        e[1][0] | 0,
        e[1][1] | 0,
        e[1][2] | 0,
        e[1][3] >>> 0,
        (e[1][4] || 0) >>> 0,
      );
    } else wasm.w_click(e[0] | 0, e[1] | 0);
  }
  if (data.fp !== undefined && data.fp !== wasm.w_fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  wasm.w_clear_briefing();
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

function showMobilePop(q, r, clientX, clientY) {
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

function hexTerrain(q, r) {
  if (q < 0 || r < 0 || q >= W_COLS || r >= W_ROWS) return 4;
  const hexes = new Uint32Array(wasm.memory.buffer, wasm.w_hex_ptr(), W_COLS * W_ROWS);
  return hexes[r * W_COLS + q] & 0x7;
}

function isImpassableHex(q, r) {
  const t = hexTerrain(q, r);
  return t === 3 || t === 4;
}

// ============================================================
// 포인터 입력 (표준 전략 게임 조작: 좌드래그 항상 팬 · 우클릭 즉시 행군 · 핀치/휠 커서 줌)
// ============================================================
const pointers = new Map();
let dragState = null;
let pinchState = null;
let holdTimer = 0;

canvas.addEventListener("pointerdown", (ev) => {
  refreshCanvasRect();
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  clearTimeout(holdTimer);
  panVel.vx = 0;
  panVel.vy = 0;
  camGlide = null;

  if (pointers.size === 2) {
    dragState = null;
    canvas.classList.remove("panning");
    const pts = [...pointers.values()];
    pinchState = {
      dist: Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      startR: view.R,
    };
    return;
  }
  if (pointers.size !== 1) return;

  dragState = {
    button: ev.button,
    x: ev.clientX,
    y: ev.clientY,
    startX: ev.clientX,
    startY: ev.clientY,
    lastTime: performance.now(),
    vx: 0,
    vy: 0,
    moved: false,
    held: false,
  };

  if (ev.pointerType !== "mouse") {
    holdTimer = setTimeout(() => {
      if (dragState && !dragState.moved) {
        const [hq, hr] = hexAtClient(ev.clientX, ev.clientY);
        showMobilePop(hq, hr, ev.clientX, ev.clientY);
        dragState.held = true;
      }
    }, HOLD_MS);
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  // 두 손가락 연속 핀치 줌
  if (pointers.size === 2 && pinchState) {
    const pts = [...pointers.values()];
    const d = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
    const midX = (pts[0].x + pts[1].x) / 2 - view.rect.left;
    const midY = (pts[0].y + pts[1].y) / 2 - view.rect.top;
    zoomAtScreenPoint(pinchState.startR * (d / pinchState.dist), midX, midY);
    return;
  }

  // 드래그 팬 (좌/중/우 버튼 모두 드래그하면 부드럽게 팬!)
  if (dragState) {
    const dx = ev.clientX - dragState.x;
    const dy = ev.clientY - dragState.y;
    const now = performance.now();
    const dt = Math.max(0.004, (now - dragState.lastTime) / 1000);
    if (!dragState.moved && Math.hypot(ev.clientX - dragState.startX, ev.clientY - dragState.startY) > 5) {
      dragState.moved = true;
      clearTimeout(holdTimer);
      hidePop();
      canvas.classList.add("panning");
    }
    if (dragState.moved && !view.overview) {
      view.camX -= dx;
      view.camY -= dy;
      clampCam();
      const ivx = -dx / dt;
      const ivy = -dy / dt;
      dragState.vx = dragState.vx * 0.55 + ivx * 0.45;
      dragState.vy = dragState.vy * 0.55 + ivy * 0.45;
      requestDraw();
    }
    dragState.x = ev.clientX;
    dragState.y = ev.clientY;
    dragState.lastTime = now;
    return;
  }

  // 마우스 호버 (헥스가 바뀔 때만 경량 A* 미리보기 + 하단 바 갱신!)
  if (ev.pointerType === "mouse") {
    const [q, r] = hexAtClient(ev.clientX, ev.clientY);
    if (q >= 0 && r >= 0 && q < W_COLS && r < W_ROWS) {
      const changed = !hoverHex || hoverHex[0] !== q || hoverHex[1] !== r;
      if (!changed) return;
      hoverHex = [q, r];
      const spSelected = !!(wasm.w_special_pos() & (1 << 16));
      if (cmdArmed) {
        wasm.w_hover(q, r, 2);
      } else if (spSelected) {
        wasm.w_hover(q, r, 0);
      } else {
        wasm.w_hover(-1, -1, 0);
      }
      refreshHoverBar();
      requestDraw();
    } else if (hoverHex) {
      hoverHex = null;
      wasm.w_hover(-1, -1, 0);
      refreshHoverBar();
      requestDraw();
    }
  }
});

canvas.addEventListener("pointerup", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchState = null;
  const st = dragState;
  dragState = null;
  canvas.classList.remove("panning");

  if (!st) return;

  // 드래그 팬 종료 시 관성 부여
  if (st.moved) {
    if (!stillness.matches && !view.overview && performance.now() - st.lastTime < 80) {
      const maxV = 1800;
      panVel.vx = Math.max(-maxV, Math.min(maxV, st.vx));
      panVel.vy = Math.max(-maxV, Math.min(maxV, st.vy));
      requestDraw();
    }
    return;
  }
  if (st.held) {
    if (ev.pointerType !== "mouse") hidePop();
    return;
  }
  if (ev.button === 1) return;

  const [q, r] = hexAtClient(ev.clientX, ev.clientY);
  if (q < 0 || r < 0 || q >= W_COLS || r >= W_ROWS) return;

  const sp = wasm.w_special_pos();
  const spQ = sp & 0xff;
  const spR = (sp >>> 8) & 0xff;
  const spSelected = !!(sp & (1 << 16));

  // 우클릭 처리: 메뉴가 열려있거나 자기 칸이면 취소/선택 해제, Shift+우클릭은 메뉴, 일반 우클릭은 즉시 1-클릭 행군!
  if (ev.button === 2) {
    if (wasm.w_menu() || (spSelected && q === spQ && r === spR)) {
      deselectSpecial();
      return;
    }
    if (ev.shiftKey) {
      if (isImpassableHex(q, r)) {
        sfx.invalid();
        spawnFx("invalid", q, r, PALETTE[4], 380);
        return;
      }
      if (wasm.w_select_special()) save.events.push(["s", 0]);
      if (wasm.w_click(q, r)) {
        save.events.push([q, r]);
        persist();
        sfx.uiClick();
        spawnFx("pulse", q, r, PALETTE[3], 320);
        requestDraw();
      }
      return;
    }
    issueInstantCommand(q, r, activeCmdMode);
    return;
  }

  // 좌클릭 처리
  if (cmdArmed) {
    issueInstantCommand(q, r, activeCmdMode);
    return;
  }

  // 광역 뷰에서 클릭하면 해당 지점으로 부드럽게 확대 (특수부대/명령 무장 없을 때)
  if (view.overview && !spSelected) {
    setOverview(false, [q, r]);
    return;
  }

  // 선택 중 통행 불가 클릭 시 ⊘ 흔들림 피드백
  if (spSelected && isImpassableHex(q, r)) {
    sfx.invalid();
    spawnFx("invalid", q, r, PALETTE[4], 380);
    return;
  }

  const changed = wasm.w_click(q, r);
  if (changed) {
    sfx.select();
    save.events.push([q, r]);
    persist();
    inspectedHex = null;
    spawnFx("pulse", q, r, PALETTE[3], 340);
  } else {
    sfx.uiClick();
    inspectedHex = [q, r];
    spawnFx("pulse", q, r, PALETTE[2], 260);
    refreshHoverBar(true);
  }
  requestDraw();
});

canvas.addEventListener("pointercancel", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  dragState = null;
  pinchState = null;
  canvas.classList.remove("panning");
  hidePop();
});

canvas.addEventListener("pointerleave", (ev) => {
  if (ev.pointerType === "mouse") {
    hoverHex = null;
    wasm.w_hover(-1, -1, 0);
    refreshHoverBar();
    requestDraw();
  }
});

canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
menu.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  deselectSpecial();
});

// 커서 기준 부드러운 연속 휠 줌 (canvas.width 재할당 없음!)
canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const factor = Math.max(0.76, Math.min(1.3, Math.exp(-ev.deltaY * 0.0018)));
    const mx = ev.clientX - view.rect.left;
    const my = ev.clientY - view.rect.top;
    zoomAtScreenPoint(view.R * factor, mx, my);
  },
  { passive: false },
);

// ============================================================
// 미니맵 클릭·드래그 점프
// ============================================================
if (minimapEl) {
  let miniDragging = false;
  const jumpFromMini = (clientX, clientY) => {
    const r = minimapEl.getBoundingClientRect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const { offX, offY, drawW, drawH } = miniLayout;
    const u = Math.max(0, Math.min(1, (mx - offX) / drawW));
    const v = Math.max(0, Math.min(1, (my - offY) / drawH));
    if (view.overview) {
      view.R = Math.max(view.minR + 2, view.savedZoomR || 20);
      syncWorldDims();
      updateModeUI();
    }
    panVel.vx = 0;
    panVel.vy = 0;
    camGlide = null;
    view.camX = u * view.worldW - view.cssW / 2;
    view.camY = v * view.worldH - view.cssH / 2;
    clampCam();
    requestDraw();
  };
  minimapEl.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    minimapEl.setPointerCapture(ev.pointerId);
    miniDragging = true;
    jumpFromMini(ev.clientX, ev.clientY);
  });
  minimapEl.addEventListener("pointermove", (ev) => {
    if (!miniDragging) return;
    ev.stopPropagation();
    jumpFromMini(ev.clientX, ev.clientY);
  });
  minimapEl.addEventListener("pointerup", (ev) => {
    miniDragging = false;
    ev.stopPropagation();
  });
  minimapEl.addEventListener("pointercancel", () => { miniDragging = false; });
  if (minimapWrap) {
    minimapWrap.addEventListener("contextmenu", (ev) => ev.preventDefault());
    minimapWrap.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }
}

// ============================================================
// 모바일 서랍 & 상단 버튼
// ============================================================
function toggleSheet(open) {
  sheetOpen = open;
  $("side").classList.toggle("open", sheetOpen);
  $("sheet-arrow").textContent = sheetOpen ? "▼" : "▲";
  updateMobTabs();
  setTimeout(() => { layout(); requestDraw(); }, 20);
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
$("mob-cmd-cancel").addEventListener("click", () => deselectSpecial());

$("btn-overview").addEventListener("click", (ev) => { ev.currentTarget.blur(); setOverview(!view.overview); });
$("fab-overview").addEventListener("click", () => setOverview(!view.overview));
$("btn-squad").addEventListener("click", (ev) => { ev.currentTarget.blur(); focusAndSelectSpecial(); });
$("btn-select-sp").addEventListener("click", (ev) => { ev.currentTarget.blur(); focusAndSelectSpecial(); });
$("fab-squad").addEventListener("click", focusAndSelectSpecial);
$("new").addEventListener("click", (ev) => {
  ev.currentTarget.blur();
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
});

// ============================================================
// 통합 전술 전투 뷰 (battle_view.js 공용 모듈 위임)
// ============================================================
const bRosterModal = $("b-roster-modal");

const battle = createBattleView({
  wasm,
  canvas: $("b-screen"),
  mainEl: $("b-main"),
  popEl: pop,
  rosterModal: bRosterModal,
  rosterList: $("b-roster-list"),
  els: {
    status: $("b-status"),
    objectiveEl: $("b-objective-bar"),
    hudEl: $("b-hud"),
    targetList: $("b-target-list"),
    readoutDetail: $("b-readout-detail"),
    readoutResult: $("b-readout-result"),
    aimActions: $("b-aim-actions"),
    fireBtn: $("b-btn-fire"),
    cancelAimBtn: $("b-btn-cancel-aim"),
    unitBadge: $("b-unit-badge"),
    prevUnitBtn: $("b-btn-prev-unit"),
    nextUnitBtn: $("b-btn-next-unit"),
    attackBtn: $("b-act-attack"),
    attackCount: $("b-attack-count"),
    overwatchBtn: $("b-act-overwatch"),
    hunkerBtn: $("b-act-hunker"),
    grenadeBtn: $("b-act-grenade"),
    grenadeCount: $("b-grenade-count"),
    skillBtn: $("b-act-skill"),
    skillLabel: $("b-skill-label"),
    retreatBtn: $("b-act-retreat"),
    confirmBtn: $("b-confirm"),
    endBtn: $("b-end"),
    headerEl: $("b-header"),
    aiNoteEl: $("b-ai-note"),
    returnBtn: $("b-return"),
  },
  isActive: () => inBattle,
});

function battleLayout() { battle.layout(); }
function battleDraw() { battle.draw(); }

function enterBattle() {
  if (inBattle || !wasm.w_has_clash()) return;
  stopTime(false);
  if (!wasm.w_enter_battle()) return;
  sfx.uiClick();
  hidePop();
  keysHeld.clear();
  refitModal.hidden = true;
  briefingModal.hidden = true;
  helpModal.hidden = true;
  menu.hidden = true;
  inBattle = true;
  battle.reset();
  battle.ensureSelected();
  $("app").hidden = true;
  $("battle-app").hidden = false;
  battle.layout();
  battle.draw();
}

function finishBattleAndReturn() {
  if (!inBattle || battle.isPlaying() || !wasm.battle_done()) return;
  if (!wasm.w_finish_battle()) return;
  const record = [
    wasm.w_last_battle_word(0),
    wasm.w_last_battle_word(1),
    wasm.w_last_battle_word(2),
    wasm.w_last_battle_word(3) >>> 0,
    wasm.w_last_battle_word(4) >>> 0,
  ];
  save.events.push(["b", record]);
  persist();
  inBattle = false;
  bRosterModal.hidden = true;
  battle.hidePop();
  hidePop();
  $("battle-app").hidden = true;
  $("app").hidden = false;
  lastTextRaw = "";
  lastBriefingRaw = "";
  lastStateVer = -1;
  layout();
  const sp = wasm.w_special_pos();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff, false);
  requestDraw();
}

$("btn-enter-battle").addEventListener("click", enterBattle);
$("b-return").addEventListener("click", finishBattleAndReturn);
$("b-btn-roster").addEventListener("click", (ev) => { ev.currentTarget.blur(); sfx.uiClick(); bRosterModal.hidden = !bRosterModal.hidden; });
$("b-roster-close").addEventListener("click", () => { bRosterModal.hidden = true; });
bRosterModal.addEventListener("click", (ev) => { if (ev.target === bRosterModal) bRosterModal.hidden = true; });

// ============================================================
// 키보드 입력 (WASD 60fps 연속 이동 + 재생/배속 + 1~4 명령 모드)
// ============================================================
const PAN_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

document.addEventListener("keydown", (ev) => {
  if (ev.key === "?" || (ev.code === "Slash" && ev.shiftKey)) {
    ev.preventDefault();
    helpModal.hidden = !helpModal.hidden;
    return;
  }
  if (!helpModal.hidden) {
    if (ev.code === "Escape") helpModal.hidden = true;
    return;
  }

  if (inBattle) {
    if (ev.code === "KeyU") { ev.preventDefault(); bRosterModal.hidden = !bRosterModal.hidden; return; }
    if (ev.code === "Escape" && !bRosterModal.hidden) { bRosterModal.hidden = true; return; }
    if (!bRosterModal.hidden) return;
    if (wasm.battle_done() && (ev.code === "Space" || ev.code === "Enter")) {
      ev.preventDefault();
      finishBattleAndReturn();
      return;
    }
    battle.handleKey(ev);
    return;
  }

  if (!briefingModal.hidden) {
    if (ev.code === "Escape" || ev.code === "Enter" || ev.code === "Space") {
      ev.preventDefault();
      closeBriefing();
    }
    return;
  }
  if (!campaignModal.hidden) {
    if (ev.code === "Escape") {
      campaignDismissed = true;
      campaignModal.hidden = true;
    }
    return;
  }

  if (ev.code === "Escape") {
    if (!refitModal.hidden) { refitModal.hidden = true; return; }
    if (deselectSpecial()) return;
    if (timePlaying) { stopTime(false); return; }
  }
  if (!refitModal.hidden) return;
  if (ev.target instanceof HTMLButtonElement && ev.code === "Space") return;

  if (PAN_KEYS.has(ev.code)) {
    keysHeld.add(ev.code);
    if (!ev.code.startsWith("Shift")) {
      ev.preventDefault();
      requestDraw();
    }
    return;
  }

  const pick = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(ev.code);
  if (pick >= 0) {
    ev.preventDefault();
    if (!menu.hidden) giveCommand(pick);
    else armCommandMode(pick);
    return;
  }

  if (ev.code === "KeyG" && !timePlaying && wasm.w_in_supply()) {
    ev.preventDefault();
    refitModal.hidden = false;
  } else if (ev.code === "KeyM" || ev.code === "Tab") {
    ev.preventDefault();
    setOverview(!view.overview);
  } else if (ev.code === "KeyF") {
    ev.preventDefault();
    focusAndSelectSpecial();
  } else if (ev.code === "KeyN") {
    ev.preventDefault();
    passDay();
  } else if (ev.code === "Minus" || ev.code === "BracketLeft") {
    speedMul = speedMul === 4 ? 2 : 1;
    syncSpeedButtons();
  } else if (ev.code === "Equal" || ev.code === "BracketRight") {
    speedMul = speedMul === 1 ? 2 : 4;
    syncSpeedButtons();
  } else if (ev.code === "Space" || ev.code === "Enter") {
    ev.preventDefault();
    if (wasm.w_has_clash()) enterBattle();
    else if (ev.shiftKey) passUntilEvent();
    else togglePlay();
  }
});

document.addEventListener("keyup", (ev) => {
  keysHeld.delete(ev.code);
});

window.addEventListener("blur", () => {
  keysHeld.clear();
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { updateMobTabs(); layout(); requestDraw(); }, 80);
});

// 초기화
syncSpeedButtons();
syncCmdModeButtons();
updateMobTabs();
layout();
try {
  load(JSON.parse(localStorage.getItem(SAVE_KEY)));
  const sp = wasm.w_special_pos();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff, false);
  requestDraw();
} catch {
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
}
