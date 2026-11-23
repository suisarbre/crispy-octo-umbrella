// 80×52 육각(Hex) 월드 + 통합 전술 전투 화면.
// 문명식 육각 지형·영토 경계·도로망(스크롤/다단계 줌/전체 보기/모바일 90도 회전),
// 지휘망 1+2 제안, 보급권 정비/개조, 충돌 시 실제 전술 전투 진입과 복귀를 담당한다.
import { createBattleView } from "./battle_view.js";

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

// 실시간 인터랙션 리액션 상태 (호버/드래그/클릭 펄스/불가 흔들림)
let hoverHex = null;       // [q, r] 현재 가리키거나 드래그 중인 헥스
let inspectedHex = null;   // [q, r] 비선택 상태에서 마지막으로 조사 클릭한 헥스
let draggingTarget = false;
let fxList = [];           // { kind: 'pulse'|'invalid', q, r, color, start, dur }
let fxRaf = 0;

function spawnFx(kind, q, r, color, dur = 340) {
  if (stillness.matches) return;
  fxList.push({ kind, q, r, color, start: performance.now(), dur });
  if (!fxRaf) fxRaf = requestAnimationFrame(stepFx);
}

function stepFx() {
  fxRaf = 0;
  const now = performance.now();
  fxList = fxList.filter((f) => now - f.start < f.dur);
  if (!inBattle) draw();
  if (fxList.length > 0) fxRaf = requestAnimationFrame(stepFx);
}

// odd-q 헥스 6방향 이웃 (sim/src/world.rs hex_neighbors와 동일)
function hexNeighbors(q, r) {
  return (q & 1) === 0
    ? [[q + 1, r - 1], [q + 1, r], [q, r + 1], [q - 1, r], [q - 1, r - 1], [q, r - 1]]
    : [[q + 1, r], [q + 1, r + 1], [q, r + 1], [q - 1, r + 1], [q - 1, r], [q, r - 1]];
}

function drawHexPath(cx, cy, verts, scale = 1) {
  ctx.beginPath();
  ctx.moveTo(cx + verts[0][0] * scale, cy + verts[0][1] * scale);
  for (let i = 1; i < 6; i++) ctx.lineTo(cx + verts[i][0] * scale, cy + verts[i][1] * scale);
  ctx.closePath();
}

// 통행 불가(산맥): 대각선 사선 해칭 + 뚜렷한 쌍봉 실루엣 + 밝은 능선 하이라이트
function drawMountainSymbol(cx, cy, R, verts) {
  ctx.save();
  drawHexPath(cx, cy, verts, 0.94);
  ctx.clip();
  // 45도 통행 불가 사선 패턴
  ctx.strokeStyle = "#141b20";
  ctx.lineWidth = Math.max(1, R * 0.08);
  const step = Math.max(4, R * 0.34);
  ctx.beginPath();
  for (let o = -R * 2; o <= R * 2; o += step) {
    ctx.moveTo(cx + o - R, cy - R);
    ctx.lineTo(cx + o + R, cy + R);
  }
  ctx.stroke();

  // 쌍봉 산맥 실루엣
  const s = R * 0.56;
  ctx.fillStyle = "#3c4b53";
  ctx.beginPath();
  ctx.moveTo(cx - s * 1.15, cy + s * 0.65);
  ctx.lineTo(cx - s * 0.35, cy - s * 0.72);
  ctx.lineTo(cx + s * 0.15, cy + s * 0.12);
  ctx.lineTo(cx + s * 0.52, cy - s * 0.48);
  ctx.lineTo(cx + s * 1.15, cy + s * 0.65);
  ctx.closePath();
  ctx.fill();

  // 밝은 능선 크레스트 (어두운 바탕에서 산맥 윤곽이 즉시 분리됨)
  ctx.strokeStyle = "#95a7b0";
  ctx.lineWidth = Math.max(1.2, R * 0.09);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.95, cy + s * 0.42);
  ctx.lineTo(cx - s * 0.35, cy - s * 0.72);
  ctx.lineTo(cx + s * 0.12, cy + s * 0.08);
  ctx.lineTo(cx + s * 0.52, cy - s * 0.48);
  ctx.lineTo(cx + s * 0.95, cy + s * 0.42);
  ctx.stroke();
  ctx.restore();
}

// 숲: 은밀한 3그루 침엽수 클러스터 실루엣
function drawForestSymbol(cx, cy, R) {
  const s = R * 0.25;
  const pts = [
    [cx - s * 1.15, cy + s * 0.55],
    [cx + s * 1.15, cy + s * 0.55],
    [cx, cy - s * 0.75],
  ];
  ctx.fillStyle = "#2d5d4d";
  for (const [tx, ty] of pts) {
    ctx.beginPath();
    ctx.moveTo(tx, ty - s * 1.05);
    ctx.lineTo(tx + s * 0.85, ty + s * 0.65);
    ctx.lineTo(tx - s * 0.85, ty + s * 0.65);
    ctx.closePath();
    ctx.fill();
  }
}

// 고지: 부드러운 이중 등고선 호 (산맥 뾰족봉과 확연히 구분됨)
function drawHillSymbol(cx, cy, R) {
  const s = R * 0.45;
  ctx.strokeStyle = "#5c6d76";
  ctx.lineWidth = Math.max(1.2, R * 0.08);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.55, s * 0.95, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.strokeStyle = "#414f57";
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.95, s * 0.65, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
}

// 통행 불가 ⊘ 아이콘 (글자 없이 즉각적으로 '갈 수 없음'을 전달)
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

function draw() {
  if (inBattle) {
    battleDraw();
    return;
  }
  const hexes = new Uint32Array(wasm.memory.buffer, wasm.w_hex_ptr(), W_COLS * W_ROWS);
  const { R, camX, camY, cssW, cssH, overview } = view;
  const verts = hexVertsOffset(R);

  // 불모 해역 바탕 (깊은 암흑)
  ctx.fillStyle = "#050708";
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

  // 패스 1: 헥스 바탕(지형·영토 색조) + 육각 그리드 + 산맥 내부 해칭/봉우리
  ctx.lineWidth = overview ? 0.5 : 1;
  for (let r = rMin; r <= rMax; r++) {
    for (let q = qMin; q <= qMax; q++) {
      const h = hexes[r * W_COLS + q];
      const terr = h & 0x7;
      const [dx, dy] = hexCenterDisp(q, r);
      const cx = dx - camX;
      const cy = dy - camY;
      if (cx < -R * 1.5 || cx > cssW + R * 1.5 || cy < -R * 1.5 || cy > cssH + R * 1.5) continue;

      if (terr === 4) {
        // 불모 해역: 전술 뷰에서 은은한 수평 파형 눈금으로 '진입 불가 해역'임을 암시
        if (!overview && (q + r) % 2 === 0) {
          ctx.strokeStyle = "#10171b";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx - R * 0.28, cy);
          ctx.lineTo(cx + R * 0.28, cy);
          ctx.stroke();
        }
        continue;
      }

      const owner = (h >>> 4) & 0x3;
      const inSup = !!(h & (1 << 12));
      const selected = !!(h & (1 << 28));
      const isTarget = !!(h & (1 << 29));

      drawHexPath(cx, cy, verts);
      if (terr === 3) {
        // 산맥: 전체 보기에서도 지형 벽이 확 드러나는 밝은 슬레이트 톤
        ctx.fillStyle = overview ? "#38464e" : "#243037";
      } else if (owner === 1) {
        ctx.fillStyle = terr === 1 ? "#122921" : terr === 2 ? "#162925" : "#11231d";
      } else if (owner === 2) {
        ctx.fillStyle = terr === 1 ? "#241913" : terr === 2 ? "#281c15" : "#221610";
      } else if (terr === 1) {
        ctx.fillStyle = overview ? "#142921" : "#0e1f19"; // 숲
      } else if (terr === 2) {
        ctx.fillStyle = overview ? "#1f272d" : "#181f24"; // 고지
      } else {
        ctx.fillStyle = "#0c0f11"; // 평지
      }
      ctx.fill();

      if (overview && terr === 3) {
        // 전체 보기 산맥 능선 하이라이트 점
        ctx.fillStyle = "#6c7f89";
        ctx.fillRect(cx - 1.2, cy - 1.2, 2.4, 2.4);
      }

      if (!overview) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = selected || isTarget ? PALETTE[3] : terr === 3 ? "#394850" : inSup ? "#223b34" : "#1b2429";
        ctx.stroke();
      }
    }
  }

  // 패스 1.5: 산맥·해역 경계 능선 테두리 (통행 가능 지형과 통행 불가 장벽을 칼같이 분리)
  if (!overview) {
    ctx.lineCap = "round";
    for (let r = rMin; r <= rMax; r++) {
      for (let q = qMin; q <= qMax; q++) {
        const h = hexes[r * W_COLS + q];
        const terr = h & 0x7;
        if (terr !== 3 && terr !== 4) continue;
        const [dx, dy] = hexCenterDisp(q, r);
        const cx = dx - camX;
        const cy = dy - camY;
        if (cx < -R * 1.5 || cx > cssW + R * 1.5 || cy < -R * 1.5 || cy > cssH + R * 1.5) continue;
        const nbs = hexNeighbors(q, r);
        ctx.strokeStyle = terr === 3 ? "#627680" : "#1f2e36";
        ctx.lineWidth = terr === 3 ? 2.2 : 1.5;
        ctx.beginPath();
        for (let d = 0; d < 6; d++) {
          const [nq, nr] = nbs[d];
          if (nq < 0 || nr < 0 || nq >= W_COLS || nr >= W_ROWS) continue;
          const nt = hexes[nr * W_COLS + nq] & 0x7;
          if (nt <= 2) {
            const v1 = verts[(d + 5) % 6];
            const v2 = verts[d];
            ctx.moveTo(cx + v1[0], cy + v1[1]);
            ctx.lineTo(cx + v2[0], cy + v2[1]);
          }
        }
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

  // 패스 3: 전략 도로망 (이중 레이어: 어두운 외곽 + 선명한 중앙선)
  const drawRoadPass = (stroke, width) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
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
  };
  if (overview) {
    drawRoadPass("#596c74", 1.1);
  } else {
    drawRoadPass("#161f24", Math.max(3.6, R * 0.22));
    drawRoadPass("#7c8e96", Math.max(1.8, R * 0.11));
  }

  // 패스 4: 이동 경로 & 흐르는 빛 펄스 & 하루 경계 눈금
  drawRoutes();

  // 패스 5: 지형 실루엣(산맥/숲/고지/평지), 거점 시설, 부대 마커
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

      // 전술 헥스 뷰: 먼저 바닥 지형 실루엣 (산맥은 항상 그림)
      if (terr === 3) {
        drawMountainSymbol(cx, cy, R, verts);
        continue;
      }

      if (selected || isTarget) {
        drawHexPath(cx, cy, verts, 0.92);
        ctx.fillStyle = PALETTE[3];
        ctx.fill();
      } else if (skind === 0 && fmark === 0) {
        if (terr === 1) drawForestSymbol(cx, cy, R);
        else if (terr === 2) drawHillSymbol(cx, cy, R);
        else {
          ctx.fillStyle = "#263137";
          ctx.fillText("·", cx, cy + 1);
        }
        continue;
      }

      if (fmark === 6) {
        ctx.fillStyle = PALETTE[4];
        drawHexPath(cx, cy, verts, 0.92);
        ctx.fill();
        ctx.fillStyle = PALETTE[0];
        ctx.fillText("×", cx, cy + 1);
      } else if (skind > 0) {
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
      }
    }
  }

  // 패스 6: 인터랙션 오버레이 (조사 테두리, 실시간 호버/드래그 레티클, 통행 불가 ⊘, 펄스/흔들림 리액션)
  if (!overview) {
    drawInteractionOverlays(hexes, verts);
    drawLabels();
    drawSectorCoords();
  } else {
    drawOverviewOverlays();
  }

  syncTextAndPanels();
  placeMenu();
}

function drawInteractionOverlays(hexes, verts) {
  const { R, camX, camY } = view;
  const spPos = wasm.w_special_pos();
  const spQ = spPos & 0xff;
  const spR = (spPos >>> 8) & 0xff;
  const spSelected = !!(spPos & (1 << 16));

  // 1. 비선택 조사 클릭 테두리
  if (!spSelected && inspectedHex) {
    const [iq, ir] = inspectedHex;
    const [dx, dy] = hexCenterDisp(iq, ir);
    drawHexPath(dx - camX, dy - camY, verts, 0.96);
    ctx.strokeStyle = PALETTE[2];
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // 2. 특수부대 선택 시 활성 외곽 링
  if (spSelected) {
    const [sdx, sdy] = hexCenterDisp(spQ, spR);
    drawHexPath(sdx - camX, sdy - camY, verts, 1.06);
    ctx.strokeStyle = PALETTE[3];
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // 3. 호버 또는 웨이포인트 드래그 실시간 표시
  if (hoverHex) {
    const [hq, hr] = hoverHex;
    if (hq >= 0 && hr >= 0 && hq < W_COLS && hr < W_ROWS) {
      const terr = hexes[hr * W_COLS + hq] & 0x7;
      const impassable = terr === 3 || terr === 4;
      const [dx, dy] = hexCenterDisp(hq, hr);
      const cx = dx - camX;
      const cy = dy - camY;

      if (spSelected && (hq !== spQ || hr !== spR)) {
        if (impassable) {
          // 통행 불가 표시: 제국 경고색 붉은 주황 워시 + 점선 차단선 + ⊘ 기호
          const [sdx, sdy] = hexCenterDisp(spQ, spR);
          ctx.save();
          ctx.strokeStyle = "rgba(232, 130, 63, 0.55)";
          ctx.lineWidth = 1.6;
          ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(sdx - camX, sdy - camY);
          ctx.lineTo(cx, cy);
          ctx.stroke();
          ctx.restore();

          drawHexPath(cx, cy, verts, 0.96);
          ctx.fillStyle = "rgba(232, 130, 63, 0.22)";
          ctx.fill();
          ctx.strokeStyle = PALETTE[4];
          ctx.lineWidth = 2.2;
          ctx.stroke();
          drawBlockedSymbol(cx, cy, R, 1);
        } else {
          // 이동 가능 목적지 레티클 (드래그 중이면 더 선명하게)
          drawHexPath(cx, cy, verts, 0.96);
          ctx.fillStyle = draggingTarget ? "rgba(99, 214, 172, 0.24)" : "rgba(99, 214, 172, 0.12)";
          ctx.fill();
          ctx.strokeStyle = PALETTE[3];
          ctx.lineWidth = draggingTarget ? 2.4 : 1.6;
          ctx.stroke();
          // 목적지 중앙 마름모 마커 ◇
          ctx.fillStyle = PALETTE[3];
          ctx.font = `${Math.max(10, Math.round(R * 0.72))}px ${FONT_FAMILY}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("◇", cx, cy + 1);
        }
      } else {
        // 비선택 호버: 미세한 반응 테두리
        drawHexPath(cx, cy, verts, 0.96);
        ctx.strokeStyle = "rgba(207, 202, 187, 0.35)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
  }

  // 4. 클릭/확정 펄스 & 통행 불가 흔들림(Shake) 이펙트
  const now = performance.now();
  for (const fx of fxList) {
    const t = Math.min(1, (now - fx.start) / fx.dur);
    const [dx, dy] = hexCenterDisp(fx.q, fx.r);
    let cx = dx - camX;
    const cy = dy - camY;
    if (fx.kind === "pulse") {
      ctx.save();
      ctx.globalAlpha = 1 - t;
      drawHexPath(cx, cy, verts, 0.9 + t * 0.55);
      ctx.strokeStyle = fx.color;
      ctx.lineWidth = 2.4 * (1 - t * 0.5);
      ctx.stroke();
      ctx.restore();
    } else if (fx.kind === "invalid") {
      const shake = Math.sin(t * Math.PI * 5) * (1 - t) * 4;
      cx += shake;
      ctx.save();
      ctx.globalAlpha = 1 - t * 0.85;
      drawHexPath(cx, cy, verts, 0.96);
      ctx.fillStyle = "rgba(232, 130, 63, 0.32)";
      ctx.fill();
      ctx.strokeStyle = PALETTE[4];
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.restore();
      drawBlockedSymbol(cx, cy, R, 1 - t * 0.7);
    }
  }
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
  const m = playing || draggingTarget ? 0 : wasm.w_menu();
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
  const m = wasm.w_menu();
  if (playing || !wasm.w_command(kind)) return;
  save.events.push(["o", kind]);
  persist();
  hoverHex = null;
  draggingTarget = false;
  wasm.w_hover(-1, -1, 0);
  if (m) spawnFx("pulse", (m >>> 8) & 0xff, (m >>> 16) & 0xff, PALETTE[3], 360);
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
  const sq = sp & 0xff;
  const sr = (sp >>> 8) & 0xff;
  inspectedHex = null;
  setOverview(false, [sq, sr]);
  spawnFx("pulse", sq, sr, PALETTE[3], 360);
}

function newGame(seed) {
  save = { v: SAVE_VERSION, seed, events: [] };
  wasm.w_init(seed);
  persist();
  hoverHex = null;
  inspectedHex = null;
  draggingTarget = false;
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

function hexTerrain(q, r) {
  if (q < 0 || r < 0 || q >= W_COLS || r >= W_ROWS) return 4;
  const hexes = new Uint32Array(wasm.memory.buffer, wasm.w_hex_ptr(), W_COLS * W_ROWS);
  return hexes[r * W_COLS + q] & 0x7;
}

function isImpassableHex(q, r) {
  const t = hexTerrain(q, r);
  return t === 3 || t === 4;
}

// 월드 포인터 입력:
// - 비선택 시: 드래그 = 팬, 클릭 = 조사 테두리 + 펄스 + 팝업, 특수부대 클릭 = 선택 + 펄스
// - 선택 시: 호버 = 실시간 경로/⊘ 표시, 좌클릭·터치 누름/드래그 = 목적지 웨이포인트 직접 드래그(산맥·해역이면 ⊘ 불가 표시),
//            우클릭/휠버튼 드래그 = 팬, 특수부대 재클릭 또는 Esc = 선택 해제
const pointers = new Map();
let dragState = null;
let pinchStartDist = 0;
let holdTimer = 0;

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  clearTimeout(holdTimer);
  if (pointers.size === 2) {
    dragState = null;
    draggingTarget = false;
    wasm.w_hover(-1, -1, 0);
    const pts = [...pointers.values()];
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    return;
  }
  if (pointers.size !== 1) return;

  const [q, r] = hexAtClient(ev.clientX, ev.clientY);
  const sp = wasm.w_special_pos();
  const spSelected = !!(sp & (1 << 16));
  const isPanButton = ev.button === 1 || ev.button === 2;

  // 특수부대가 선택된 상태에서 좌클릭/터치로 전술 뷰 헥스를 누르면 즉시 목적지 표시 + 드래그 가능!
  if (spSelected && !view.overview && !playing && !isPanButton && q >= 0 && r >= 0 && q < W_COLS && r < W_ROWS) {
    draggingTarget = true;
    hoverHex = [q, r];
    wasm.w_hover(q, r, 1);
    dragState = {
      mode: "waypoint",
      x: ev.clientX,
      y: ev.clientY,
      startX: ev.clientX,
      startY: ev.clientY,
      startHex: [q, r],
      moved: false,
    };
    hidePop();
    draw();
    return;
  }

  dragState = { mode: "pan", x: ev.clientX, y: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false };
  if (ev.pointerType !== "mouse") {
    holdTimer = setTimeout(() => {
      if (dragState && !dragState.moved) {
        const [hq, hr] = hexAtClient(ev.clientX, ev.clientY);
        showPop(hq, hr, ev.clientX, ev.clientY);
        dragState.held = true;
      }
    }, HOLD_MS);
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

  if (dragState && dragState.mode === "waypoint") {
    if (Math.hypot(ev.clientX - dragState.startX, ev.clientY - dragState.startY) > 6) {
      dragState.moved = true;
    }
    // 캔버스 가장자리 근처로 드래그하면 부드럽게 자동 스크롤
    const rect = canvas.getBoundingClientRect();
    const edge = 28;
    const edgeSpeed = 10;
    if (ev.clientX - rect.left < edge) view.camX -= edgeSpeed;
    else if (rect.right - ev.clientX < edge) view.camX += edgeSpeed;
    if (ev.clientY - rect.top < edge) view.camY -= edgeSpeed;
    else if (rect.bottom - ev.clientY < edge) view.camY += edgeSpeed;
    clampCam();

    const [q, r] = hexAtClient(ev.clientX, ev.clientY);
    if (q >= 0 && r >= 0 && q < W_COLS && r < W_ROWS) {
      hoverHex = [q, r];
      wasm.w_hover(q, r, 1);
      const col = Math.min(9, Math.floor((q * 10) / W_COLS));
      const row = Math.min(5, Math.floor((r * 6) / W_ROWS));
      $("coords-hint").textContent = `${String.fromCharCode(65 + col)}${row + 1} (${q},${r})`;
    }
    draw();
    return;
  }

  if (dragState && dragState.mode === "pan") {
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
      const changedHover = !hoverHex || hoverHex[0] !== q || hoverHex[1] !== r;
      hoverHex = [q, r];
      const col = Math.min(9, Math.floor((q * 10) / W_COLS));
      const row = Math.min(5, Math.floor((r * 6) / W_ROWS));
      $("coords-hint").textContent = `${String.fromCharCode(65 + col)}${row + 1} (${q},${r})`;
      if (!view.overview) {
        const spSelected = !!(wasm.w_special_pos() & (1 << 16));
        if (spSelected) wasm.w_hover(q, r, 0);
        if (changedHover) draw();
        // 특수부대 선택 중 통행 불가 헥스 위에서는 글 팝업 대신 ⊘ 기호에 시선이 가도록 팝업을 숨긴다.
        if (spSelected && isImpassableHex(q, r)) hidePop();
        else showPop(q, r, ev.clientX, ev.clientY);
      }
    } else {
      hoverHex = null;
      wasm.w_hover(-1, -1, 0);
      hidePop();
      draw();
    }
  }
});

canvas.addEventListener("pointerup", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchStartDist = 0;
  const st = dragState;
  dragState = null;

  if (st && st.mode === "waypoint") {
    draggingTarget = false;
    wasm.w_hover(-1, -1, 0);
    const [q, r] = hexAtClient(ev.clientX, ev.clientY);
    const sp = wasm.w_special_pos();
    const spQ = sp & 0xff;
    const spR = (sp >>> 8) & 0xff;

    if (q < 0 || r < 0 || q >= W_COLS || r >= W_ROWS) {
      hoverHex = null;
      draw();
      return;
    }
    // 자기 칸을 제자리 탭하면 선택 해제
    if (q === spQ && r === spR && !st.moved) {
      if (wasm.w_click(q, r)) {
        save.events.push([q, r]);
        persist();
      }
      hoverHex = null;
      draw();
      return;
    }
    // 산맥·불모 해역 위에 놓으면 선택을 유지한 채 붉은 ⊘ 흔들림 리액션!
    if (isImpassableHex(q, r)) {
      spawnFx("invalid", q, r, PALETTE[4], 380);
      draw();
      return;
    }
    // 이동 가능한 헥스에 놓으면 목적지 확정 + 펄스 + 명령 메뉴 오픈
    if (q !== spQ || r !== spR) {
      if (wasm.w_click(q, r)) {
        save.events.push([q, r]);
        persist();
      }
      spawnFx("pulse", q, r, PALETTE[3], 320);
      hidePop();
    }
    if (ev.pointerType !== "mouse") hoverHex = null;
    draw();
    return;
  }

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
    inspectedHex = null;
    spawnFx("pulse", q, r, PALETTE[3], 360);
    hidePop();
  } else {
    inspectedHex = [q, r];
    spawnFx("pulse", q, r, PALETTE[2], 260);
    showPop(q, r, ev.clientX, ev.clientY);
  }
  draw();
});

canvas.addEventListener("pointercancel", (ev) => {
  clearTimeout(holdTimer);
  pointers.delete(ev.pointerId);
  dragState = null;
  draggingTarget = false;
  wasm.w_hover(-1, -1, 0);
  hidePop();
});
canvas.addEventListener("pointerleave", (ev) => {
  if (ev.pointerType === "mouse" && !draggingTarget) {
    hoverHex = null;
    wasm.w_hover(-1, -1, 0);
    hidePop();
    draw();
  }
});
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
    burrowBtn: $("b-act-burrow"),
    retreatBtn: $("b-act-retreat"),
    confirmBtn: $("b-confirm"),
    endBtn: $("b-end"),
    headerEl: $("b-header"),
    aiNoteEl: $("b-ai-note"),
    returnBtn: $("b-return"),
  },
  isActive: () => inBattle,
});

function battleLayout() {
  battle.layout();
}

function battleDraw() {
  battle.draw();
}

function enterBattle() {
  if (playing || inBattle || !wasm.w_has_clash()) return;
  if (!wasm.w_enter_battle()) return;
  hidePop();
  refitModal.hidden = true;
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
  layout();
  const sp = wasm.w_special_pos();
  centerOn(sp & 0xff, (sp >>> 8) & 0xff);
  draw();
}

$("btn-enter-battle").addEventListener("click", enterBattle);
$("b-return").addEventListener("click", finishBattleAndReturn);
$("b-btn-roster").addEventListener("click", () => { bRosterModal.hidden = !bRosterModal.hidden; });
$("b-roster-close").addEventListener("click", () => { bRosterModal.hidden = true; });
bRosterModal.addEventListener("click", (ev) => { if (ev.target === bRosterModal) bRosterModal.hidden = true; });

document.addEventListener("keydown", (ev) => {
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

  if (ev.code === "Escape") {
    if (!refitModal.hidden) { refitModal.hidden = true; return; }
    const sp = wasm.w_special_pos();
    if (sp & (1 << 16)) {
      const sq = sp & 0xff;
      const sr = (sp >>> 8) & 0xff;
      if (wasm.w_click(sq, sr)) {
        save.events.push([sq, sr]);
        persist();
      }
      hoverHex = null;
      draggingTarget = false;
      wasm.w_hover(-1, -1, 0);
      draw();
      return;
    }
  }
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
