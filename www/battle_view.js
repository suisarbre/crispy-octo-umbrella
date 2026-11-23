// 공유 전술 전투 렌더러 · 인터랙션 · FX 모듈 (단독 전투 main.js & 통합 전투 world.js 공용).
// 6색 SF 감청 단말 팔레트(#0c0f11, #38454a, #cfcabb, #63d6ac, #e8823f, #37725e)를 엄격히 유지한다.

const PALETTE = ["#0c0f11", "#38454a", "#cfcabb", "#63d6ac", "#e8823f", "#37725e"];
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

const BEAT_STEP = 1;
const BEAT_TRACER = 2;
const BEAT_HIT = 3;
const BEAT_MISS = 4;
const BEAT_KILL = 5;
const BEAT_BURROW = 6;
const BEAT_SMOKE = 7;
const BEAT_RETREAT = 8;
const BEAT_OVERWATCH = 9;
const BEAT_OW_TRIGGER = 10;
const BEAT_HUNKER = 11;

const SNAP = 0.95;
const HOLD_MS = 350;
const SENSOR_RADIUS = 6;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBattleView(cfg) {
  const { wasm, canvas, mainEl, popEl, rosterModal, rosterList, els } = cfg;
  const ctx = canvas.getContext("2d");
  const COLS = wasm.cols();
  const ROWS = wasm.rows();
  const isActive = cfg.isActive ?? (() => true);

  let view = { rot: false, cols: COLS, rows: ROWS, cw: 26, ch: 28, font: 16 };
  let pending = null;
  let hoverCell = null;
  let lastPointer = "mouse";
  let playing = false;
  let skipRequested = false;
  let lastRosterRaw = "";
  let lastTargetsKey = "";
  let lastBadgeRaw = "";
  let holdTimer = 0;
  let holdStart = null;
  let swallowClick = false;

  // XCOM 조준 모드 상태 (1번/공격 버튼 진입, Tab으로 표적 순환, 1/Enter/확정으로 발사)
  let aimMode = false;
  let aimIndex = 0;
  let currentTargets = [];

  // 실시간 캔버스 애니메이션 FX (클릭 리액션, ⊘ 불가 흔들림, 트레이서/충격파/스파크, 중계 펄스, 경계 슬로모, 엄호)
  let fxList = [];
  let fxRaf = 0;

  const toDisplay = (gx, gy) => (view.rot ? [gy, COLS - 1 - gx] : [gx, gy]);
  const toGame = (dx, dy) => (view.rot ? [COLS - 1 - dy, dx] : [dx, dy]);
  const cellCenter = (gx, gy) => {
    const [dx, dy] = toDisplay(gx, gy);
    return [(dx + 0.5) * view.cw, (dy + 0.5) * view.ch];
  };

  const metaNow = () => new Uint32Array(wasm.memory.buffer, wasm.b_meta_ptr(), COLS * ROWS);
  const unitsNow = () => new Uint32Array(wasm.memory.buffer, wasm.b_units_ptr(), wasm.b_units_len());
  const fxNow = () => new Uint32Array(wasm.memory.buffer, wasm.b_fx_ptr(), wasm.b_fx_len());

  function parseUnits() {
    const raw = unitsNow();
    const out = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const w0 = raw[i];
      const w1 = raw[i + 1];
      out.push({
        x: w0 & 0xff,
        y: (w0 >>> 8) & 0xff,
        hp: (w0 >>> 16) & 0xf,
        maxHp: (w0 >>> 20) & 0xf,
        ap: (w0 >>> 24) & 0x3,
        isEmpire: !!(w0 & (1 << 26)),
        isAi: !!(w0 & (1 << 27)),
        isSelected: !!(w0 & (1 << 28)),
        isBurrowed: !!(w0 & (1 << 29)),
        inFireLane: !!(w0 & (1 << 30)),
        struck: !!(w0 & (1 << 31)),
        glyph: String.fromCodePoint(w1 & 0x1fffff),
        shieldDir: (w1 >>> 21) & 0xf,
        isSensor: !!(w1 & (1 << 25)),
        isRelay: !!(w1 & (1 << 26)),
        hovered: !!(w1 & (1 << 27)),
        flanked: !!(w1 & (1 << 28)),
        canRetreatHere: !!(w1 & (1 << 29)),
        isOverwatch: !!(w1 & (1 << 30)),
        isHunkered: !!(w1 & (1 << 31)),
      });
    }
    return out;
  }

  function pushFx(item) {
    if (reducedMotion.matches) return;
    fxList.push({ ...item, start: performance.now() });
    if (!fxRaf) fxRaf = requestAnimationFrame(stepFx);
  }

  function stepFx() {
    fxRaf = 0;
    const now = performance.now();
    fxList = fxList.filter((f) => now - f.start < f.dur);
    if (isActive()) drawCanvasOnly();
    if (fxList.length > 0) fxRaf = requestAnimationFrame(stepFx);
  }

  function kick(kind) {
    if (reducedMotion.matches || !canvas.animate) return;
    const d = kind === BEAT_KILL ? 3.5 : 2;
    canvas.animate(
      [
        { transform: `translate(${d}px, ${d - 1}px)` },
        { transform: `translate(${-d + 1}px, -1px)` },
        { transform: "none" },
      ],
      { duration: kind === BEAT_KILL ? 150 : 95, easing: "ease-out" },
    );
  }

  function spawnBeatFx(kind, durMs) {
    const bfx = fxNow();
    const units = parseUnits();

    // 중계기 신호 펄스 (제국 턴 개시 연결 / 중계기 파괴 두절)
    const rp = wasm.b_relay_pulse();
    if (rp === 1) {
      const relays = units.filter((u) => u.isEmpire && u.isRelay);
      const emps = units.filter((u) => u.isEmpire && !u.isRelay);
      if (relays.length > 0) {
        const links = [];
        for (const r of relays) {
          for (const e of emps) links.push([r.x, r.y, e.x, e.y]);
        }
        pushFx({
          kind: "relay_link",
          relays: relays.map((r) => [r.x, r.y]),
          links,
          dur: 440,
        });
      }
    } else if (rp === 2 && bfx[0] === 5) {
      const emps = units.filter((u) => u.isEmpire);
      pushFx({
        kind: "relay_sever",
        x: bfx[1],
        y: bfx[2],
        links: emps.map((e) => [bfx[1], bfx[2], e.x, e.y]),
        dur: 520,
      });
    }

    if (kind === BEAT_TRACER && bfx[0] === 2) {
      const slow = !!bfx[6];
      pushFx({
        kind: "tracer",
        fx: bfx[1],
        fy: bfx[2],
        tx: bfx[3],
        ty: bfx[4],
        color: PALETTE[bfx[5]] || PALETTE[2],
        slow,
        dur: Math.max(slow ? 230 : 115, durMs + 35),
      });
    } else if (kind === BEAT_HIT && bfx[0] === 3) {
      const ang = Math.atan2(bfx[4] - bfx[2], bfx[3] - bfx[1]);
      const sparks = [];
      for (let i = 0; i < 7; i++) {
        const spread = (i - 3) * 0.28 + ((i % 2) * 0.12 - 0.06);
        sparks.push({ ang: ang + spread, spd: 0.55 + (i % 3) * 0.25 });
      }
      pushFx({
        kind: "hit",
        x: bfx[3],
        y: bfx[4],
        dmg: bfx[5],
        color: PALETTE[bfx[6]] || PALETTE[2],
        sparks,
        dur: bfx[7] ? 340 : 280,
      });
    } else if (kind === BEAT_MISS && bfx[0] === 4) {
      const ang = Math.atan2(bfx[4] - bfx[2], bfx[3] - bfx[1]);
      const slow = !!(bfx[7] >>> 8);
      pushFx({
        kind: "miss",
        fx: bfx[1],
        fy: bfx[2],
        tx: bfx[3],
        ty: bfx[4],
        ex: bfx[5],
        ey: bfx[6],
        ang,
        dur: slow ? 320 : 260,
      });
    } else if (kind === BEAT_KILL && bfx[0] === 5) {
      const sparks = [];
      for (let i = 0; i < 10; i++) {
        sparks.push({ ang: (i / 10) * Math.PI * 2 + 0.2, spd: 0.7 + (i % 2) * 0.35 });
      }
      pushFx({
        kind: "kill",
        x: bfx[1],
        y: bfx[2],
        sparks,
        dur: 340,
      });
    } else if (kind === BEAT_SMOKE && bfx[0] === 6) {
      pushFx({ kind: "smoke_pop", x: bfx[1], y: bfx[2], dur: 320 });
    } else if (kind === BEAT_BURROW && bfx[0] === 7) {
      pushFx({ kind: "burrow", x: bfx[1], y: bfx[2], dur: 240 });
    } else if (kind === BEAT_RETREAT && bfx[0] === 8) {
      pushFx({ kind: "retreat", x: bfx[1], y: bfx[2], dur: 260 });
    } else if (kind === BEAT_OVERWATCH && bfx[0] === 9) {
      pushFx({
        kind: "overwatch_set",
        x: bfx[1],
        y: bfx[2],
        color: PALETTE[bfx[3]] || PALETTE[3],
        dur: 360,
      });
    } else if (kind === BEAT_OW_TRIGGER && bfx[0] === 10) {
      const col = PALETTE[bfx[5]] || PALETTE[4];
      // 슬로모 락온(560ms) + 이어지는 슬로모 사격(460ms) 동안 비네트와 레터박스가 부드럽게 이어진다.
      pushFx({
        kind: "ow_slowmo",
        fx: bfx[1],
        fy: bfx[2],
        tx: bfx[3],
        ty: bfx[4],
        color: col,
        lockDur: durMs,
        dur: durMs + 460,
      });
    } else if (kind === BEAT_HUNKER && bfx[0] === 11) {
      pushFx({
        kind: "hunker",
        x: bfx[1],
        y: bfx[2],
        color: PALETTE[bfx[3]] || PALETTE[2],
        dur: 340,
      });
    }
  }

  async function play() {
    if (playing) return;
    playing = true;
    skipRequested = false;
    aimMode = false;
    for (;;) {
      const beat = wasm.advance();
      if (!beat) break;
      const kind = beat >>> 16;
      const ms = beat & 0xffff;
      spawnBeatFx(kind, ms);
      draw();
      if (kind === BEAT_HIT || kind === BEAT_KILL) kick(kind);
      await sleep(ms);
      if (skipRequested) {
        wasm.skip();
        break;
      }
    }
    playing = false;
    if (!wasm.battle_done()) {
      ensureSelected(true);
    }
    draw();
    if (wasm.battle_done() && cfg.onDone) cfg.onDone();
  }

  function skipIfPlaying() {
    if (playing) skipRequested = true;
    return playing;
  }

  function layout() {
    const narrow = window.innerWidth < 700;
    const rot = narrow && window.innerHeight > window.innerWidth;
    const cols = rot ? ROWS : COLS;
    const rows = rot ? COLS : ROWS;
    let cw;
    let ch;
    let font;
    if (narrow) {
      const availW = document.documentElement.clientWidth - 16;
      const availH = Math.max(240, window.innerHeight - 190);
      const cwW = Math.floor(availW / cols);
      const cwH = Math.floor(availH / (rows * (rot ? 1.06 : 1.1)));
      cw = Math.max(14, Math.min(28, cwW, cwH));
      ch = rot ? cw + 1 : Math.round(cw * 1.1);
      font = Math.max(11, Math.min(18, Math.floor(Math.min(ch * 0.56, cw * 0.72))));
    } else {
      // 상단 바(~38px) + 하단 XCOM HUD(~96px) + 여백을 제외한 1화면 높이와 폭에 딱 맞춘다.
      const availW = Math.min(920, document.documentElement.clientWidth - 28);
      const availH = Math.max(260, window.innerHeight - 156);
      const cwW = Math.floor(availW / cols);
      const cwH = Math.floor(availH / (rows * 1.08));
      cw = Math.max(18, Math.min(31, cwW, cwH));
      ch = Math.round(cw * 1.08);
      font = Math.max(12, Math.min(18, Math.round(cw * 0.6)));
    }
    view = { rot, cols, rows, cw, ch, font };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cols * cw * dpr;
    canvas.height = rows * ch * dpr;
    canvas.style.width = `${cols * cw}px`;
    canvas.style.height = `${rows * ch}px`;
    if (mainEl) mainEl.style.width = narrow ? "" : `${cols * cw}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 방향별 엄폐 방패 막대 (0:N, 1:E, 2:S, 3:W, view.rot 반영)
  function drawCoverShields(gx, gy, coverMask, color, strong) {
    if (!coverMask) return;
    const [dx, dy] = toDisplay(gx, gy);
    const { cw, ch } = view;
    const px = dx * cw;
    const py = dy * ch;
    ctx.save();
    for (let d = 0; d < 4; d++) {
      const cov = (coverMask >>> (d * 2)) & 0x3;
      if (!cov) continue;
      const dd = view.rot ? (d + 3) % 4 : d;
      const thick = cov === 2 ? (strong ? 3.2 : 2.2) : (strong ? 2.0 : 1.5);
      const inset = cov === 2 ? 3 : 6;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = strong ? (cov === 2 ? 0.95 : 0.75) : (cov === 2 ? 0.52 : 0.36);
      ctx.lineWidth = thick;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (dd === 0) {
        ctx.moveTo(px + inset, py + 1.5);
        ctx.lineTo(px + cw - inset, py + 1.5);
      } else if (dd === 1) {
        ctx.moveTo(px + cw - 1.5, py + inset);
        ctx.lineTo(px + cw - 1.5, py + ch - inset);
      } else if (dd === 2) {
        ctx.moveTo(px + inset, py + ch - 1.5);
        ctx.lineTo(px + cw - inset, py + ch - 1.5);
      } else {
        ctx.moveTo(px + 1.5, py + inset);
        ctx.lineTo(px + 1.5, py + ch - inset);
      }
      ctx.stroke();

      // 완전 엄폐(벽)는 작은 방패 중앙점, 낮은 엄폐는 속빈 작은 점으로 직관 구분
      if (strong) {
        let sx = px + cw / 2;
        let sy = py + ch / 2;
        if (dd === 0) sy = py + 4.5;
        else if (dd === 1) sx = px + cw - 4.5;
        else if (dd === 2) sy = py + ch - 4.5;
        else sx = px + 4.5;
        ctx.beginPath();
        ctx.arc(sx, sy, cov === 2 ? 2.1 : 1.7, 0, Math.PI * 2);
        if (cov === 2) ctx.fill();
        else {
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawCornerBrackets(px, py, cw, ch, color, pad = 1.5, len = 5, lw = 1.6) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    // TL
    ctx.moveTo(px + pad, py + pad + len);
    ctx.lineTo(px + pad, py + pad);
    ctx.lineTo(px + pad + len, py + pad);
    // TR
    ctx.moveTo(px + cw - pad - len, py + pad);
    ctx.lineTo(px + cw - pad, py + pad);
    ctx.lineTo(px + cw - pad, py + pad + len);
    // BR
    ctx.moveTo(px + cw - pad, py + ch - pad - len);
    ctx.lineTo(px + cw - pad, py + ch - pad);
    ctx.lineTo(px + cw - pad - len, py + ch - pad);
    // BL
    ctx.moveTo(px + pad + len, py + ch - pad);
    ctx.lineTo(px + pad, py + ch - pad);
    ctx.lineTo(px + pad, py + ch - pad - len);
    ctx.stroke();
  }

  function drawBlockedIcon(cx, cy, rad, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = PALETTE[4];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.moveTo(cx - rad * 0.72, cy - rad * 0.72);
    ctx.lineTo(cx + rad * 0.72, cy + rad * 0.72);
    ctx.stroke();
    ctx.restore();
  }

  function drawCanvasOnly() {
    const meta = metaNow();
    const units = parseUnits();
    const bfx = fxNow();
    const { cw, ch } = view;
    const totalW = view.cols * cw;
    const totalH = view.rows * ch;

    // 1. 바탕 (전장의 안개 기본 암흑)
    ctx.fillStyle = "#06080a";
    ctx.fillRect(0, 0, totalW, totalH);

    // 2. 바닥, 시야(Fog of War), 후퇴선, 이동 가능 영역 바탕
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const m = meta[y * COLS + x];
        const tile = m & 0x3;
        const seen = !!(m & (1 << 2));
        const reachable = !!(m & (1 << 4));
        const retreatEdge = !!(m & (1 << 6));
        const [dx, dy] = toDisplay(x, y);
        const px = dx * cw;
        const py = dy * ch;

        if (tile === 0) {
          ctx.fillStyle = seen ? "#0c0f11" : "#07090b";
          ctx.fillRect(px, py, cw, ch);

          if (reachable) {
            ctx.fillStyle = "rgba(99, 214, 172, 0.085)";
            ctx.fillRect(px, py, cw, ch);
          }

          // 격자 테두리
          ctx.strokeStyle = seen ? "rgba(56, 69, 74, 0.28)" : "rgba(56, 69, 74, 0.11)";
          ctx.lineWidth = 0.75;
          ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);

          // 미세한 중앙 눈금 (이동 가능 칸은 민트색)
          if (reachable) {
            ctx.fillStyle = "rgba(99, 214, 172, 0.45)";
            ctx.fillRect(px + cw / 2 - 1, py + ch / 2 - 1, 2, 2);
          } else if (seen) {
            ctx.fillStyle = "rgba(56, 69, 74, 0.42)";
            ctx.fillRect(px + cw / 2 - 0.75, py + ch / 2 - 0.75, 1.5, 1.5);
          }

          // 좌측 후퇴 경계(x === 0) 표식
          if (retreatEdge && y % 2 === 1) {
            ctx.fillStyle = reachable ? "rgba(99, 214, 172, 0.65)" : "rgba(232, 130, 63, 0.28)";
            ctx.font = `${Math.max(10, Math.round(cw * 0.42))}px ${FONT_FAMILY}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(view.rot ? "▽" : "◁", px + cw * 0.5, py + ch * 0.5);
          }
        }
      }
    }

    // 2.5. 이동 가능 구역 외곽선 (XCOM식 깔끔한 경계선)
    ctx.strokeStyle = "rgba(99, 214, 172, 0.48)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const dirs4 = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!(meta[y * COLS + x] & (1 << 4))) continue;
        const [dx, dy] = toDisplay(x, y);
        const px = dx * cw;
        const py = dy * ch;
        for (let d = 0; d < 4; d++) {
          const nx = x + dirs4[d][0];
          const ny = y + dirs4[d][1];
          const nbReach = nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && !!(meta[ny * COLS + nx] & (1 << 4));
          if (nbReach) continue;
          const dd = view.rot ? (d + 3) % 4 : d;
          if (dd === 0) {
            ctx.moveTo(px + 0.5, py + 0.5);
            ctx.lineTo(px + cw - 0.5, py + 0.5);
          } else if (dd === 1) {
            ctx.moveTo(px + cw - 0.5, py + 0.5);
            ctx.lineTo(px + cw - 0.5, py + ch - 0.5);
          } else if (dd === 2) {
            ctx.moveTo(px + 0.5, py + ch - 0.5);
            ctx.lineTo(px + cw - 0.5, py + ch - 0.5);
          } else {
            ctx.moveTo(px + 0.5, py + 0.5);
            ctx.lineTo(px + 0.5, py + ch - 0.5);
          }
        }
      }
    }
    ctx.stroke();

    // 3. 구조물 지형: 벽(사선 해칭 + 연결 외곽선), 낮은 엄폐(반높이 바리케이드), 연막(반투명 구름)
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const m = meta[y * COLS + x];
        const tile = m & 0x3;
        const seen = !!(m & (1 << 2));
        const smoke = !!(m & (1 << 3));
        const [dx, dy] = toDisplay(x, y);
        const px = dx * cw;
        const py = dy * ch;

        if (tile === 2) {
          // 벽: 묵직한 콘크리트/강철 블록 + 45도 통행/시야 차단 해칭
          ctx.fillStyle = seen ? "#1f2a30" : "#11171b";
          ctx.fillRect(px, py, cw, ch);
          ctx.save();
          ctx.beginPath();
          ctx.rect(px + 1, py + 1, cw - 2, ch - 2);
          ctx.clip();
          ctx.strokeStyle = seen ? "#11171b" : "#0a0e10";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          const step = Math.max(5, Math.round(cw * 0.26));
          for (let o = -ch; o <= cw + ch; o += step) {
            ctx.moveTo(px + o, py);
            ctx.lineTo(px + o - ch, py + ch);
          }
          ctx.stroke();
          ctx.restore();

          // 인접한 벽과 이어지는 외곽선 (L자 벙커가 하나의 덩어리로 읽힘)
          ctx.strokeStyle = seen ? "#596d76" : "#253036";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (let d = 0; d < 4; d++) {
            const nx = x + dirs4[d][0];
            const ny = y + dirs4[d][1];
            const nbWall = nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && (meta[ny * COLS + nx] & 0x3) === 2;
            if (nbWall) continue;
            const dd = view.rot ? (d + 3) % 4 : d;
            if (dd === 0) {
              ctx.moveTo(px + 0.5, py + 0.8);
              ctx.lineTo(px + cw - 0.5, py + 0.8);
            } else if (dd === 1) {
              ctx.moveTo(px + cw - 0.8, py + 0.5);
              ctx.lineTo(px + cw - 0.8, py + ch - 0.5);
            } else if (dd === 2) {
              ctx.moveTo(px + 0.5, py + ch - 0.8);
              ctx.lineTo(px + cw - 0.5, py + ch - 0.8);
            } else {
              ctx.moveTo(px + 0.8, py + 0.5);
              ctx.lineTo(px + 0.8, py + ch - 0.5);
            }
          }
          ctx.stroke();
        } else if (tile === 1) {
          // 낮은 엄폐: 반높이 전술 바리케이드 (시야 통과, 사격 엄폐)
          ctx.fillStyle = seen ? "#0c0f11" : "#07090b";
          ctx.fillRect(px, py, cw, ch);
          const bx = px + 2.5;
          const by = py + ch * 0.34;
          const bw = cw - 5;
          const bh = ch * 0.52;
          ctx.fillStyle = seen ? "#1c262b" : "#101619";
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = seen ? "#485a62" : "#222c31";
          ctx.lineWidth = 1.1;
          ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
          // 상단 하이라이트 바 + 수직 지지대 2개
          ctx.fillStyle = seen ? "#687c85" : "#2d393f";
          ctx.fillRect(bx, by, bw, 2.5);
          ctx.fillStyle = seen ? "#38454a" : "#1c2428";
          ctx.fillRect(bx + bw * 0.3, by + 3, 1.5, bh - 4);
          ctx.fillRect(bx + bw * 0.7 - 1.5, by + 3, 1.5, bh - 4);
        }

        if (smoke && tile !== 2) {
          // 연막: 반투명 2중 구름 + 단말 파형선
          ctx.fillStyle = seen ? "rgba(207, 202, 187, 0.14)" : "rgba(56, 69, 74, 0.20)";
          ctx.fillRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
          ctx.fillStyle = seen ? "rgba(207, 202, 187, 0.13)" : "rgba(56, 69, 74, 0.16)";
          ctx.beginPath();
          ctx.arc(px + cw * 0.35, py + ch * 0.42, cw * 0.28, 0, Math.PI * 2);
          ctx.arc(px + cw * 0.68, py + ch * 0.56, cw * 0.26, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = seen ? "rgba(207, 202, 187, 0.36)" : "rgba(56, 69, 74, 0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + 4, py + ch * 0.38);
          ctx.quadraticCurveTo(px + cw * 0.5, py + ch * 0.24, px + cw - 4, py + ch * 0.38);
          ctx.moveTo(px + 4, py + ch * 0.68);
          ctx.quadraticCurveTo(px + cw * 0.5, py + ch * 0.54, px + cw - 4, py + ch * 0.68);
          ctx.stroke();
        }
      }
    }

    // 4. 마지막 목격 잔상 (?) — 시야 밖 기억 위치
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const m = meta[y * COLS + x];
        if (!(m & (1 << 7))) continue;
        const [dx, dy] = toDisplay(x, y);
        const px = dx * cw;
        const py = dy * ch;
        ctx.save();
        ctx.strokeStyle = "rgba(232, 130, 63, 0.48)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(px + 3, py + 3, cw - 6, ch - 6);
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(232, 130, 63, 0.72)";
        ctx.font = `bold ${Math.max(12, Math.round(view.font * 0.9))}px ${FONT_FAMILY}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("?", px + cw / 2, py + ch / 2 + 0.5);
        ctx.restore();
      }
    }

    // 5. 탐지기(s) 6칸 감지 반경 (Chebyshev 정사각 점선 테두리)
    for (const u of units) {
      if (!u.isSensor) continue;
      const x0 = Math.max(0, u.x - SENSOR_RADIUS);
      const y0 = Math.max(0, u.y - SENSOR_RADIUS);
      const x1 = Math.min(COLS - 1, u.x + SENSOR_RADIUS);
      const y1 = Math.min(ROWS - 1, u.y + SENSOR_RADIUS);
      const [da, db] = toDisplay(x0, y0);
      const [dc, dd] = toDisplay(x1, y1);
      const minX = Math.min(da, dc) * cw;
      const minY = Math.min(db, dd) * ch;
      const maxX = (Math.max(da, dc) + 1) * cw;
      const maxY = (Math.max(db, dd) + 1) * ch;
      ctx.save();
      ctx.strokeStyle = u.hovered ? "rgba(232, 130, 63, 0.58)" : "rgba(232, 130, 63, 0.22)";
      ctx.lineWidth = u.hovered ? 1.5 : 1;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(minX + 1, minY + 1, maxX - minX - 2, maxY - minY - 2);
      ctx.restore();
    }

    // 6. 이동 경로 폴리라인 + 목적지 엄폐 방패 미리보기
    const selUnit = units.find((u) => u.isSelected);
    if (selUnit) {
      // 선택 유닛 현재 위치의 엄폐 방패 (은은하게)
      const selCover = (meta[selUnit.y * COLS + selUnit.x] >>> 8) & 0xff;
      drawCoverShields(selUnit.x, selUnit.y, selCover, PALETTE[5], false);

      // 이동 경로 점들 수집 후 순서대로 폴리라인
      const steps = [];
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const m = meta[y * COLS + x];
          if (m & (1 << 5)) {
            steps.push({ x, y, ord: (m >>> 16) & 0xf });
          }
        }
      }
      if (steps.length > 0) {
        steps.sort((a, b) => a.ord - b.ord);
        const pts = [[selUnit.x, selUnit.y], ...steps.map((s) => [s.x, s.y])];
        ctx.save();
        ctx.strokeStyle = PALETTE[3];
        ctx.lineWidth = 2.2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const [cx, cy] = cellCenter(pts[i][0], pts[i][1]);
          if (i === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        }
        ctx.stroke();

        // 경유지 미세 점
        ctx.fillStyle = PALETTE[3];
        for (let i = 1; i < pts.length - 1; i++) {
          const [cx, cy] = cellCenter(pts[i][0], pts[i][1]);
          ctx.beginPath();
          ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }

        // 도착지 다이아몬드 + 방향별 엄폐 방패
        const dest = pts[pts.length - 1];
        const [dcx, dcy] = cellCenter(dest[0], dest[1]);
        ctx.fillStyle = PALETTE[3];
        ctx.beginPath();
        ctx.moveTo(dcx, dcy - 4.5);
        ctx.lineTo(dcx + 4.5, dcy);
        ctx.lineTo(dcx, dcy + 4.5);
        ctx.lineTo(dcx - 4.5, dcy);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        const destCover = (meta[dest[1] * COLS + dest[0]] >>> 8) & 0xff;
        drawCoverShields(dest[0], dest[1], destCover, PALETTE[3], true);
      }
    }

    // 7. 호버 타일 반응 테두리 (모든 호버에 즉각 반응)
    const activeTarget = pending || hoverCell;
    if (activeTarget && !playing) {
      const [hx, hy] = activeTarget;
      if (hx >= 0 && hy >= 0 && hx < COLS && hy < ROWS) {
        const hm = meta[hy * COLS + hx];
        const hTile = hm & 0x3;
        const hReach = !!(hm & (1 << 4));
        const [dx, dy] = toDisplay(hx, hy);
        const px = dx * cw;
        const py = dy * ch;
        if (pending) {
          drawCornerBrackets(px, py, cw, ch, PALETTE[2], 1, 6, 1.8);
        } else if (selUnit && selUnit.ap > 0 && hTile !== 0) {
          // 선택 상태에서 장애물(벽/낮은 엄폐) 위에 올리면 은은한 차단 테두리
          ctx.strokeStyle = "rgba(232, 130, 63, 0.35)";
          ctx.lineWidth = 1.2;
          ctx.strokeRect(px + 1, py + 1, cw - 2, ch - 2);
        } else if (hReach) {
          drawCornerBrackets(px, py, cw, ch, PALETTE[3], 1.5, 5, 1.5);
        } else {
          ctx.strokeStyle = "rgba(207, 202, 187, 0.25)";
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 1, py + 1, cw - 2, ch - 2);
        }
      }
    }

    // 8. 유닛 카운터 + 인라인 체력 핍 + AP 점 + 경계/엄호 배지 + 방패병 90° 방패 호
    const lockedTarget = aimMode && !playing && currentTargets[aimIndex] ? currentTargets[aimIndex] : null;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const u of units) {
      const [dx, dy] = toDisplay(u.x, u.y);
      const px = dx * cw;
      const py = dy * ch;
      const cx = px + cw / 2;
      const cy = py + ch * 0.44;
      const pad = 2;
      const isLocked = !!(lockedTarget && u.isEmpire && u.x === lockedTarget.x && u.y === lockedTarget.y);

      // 호버 또는 조준 잠금된 적의 지형 엄폐 방패 표시
      if (u.isEmpire && (u.hovered || isLocked)) {
        const ucov = (meta[u.y * COLS + u.x] >>> 8) & 0xff;
        drawCoverShields(u.x, u.y, ucov, PALETTE[4], true);
      }

      // 유닛 카운터 배경 + 프레임
      let bgFill = "rgba(12, 15, 17, 0.85)";
      let borderCol = PALETTE[1];
      let glyphCol = PALETTE[2];
      let solid = false;

      if (u.struck) {
        bgFill = PALETTE[2];
        borderCol = PALETTE[2];
        glyphCol = PALETTE[0];
        solid = true;
      } else if (u.isEmpire) {
        if (u.hovered || isLocked) {
          bgFill = PALETTE[4];
          borderCol = PALETTE[4];
          glyphCol = PALETTE[0];
          solid = true;
        } else if (u.inFireLane) {
          bgFill = u.flanked ? "rgba(99, 214, 172, 0.16)" : "rgba(232, 130, 63, 0.22)";
          borderCol = PALETTE[4];
          glyphCol = PALETTE[4];
        } else {
          bgFill = "rgba(232, 130, 63, 0.09)";
          borderCol = "rgba(232, 130, 63, 0.58)";
          glyphCol = PALETTE[4];
        }
      } else if (u.isAi) {
        bgFill = "rgba(55, 114, 94, 0.16)";
        borderCol = PALETTE[5];
        glyphCol = PALETTE[5];
      } else {
        // 플레이어 특수부대
        if (u.isSelected) {
          bgFill = PALETTE[3];
          borderCol = PALETTE[3];
          glyphCol = PALETTE[0];
          solid = true;
        } else if (u.isOverwatch) {
          bgFill = "rgba(99, 214, 172, 0.14)";
          borderCol = PALETTE[3];
          glyphCol = PALETTE[3];
        } else if (u.isHunkered) {
          bgFill = "rgba(207, 202, 187, 0.15)";
          borderCol = PALETTE[2];
          glyphCol = PALETTE[2];
        } else if (u.ap > 0 || playing) {
          bgFill = "rgba(99, 214, 172, 0.13)";
          borderCol = "rgba(99, 214, 172, 0.75)";
          glyphCol = PALETTE[3];
        } else {
          bgFill = "rgba(56, 69, 74, 0.15)";
          borderCol = PALETTE[1];
          glyphCol = PALETTE[1];
        }
      }

      ctx.save();
      if (u.isEmpire) {
        // 제국: 모서리를 깎은 각진 전술 카운터
        const cut = 4;
        ctx.beginPath();
        ctx.moveTo(px + pad + cut, py + pad);
        ctx.lineTo(px + cw - pad - cut, py + pad);
        ctx.lineTo(px + cw - pad, py + pad + cut);
        ctx.lineTo(px + cw - pad, py + ch - pad - cut);
        ctx.lineTo(px + cw - pad - cut, py + ch - pad);
        ctx.lineTo(px + pad + cut, py + ch - pad);
        ctx.lineTo(px + pad, py + ch - pad - cut);
        ctx.lineTo(px + pad, py + pad + cut);
        ctx.closePath();
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.strokeStyle = borderCol;
        ctx.lineWidth = u.inFireLane || u.hovered || isLocked || u.isOverwatch ? 1.5 : 1.1;
        ctx.stroke();
      } else {
        // 아군: 깔끔한 사각 단말 프레임 (잠복 중이면 점선, 엄호 중이면 이중 보강 프레임)
        ctx.fillStyle = bgFill;
        ctx.fillRect(px + pad, py + pad, cw - pad * 2, ch - pad * 2);
        ctx.strokeStyle = borderCol;
        ctx.lineWidth = u.isSelected || u.isOverwatch || u.isHunkered ? 1.5 : 1.1;
        if (u.isBurrowed) ctx.setLineDash([3, 2]);
        ctx.strokeRect(px + pad + 0.5, py + pad + 0.5, cw - pad * 2 - 1, ch - pad * 2 - 1);
        ctx.setLineDash([]);
        if (u.isHunkered) {
          ctx.strokeStyle = solid ? "rgba(12, 15, 17, 0.48)" : "rgba(207, 202, 187, 0.52)";
          ctx.lineWidth = 1;
          ctx.strokeRect(px + pad + 2.5, py + pad + 2.5, cw - pad * 2 - 5, ch - pad * 2 - 5);
        }
      }
      ctx.restore();

      // XCOM 조준 모드 잠금 표적 강조 브래킷
      if (isLocked && !u.struck) {
        drawCornerBrackets(px, py, cw, ch, PALETTE[2], -1, 6, 2);
      } else if (u.isEmpire && u.flanked && !u.struck) {
        // 측면 노출(Flanked, cover == 0) 적 강조 코너 브래킷 (민트색)
        drawCornerBrackets(px, py, cw, ch, PALETTE[3], 0.5, 5, 1.8);
      }
      // 선택 아군 강조 코너 브래킷
      if (u.isSelected) {
        drawCornerBrackets(px, py, cw, ch, PALETTE[2], 0.5, 4.5, 1.4);
      }

      // 유닛 글리프
      ctx.fillStyle = glyphCol;
      ctx.font = `bold ${view.font}px ${FONT_FAMILY}`;
      ctx.fillText(u.glyph, cx, cy);

      // 인라인 미니 체력 핍 (하단)
      if (u.maxHp > 0) {
        const maxP = u.maxHp;
        const gap = 1.2;
        const pipW = Math.min(3.5, Math.max(1.8, (cw - 8 - gap * (maxP - 1)) / maxP));
        const pipH = 2.4;
        const rowW = maxP * pipW + (maxP - 1) * gap;
        const sx = px + (cw - rowW) / 2;
        const sy = py + ch - pad - pipH - 1.5;
        const fullCol = solid
          ? PALETTE[0]
          : u.isEmpire
          ? PALETTE[4]
          : u.isAi
          ? PALETTE[5]
          : u.ap > 0 || u.isOverwatch || playing
          ? PALETTE[3]
          : PALETTE[2];
        const emptyCol = solid ? "rgba(12, 15, 17, 0.35)" : "rgba(56, 69, 74, 0.5)";
        for (let k = 0; k < maxP; k++) {
          ctx.fillStyle = k < u.hp ? fullCol : emptyCol;
          ctx.fillRect(sx + k * (pipW + gap), sy, pipW, pipH);
        }
      }

      // 아군 플레이어 유닛 AP 점 (우상단)
      if (!u.isEmpire && !u.isAi && !playing) {
        const dotR = 1.6;
        const dx0 = px + cw - pad - 3.5;
        const dy0 = py + pad + 3.5;
        for (let k = 0; k < 2; k++) {
          const yk = dy0 + k * 4.5;
          ctx.beginPath();
          ctx.arc(dx0, yk, dotR, 0, Math.PI * 2);
          if (k < u.ap) {
            ctx.fillStyle = solid ? PALETTE[0] : PALETTE[3];
            ctx.fill();
          } else {
            ctx.strokeStyle = solid ? "rgba(12, 15, 17, 0.45)" : "rgba(56, 69, 74, 0.7)";
            ctx.lineWidth = 0.9;
            ctx.stroke();
          }
        }
      }

      // 경계 태세(Overwatch) 조준경 배지 / 엄호(Hunker Down) 방패 문장 배지 (좌상단)
      if (u.isOverwatch) {
        const owCol = solid ? PALETTE[0] : u.isEmpire ? PALETTE[4] : u.isAi ? PALETTE[5] : PALETTE[3];
        const ox = px + pad + 4.8;
        const oy = py + pad + 4.8;
        ctx.save();
        ctx.strokeStyle = owCol;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(ox, oy, 2.9, 0, Math.PI * 2);
        ctx.moveTo(ox - 4.4, oy);
        ctx.lineTo(ox - 1.7, oy);
        ctx.moveTo(ox + 1.7, oy);
        ctx.lineTo(ox + 4.4, oy);
        ctx.moveTo(ox, oy - 4.4);
        ctx.lineTo(ox, oy - 1.7);
        ctx.moveTo(ox, oy + 1.7);
        ctx.lineTo(ox, oy + 4.4);
        ctx.stroke();
        ctx.restore();
      } else if (u.isHunkered) {
        const hkCol = solid ? PALETTE[0] : PALETTE[2];
        const ox = px + pad + 4.8;
        const oy = py + pad + 4.8;
        ctx.save();
        ctx.strokeStyle = hkCol;
        ctx.fillStyle = solid ? "rgba(12, 15, 17, 0.25)" : "rgba(207, 202, 187, 0.22)";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(ox, oy - 3.4);
        ctx.lineTo(ox + 3.2, oy - 2.0);
        ctx.lineTo(ox + 2.6, oy + 1.4);
        ctx.lineTo(ox, oy + 3.6);
        ctx.lineTo(ox - 2.6, oy + 1.4);
        ctx.lineTo(ox - 3.2, oy - 2.0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // 방패병(H) 정면 90도 방패 호 (실제 `shield_cover` 각도)
      if (u.shieldDir > 0) {
        const ang = ((u.shieldDir - 1) * Math.PI) / 6 - (view.rot ? Math.PI / 2 : 0);
        const rad = Math.min(cw, ch) * 0.56;
        ctx.save();
        ctx.strokeStyle = "rgba(232, 130, 63, 0.32)";
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(px + cw / 2, py + ch / 2, rad, ang - Math.PI / 4, ang + Math.PI / 4);
        ctx.stroke();
        ctx.strokeStyle = PALETTE[4];
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(px + cw / 2, py + ch / 2, rad, ang - Math.PI / 4, ang + Math.PI / 4);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 9. 조준 미리보기 레이저 (b_fx[0] === 1)
    if (bfx[0] === 1 && !playing) {
      const [x1, y1] = cellCenter(bfx[1], bfx[2]);
      const [x2, y2] = cellCenter(bfx[3], bfx[4]);
      const chance = bfx[5];
      const cover = bfx[6];
      const canShoot = bfx[7] === 1;
      const flanked = canShoot && cover === 0;

      ctx.save();
      if (canShoot) {
        ctx.strokeStyle = flanked ? "rgba(99, 214, 172, 0.85)" : "rgba(207, 202, 187, 0.65)";
        ctx.lineWidth = flanked ? 2 : 1.5;
        ctx.setLineDash(flanked ? [6, 3] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);

        // 표적 위 컴팩트 명중률 배지 (측면 노출이면 ◈ 강조)
        const badge = flanked ? `${chance}% ◈` : `${chance}%`;
        ctx.font = `bold 11px ${FONT_FAMILY}`;
        const bw = ctx.measureText(badge).width + 8;
        const bh = 16;
        const bx = Math.min(Math.max(x2 - bw / 2, 2), totalW - bw - 2);
        const by = y2 - ch * 0.65 - bh > 2 ? y2 - ch * 0.65 - bh : y2 + ch * 0.65;
        ctx.fillStyle = PALETTE[0];
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = flanked ? PALETTE[3] : PALETTE[2];
        ctx.lineWidth = 1.2;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = flanked ? PALETTE[3] : PALETTE[2];
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(badge, bx + bw / 2, by + bh / 2 + 0.5);
      } else {
        // 사선/사거리 밖 조준 차단선 + ⊘
        ctx.strokeStyle = "rgba(232, 130, 63, 0.42)";
        ctx.lineWidth = 1.3;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        drawBlockedIcon(x2, y2, Math.min(cw, ch) * 0.34, 0.85);
      }
      ctx.restore();
    }

    // 10. 실시간 애니메이션 FX (경계 슬로모 비네트/락온, 트레이서, 충격파/스파크, 빗나감, 킬 버스트, 중계 펄스, 클릭/불가 리액션)
    if (reducedMotion.matches && bfx[0] === 10) {
      drawOverwatchSlowmoStatic(bfx[1], bfx[2], bfx[3], bfx[4], PALETTE[bfx[5]] || PALETTE[4], totalW, totalH);
    }
    drawActiveFx(totalW, totalH);

    // 11. 피해/빗나감 팝업 텍스트 (wasm.damage_float, reduced-motion에서도 즉시 표시)
    const fl = wasm.damage_float();
    if (fl) {
      const [dx, dy] = toDisplay((fl >>> 8) & 0xff, (fl >>> 16) & 0xff);
      const isMiss = !!(fl & (1 << 24));
      const label = isMiss ? "빗나감" : `−${fl & 0xff}`;
      ctx.font = `bold ${Math.max(12, Math.round(view.font * 0.85))}px ${FONT_FAMILY}`;
      const w = Math.max(cw, ctx.measureText(label).width + 10);
      const h = Math.max(18, Math.round(ch * 0.68));
      const left = Math.min(Math.max(dx * cw + cw / 2 - w / 2, 2), totalW - w - 2);
      const top = dy > 0 ? dy * ch - h - 2 : (dy + 1) * ch + 2;
      ctx.fillStyle = PALETTE[0];
      ctx.fillRect(left, top, w, h);
      ctx.strokeStyle = isMiss ? PALETTE[1] : PALETTE[4];
      ctx.lineWidth = 1.3;
      ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
      ctx.fillStyle = isMiss ? PALETTE[2] : PALETTE[4];
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, left + w / 2, top + h / 2 + 0.5);
    }
  }

  function drawOverwatchSlowmoStatic(fx, fy, tx, ty, color, totalW, totalH) {
    const [x1, y1] = cellCenter(fx, fy);
    const [x2, y2] = cellCenter(tx, ty);
    const { cw, ch } = view;
    ctx.save();
    ctx.fillStyle = "rgba(6, 8, 10, 0.45)";
    ctx.fillRect(0, 0, totalW, totalH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCornerBrackets(x2 - cw * 0.55, y2 - ch * 0.55, cw * 1.1, ch * 1.1, color, 0, 7, 2);
    ctx.fillStyle = PALETTE[0];
    ctx.fillRect(0, 0, totalW, 20);
    ctx.fillStyle = color;
    ctx.fillRect(0, 19, totalW, 1.5);
    ctx.font = `bold 11px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("▸ 경계 발동 // OVERWATCH ◂", totalW / 2, 10);
    ctx.restore();
  }

  function drawOverwatchSlowmo(f, elapsed, totalW, totalH) {
    const tAll = Math.min(1, elapsed / f.dur);
    const tLock = Math.min(1, elapsed / f.lockDur);
    // 비네트·레터박스 강도: 초반 빠르게 슬로모 진입 → 락온+슬로모 사격 유지 → 사격 직후 부드럽게 복귀
    const env = tAll < 0.12 ? tAll / 0.12 : tAll > 0.78 ? (1 - tAll) / 0.22 : 1;
    const [x1, y1] = cellCenter(f.fx, f.fy);
    const [x2, y2] = cellCenter(f.tx, f.ty);
    const { cw, ch } = view;
    const cellR = Math.min(cw, ch) * 0.5;

    ctx.save();

    // 1. 슬로모 암전 비네트 + 사수/표적 스포트라이트 컷아웃
    ctx.fillStyle = `rgba(6, 8, 10, ${(0.54 * env).toFixed(3)})`;
    ctx.fillRect(0, 0, totalW, totalH);

    // 미세한 단말 스캔라인 (슬로모 정지감 강조)
    ctx.fillStyle = `rgba(12, 15, 17, ${(0.22 * env).toFixed(3)})`;
    for (let y = 0; y < totalH; y += 4) {
      ctx.fillRect(0, y, totalW, 1);
    }

    // 사수와 표적 주변에 은은한 발광 링 (어둠 속 초점 고정)
    const glowR = cellR * 1.35;
    for (const [gx, gy, col] of [
      [x1, y1, f.color],
      [x2, y2, PALETTE[2]],
    ]) {
      const grad = ctx.createRadialGradient(gx, gy, cellR * 0.15, gx, gy, glowR);
      grad.addColorStop(0, "rgba(207, 202, 187, 0.16)");
      grad.addColorStop(1, "rgba(12, 15, 17, 0)");
      ctx.fillStyle = grad;
      ctx.globalAlpha = env;
      ctx.beginPath();
      ctx.arc(gx, gy, glowR, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.55 * env;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(gx, gy, cellR * (0.85 + 0.15 * Math.sin(tLock * Math.PI * 2)), 0, Math.PI * 2);
      ctx.stroke();
    }

    // 2. 락온 단계 (0..lockDur): 사수 경보 파동 + 조준 레이저 + 수렴하는 조준 브래킷
    if (elapsed < f.lockDur + 120) {
      const lockAlpha = elapsed < f.lockDur ? 1 : Math.max(0, 1 - (elapsed - f.lockDur) / 120);
      const easeOut = 1 - Math.pow(1 - tLock, 3);

      // 사수 경계 발동 펄스 링
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = (1 - tLock) * 0.9 * lockAlpha;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(x1, y1, cellR * (0.4 + easeOut * 2.1), 0, Math.PI * 2);
      ctx.stroke();

      // 사수 → 표적 락온 레이저 시선
      const beamEnd = Math.min(1, tLock * 1.6);
      const lx = x1 + (x2 - x1) * beamEnd;
      const ly = y1 + (y2 - y1) * beamEnd;
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = 0.85 * lockAlpha;
      ctx.lineWidth = tLock > 0.72 ? 2.2 : 1.5;
      ctx.setLineDash(tLock > 0.72 ? [] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(lx, ly);
      ctx.stroke();
      ctx.setLineDash([]);

      // 조준선을 타고 흐르는 락온 펄스 점
      const beadT = (tLock * 1.8) % 1;
      ctx.fillStyle = PALETTE[2];
      ctx.globalAlpha = lockAlpha;
      ctx.beginPath();
      ctx.arc(x1 + (x2 - x1) * beadT, y1 + (y2 - y1) * beadT, 2.6, 0, Math.PI * 2);
      ctx.fill();

      // 표적 위로 수렴(Snap-in)하는 4각 조준 브래킷 + 다이아몬드 십자선
      const spread = 1.95 - easeOut * 0.95; // 1.95x -> 1.0x 로 착! 조여듦
      const bw = cw * spread;
      const bh = ch * spread;
      const lockedFlash = tLock > 0.74 && tLock < 0.92;
      const retCol = lockedFlash ? PALETTE[2] : f.color;
      ctx.globalAlpha = lockAlpha;
      drawCornerBrackets(x2 - bw / 2, y2 - bh / 2, bw, bh, retCol, 0, 7, lockedFlash ? 2.6 : 2);

      // 표적 중앙 회전 십자 틱
      const rotAng = (1 - easeOut) * (Math.PI / 4);
      ctx.save();
      ctx.translate(x2, y2);
      ctx.rotate(rotAng);
      ctx.strokeStyle = retCol;
      ctx.globalAlpha = 0.8 * lockAlpha;
      ctx.lineWidth = 1.4;
      const rIn = cellR * 0.55;
      const rOut = cellR * 0.92;
      ctx.beginPath();
      ctx.moveTo(-rOut, 0); ctx.lineTo(-rIn, 0);
      ctx.moveTo(rIn, 0); ctx.lineTo(rOut, 0);
      ctx.moveTo(0, -rOut); ctx.lineTo(0, -rIn);
      ctx.moveTo(0, rIn); ctx.lineTo(0, rOut);
      ctx.stroke();
      ctx.restore();
    }

    // 3. 시네마틱 상/하단 단말 레터박스 바 & 경계 발동 텔레메트리 배너
    const barH = Math.round(22 * env);
    if (barH > 1) {
      ctx.globalAlpha = 0.94 * env;
      ctx.fillStyle = PALETTE[0];
      ctx.fillRect(0, 0, totalW, barH);
      ctx.fillRect(0, totalH - Math.round(barH * 0.55), totalW, Math.round(barH * 0.55));

      ctx.fillStyle = f.color;
      ctx.fillRect(0, barH - 1.5, totalW, 1.5);
      ctx.fillRect(0, totalH - Math.round(barH * 0.55), totalW, 1);

      if (env > 0.45) {
        ctx.globalAlpha = Math.min(1, (env - 0.45) / 0.4);
        ctx.fillStyle = f.color;
        ctx.font = `bold 11px ${FONT_FAMILY}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const tag = elapsed < f.lockDur ? "▸ 경계 발동 // OVERWATCH LOCK ◂" : "▸ 대응 사격 // ENGAGING ◂";
        ctx.fillText(tag, totalW / 2, barH / 2);
      }
    }

    ctx.restore();
  }

  function drawActiveFx(totalW, totalH) {
    if (fxList.length === 0) return;
    const now = performance.now();
    const { cw, ch } = view;
    const cellR = Math.min(cw, ch) * 0.5;

    // 경계 슬로모 오버레이를 먼저 그려서 뒤이어 날아가는 트레이서/스파크가 암전 위에 선명하게 빛나게 한다.
    for (const f of fxList) {
      if (f.kind === "ow_slowmo") {
        drawOverwatchSlowmo(f, now - f.start, totalW, totalH);
      }
    }

    for (const f of fxList) {
      if (f.kind === "ow_slowmo") continue;
      const t = Math.min(1, (now - f.start) / f.dur);
      ctx.save();

      if (f.kind === "tracer") {
        const [x1, y1] = cellCenter(f.fx, f.fy);
        const [x2, y2] = cellCenter(f.tx, f.ty);
        const headT = Math.min(1, t * 1.45);
        const tailT = Math.max(0, t * 1.45 - 0.55);
        const hx = x1 + (x2 - x1) * headT;
        const hy = y1 + (y2 - y1) * headT;
        const tx = x1 + (x2 - x1) * tailT;
        const ty = y1 + (y2 - y1) * tailT;

        // 총구 섬광
        if (t < 0.45) {
          const mt = 1 - t / 0.45;
          ctx.fillStyle = f.color;
          ctx.globalAlpha = mt * 0.55;
          ctx.beginPath();
          ctx.arc(x1, y1, cellR * (0.35 + mt * 0.45), 0, Math.PI * 2);
          ctx.fill();
        }
        // 외곽 글로우 빔
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = (1 - t * 0.4) * (f.slow ? 0.72 : 0.55);
        ctx.lineWidth = f.slow ? 6.5 : 5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        // 중심 백열 코어
        ctx.strokeStyle = PALETTE[2];
        ctx.globalAlpha = 1 - t * 0.35;
        ctx.lineWidth = f.slow ? 2.5 : 2;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      } else if (f.kind === "hit") {
        const [cx, cy] = cellCenter(f.x, f.y);
        // 충격파 링
        ctx.strokeStyle = PALETTE[2];
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 2.4 * (1 - t * 0.6);
        ctx.beginPath();
        ctx.arc(cx, cy, cellR * (0.25 + t * 1.1), 0, Math.PI * 2);
        ctx.stroke();
        // 방향성 스파크
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 1.8;
        for (const s of f.sparks) {
          const a = s.ang - (view.rot ? Math.PI / 2 : 0);
          const d0 = cellR * (0.15 + t * s.spd * 1.1);
          const d1 = d0 + cellR * 0.32 * (1 - t);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0);
          ctx.lineTo(cx + Math.cos(a) * d1, cy + Math.sin(a) * d1);
          ctx.stroke();
        }
      } else if (f.kind === "miss") {
        const [x1, y1] = cellCenter(f.tx, f.ty);
        const [x2, y2] = cellCenter(f.ex, f.ey);
        ctx.strokeStyle = PALETTE[2];
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + (x2 - x1) * Math.min(1, t * 1.4), y1 + (y2 - y1) * Math.min(1, t * 1.4));
        ctx.stroke();
        ctx.setLineDash([]);
        // 도탄 스파크
        const base = f.ang - (view.rot ? Math.PI / 2 : 0);
        ctx.strokeStyle = PALETTE[1];
        for (const off of [-0.55, 0.55, -0.95, 0.95]) {
          const a = base + off;
          const r0 = cellR * (0.2 + t * 0.65);
          const r1 = r0 + 5 * (1 - t);
          ctx.beginPath();
          ctx.moveTo(x1 + Math.cos(a) * r0, y1 + Math.sin(a) * r0);
          ctx.lineTo(x1 + Math.cos(a) * r1, y1 + Math.sin(a) * r1);
          ctx.stroke();
        }
      } else if (f.kind === "kill") {
        const [cx, cy] = cellCenter(f.x, f.y);
        // 킬 충격 × 버스트
        const sz = cellR * (0.45 + t * 0.65);
        ctx.strokeStyle = PALETTE[4];
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 2.6 * (1 - t * 0.5);
        ctx.beginPath();
        ctx.moveTo(cx - sz, cy - sz);
        ctx.lineTo(cx + sz, cy + sz);
        ctx.moveTo(cx + sz, cy - sz);
        ctx.lineTo(cx - sz, cy + sz);
        ctx.stroke();
        ctx.strokeStyle = PALETTE[2];
        ctx.lineWidth = 1.6;
        for (const s of f.sparks) {
          const d0 = cellR * (0.2 + t * s.spd * 1.25);
          const d1 = d0 + cellR * 0.35 * (1 - t);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(s.ang) * d0, cy + Math.sin(s.ang) * d0);
          ctx.lineTo(cx + Math.cos(s.ang) * d1, cy + Math.sin(s.ang) * d1);
          ctx.stroke();
        }
      } else if (f.kind === "smoke_pop") {
        const [cx, cy] = cellCenter(f.x, f.y);
        ctx.strokeStyle = PALETTE[2];
        ctx.globalAlpha = (1 - t) * 0.65;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, cellR * (0.6 + t * 2.5), 0, Math.PI * 2);
        ctx.stroke();
      } else if (f.kind === "burrow") {
        const [cx, cy] = cellCenter(f.x, f.y);
        ctx.strokeStyle = PALETTE[3];
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, cellR * (1.1 - t * 0.8), 0, Math.PI * 2);
        ctx.stroke();
      } else if (f.kind === "retreat") {
        const [cx, cy] = cellCenter(f.x, f.y);
        ctx.strokeStyle = PALETTE[3];
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 2;
        const shift = t * cellR * 1.5;
        const ox = view.rot ? 0 : -shift;
        const oy = view.rot ? shift : 0;
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, cellR * (0.5 + t * 0.5), 0, Math.PI * 2);
        ctx.stroke();
      } else if (f.kind === "overwatch_set") {
        // 경계 진입 시 퍼지는 조준경 링 + 십자 눈금 + "경계" 마이크로 태그
        const [cx, cy] = cellCenter(f.x, f.y);
        const rad = cellR * (0.45 + t * 1.25);
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.moveTo(cx - rad - 3, cy); ctx.lineTo(cx - rad + 4, cy);
        ctx.moveTo(cx + rad - 4, cy); ctx.lineTo(cx + rad + 3, cy);
        ctx.moveTo(cx, cy - rad - 3); ctx.lineTo(cx, cy - rad + 4);
        ctx.moveTo(cx, cy + rad - 4); ctx.lineTo(cx, cy + rad + 3);
        ctx.stroke();
        ctx.fillStyle = f.color;
        ctx.font = `bold 10px ${FONT_FAMILY}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("경계", cx, cy - cellR - 6 - t * 8);
      } else if (f.kind === "hunker") {
        // 엄호 진입 시 수축하는 방패 육각형 + "엄호 +30" 마이크로 태그
        const [cx, cy] = cellCenter(f.x, f.y);
        const rad = cellR * (1.28 - t * 0.55);
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = 1 - t * 0.85;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - rad);
        ctx.lineTo(cx + rad * 0.88, cy - rad * 0.48);
        ctx.lineTo(cx + rad * 0.72, cy + rad * 0.45);
        ctx.lineTo(cx, cy + rad);
        ctx.lineTo(cx - rad * 0.72, cy + rad * 0.45);
        ctx.lineTo(cx - rad * 0.88, cy - rad * 0.48);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = f.color;
        ctx.font = `bold 10px ${FONT_FAMILY}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("엄호 +30", cx, cy - cellR - 6 - t * 8);
      } else if (f.kind === "relay_link") {
        // 제국 턴 개시 시 중계기(&)에서 제국 분대로 퍼지는 동기화 파동
        ctx.strokeStyle = PALETTE[4];
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.72;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 4]);
        for (const [rx, ry, ex, ey] of f.links) {
          const [x1, y1] = cellCenter(rx, ry);
          const [x2, y2] = cellCenter(ex, ey);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const [rx, ry] of f.relays) {
          const [cx, cy] = cellCenter(rx, ry);
          ctx.globalAlpha = (1 - t) * 0.85;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(cx, cy, cellR * (0.4 + t * 2.2), 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (f.kind === "relay_sever") {
        // 중계기 파괴 시 끊어지는 신호선
        ctx.strokeStyle = PALETTE[4];
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([2, 6]);
        for (const [rx, ry, ex, ey] of f.links) {
          const [x1, y1] = cellCenter(rx, ry);
          const [x2, y2] = cellCenter(ex, ey);
          const mx = x1 + (x2 - x1) * (1 - t * 0.65);
          const my = y1 + (y2 - y1) * (1 - t * 0.65);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(mx, my);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      } else if (f.kind === "pulse") {
        const [cx, cy] = cellCenter(f.x, f.y);
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 2 * (1 - t * 0.5);
        ctx.strokeRect(
          cx - cw * (0.45 + t * 0.25),
          cy - ch * (0.45 + t * 0.25),
          cw * (0.9 + t * 0.5),
          ch * (0.9 + t * 0.5),
        );
      } else if (f.kind === "invalid") {
        const [dx, dy] = toDisplay(f.x, f.y);
        const shake = Math.sin(t * Math.PI * 5) * (1 - t) * 4;
        const px = dx * cw + shake;
        const py = dy * ch;
        ctx.globalAlpha = 1 - t * 0.85;
        ctx.fillStyle = "rgba(232, 130, 63, 0.25)";
        ctx.fillRect(px + 1, py + 1, cw - 2, ch - 2);
        ctx.strokeStyle = PALETTE[4];
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, cw - 2, ch - 2);
        drawBlockedIcon(px + cw / 2, py + ch / 2, Math.min(cw, ch) * 0.32, 1 - t * 0.6);
      }

      ctx.restore();
    }
  }

  let hoveredChipIndex = -1;

  function hpPips(hp, maxHp) {
    const n = Math.max(0, Math.min(hp, maxHp));
    return "●".repeat(n) + "○".repeat(Math.max(0, maxHp - n));
  }

  function parseTargets(raw) {
    if (!raw) return [];
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const [x, y, glyph, name, hp, maxHp, chance, aim, cover, falloff] = line.split("\t");
      out.push({
        x: Number(x),
        y: Number(y),
        glyph,
        name,
        hp: Number(hp),
        maxHp: Number(maxHp),
        chance: Number(chance),
        aim: Number(aim),
        cover: Number(cover),
        falloff: Number(falloff),
      });
    }
    return out;
  }

  function formatTargetReadout(t) {
    const cov = t.cover > 0 ? `−${t.cover}` : "0";
    const fall = t.falloff > 0 ? `−${t.falloff}` : "0";
    const detail = `${t.glyph} ${t.name} ${hpPips(t.hp, t.maxHp)} ${t.hp}/${t.maxHp} │ 조준 ${t.aim} · 엄폐 ${cov} · 거리 ${fall}`;
    const result = t.cover === 0 ? `명중 ${t.chance}% ◈ 측면` : `명중 ${t.chance}%`;
    return [detail, result];
  }

  function renderTargetChips(rawTargets, done) {
    if (!els.targetList) return;
    const key = `${rawTargets}|${playing ? 1 : 0}|${done ? 1 : 0}`;
    if (key !== lastTargetsKey) {
      lastTargetsKey = key;
      hoveredChipIndex = -1;
      els.targetList.innerHTML = "";
      if (playing) {
        const span = document.createElement("span");
        span.className = "tgt-empty";
        span.textContent = "교전 진행 중…";
        els.targetList.appendChild(span);
      } else if (done) {
        const span = document.createElement("span");
        span.className = "tgt-empty";
        span.textContent = "교전 종료";
        els.targetList.appendChild(span);
      } else if (currentTargets.length === 0) {
        const span = document.createElement("span");
        span.className = "tgt-empty";
        span.textContent = "사선 내 적 없음";
        els.targetList.appendChild(span);
      } else {
        currentTargets.forEach((t, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `tgt-chip${t.cover === 0 ? " flanked" : ""}`;
          btn.dataset.idx = String(idx);
          btn.title = `${t.name} (체력 ${t.hp}/${t.maxHp}) · 클릭해 조준 / 재클릭 발사`;
          btn.innerHTML = `<span>${t.glyph} ${t.name}</span><span class="tgt-hp">${hpPips(t.hp, t.maxHp)}</span><span class="tgt-pct">${t.chance}%</span>`;
          btn.addEventListener("mouseenter", () => {
            if (playing || done) return;
            hoveredChipIndex = idx;
            wasm.hover(t.x, t.y);
            draw();
          });
          btn.addEventListener("mouseleave", () => {
            if (hoveredChipIndex === idx) hoveredChipIndex = -1;
            if (playing || done) return;
            if (aimMode && currentTargets[aimIndex]) {
              wasm.hover(currentTargets[aimIndex].x, currentTargets[aimIndex].y);
            } else {
              wasm.hover(-1, -1);
            }
            draw();
          });
          btn.addEventListener("click", (ev) => {
            ev.currentTarget.blur();
            if (skipIfPlaying() || wasm.battle_done()) return;
            if (aimMode && aimIndex === idx) {
              confirmFire();
            } else {
              selectAimTarget(idx);
            }
          });
          els.targetList.appendChild(btn);
        });
      }
    }

    // DOM을 재생성하지 않고 잠금 상태(.active)만 부드럽게 갱신한다.
    const chips = els.targetList.querySelectorAll(".tgt-chip");
    chips.forEach((el, idx) => {
      el.classList.toggle("active", aimMode && idx === aimIndex);
    });
  }

  function renderUnitBadge(raw) {
    if (!els.unitBadge || raw === lastBadgeRaw) return 0;
    lastBadgeRaw = raw;
    const [glyph, name, hpStr, maxStr, apStr, tag, , , readyStr] = (raw || "").split("\t");
    if (!glyph) {
      els.unitBadge.innerHTML = `<span class="u-ap">대기</span>`;
      return Number(readyStr || 0);
    }
    const hp = Number(hpStr || 0);
    const maxHp = Number(maxStr || 0);
    const ap = Number(apStr || 0);
    const tagHtml = tag ? `<span class="u-tag">[${tag}]</span>` : "";
    els.unitBadge.innerHTML = `<span class="u-g">${glyph}</span><span>${name}</span><span class="u-hp">${hpPips(hp, maxHp)}</span><span class="u-ap">AP ${ap}</span>${tagHtml}`;
    return Number(readyStr || 0);
  }

  function draw() {
    const bytes = new Uint8Array(wasm.memory.buffer, wasm.text_ptr(), wasm.text_len());
    const parts = new TextDecoder().decode(bytes).split("\u001f");
    const done = !!wasm.battle_done();

    // 사선 내 표적 파싱 및 XCOM 조준 모드 동기화 (캔버스 그리기 전에 완료)
    const rawTargets = parts[10] ?? "";
    currentTargets = playing || done ? [] : parseTargets(rawTargets);
    if (playing || done || currentTargets.length === 0) {
      aimMode = false;
      aimIndex = 0;
    } else if (aimIndex >= currentTargets.length) {
      aimIndex = 0;
    }

    drawCanvasOnly();

    const setText = (el, val) => {
      if (el && el.textContent !== val) el.textContent = val;
    };
    setText(els.status, parts[0] ?? "");
    setText(els.headerEl, parts[6] ?? "");
    setText(els.aiNoteEl, parts[7] ?? "");
    renderRoster(parts[4] ?? "");
    renderTargetChips(rawTargets, done);

    const selRaw = parts[11] ?? "";
    const readyCount = Number((selRaw.split("\t")[8]) || 0);
    renderUnitBadge(selRaw);

    // 상단 스트립 우측 명중률/체력 리드아웃 (단일 줄 컴팩트 요약)
    const activeChip =
      hoveredChipIndex >= 0 && currentTargets[hoveredChipIndex]
        ? currentTargets[hoveredChipIndex]
        : aimMode && currentTargets[aimIndex]
        ? currentTargets[aimIndex]
        : null;
    let detail = "";
    let result = "";
    if (activeChip && !playing && !done) {
      [detail, result] = formatTargetReadout(activeChip);
    } else if (parts[2] && !playing && !done) {
      const lines = (parts[1] ?? "")
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const matchedTarget = hoverCell
        ? currentTargets.find((t) => t.x === hoverCell[0] && t.y === hoverCell[1])
        : null;
      if (matchedTarget) {
        [detail, result] = formatTargetReadout(matchedTarget);
      } else {
        detail = lines.join(" · ");
        result = parts[2].replace(/\s+/g, " ").trim();
      }
    } else if (pending && !playing && !done) {
      detail = "이동 예정 · 실행 또는 재탭으로 확정";
    } else if (done) {
      detail = parts[0] ?? "";
    } else if (!playing) {
      detail =
        currentTargets.length > 0
          ? "표적 클릭·[1] 조준 · [Tab] 전환"
          : "이동 타일 클릭 · [Tab] 분대원 전환";
    }
    setText(els.readoutDetail, detail);
    setText(els.readoutResult, result);

    // XCOM 조준 모드 UI 상태
    if (els.hudEl) els.hudEl.classList.toggle("aim-mode", aimMode);
    if (els.aimActions) els.aimActions.hidden = !aimMode || playing || done;

    // 액션 바 버튼 활성/비활성 및 표시 상태
    const canAttack = !playing && !done && currentTargets.length > 0;
    const canOverwatch = !playing && !done && !!(parts[8] ?? "");
    const canHunker = !playing && !done && !!(parts[9] ?? "");
    const ability = parts[3] ?? "";
    const canBurrow = !playing && !done && !!ability;
    const canRetreat = !playing && !done && !!(parts[5] ?? "");

    if (els.attackBtn) {
      els.attackBtn.disabled = !canAttack;
      els.attackBtn.classList.toggle("ready", canAttack && !aimMode);
      els.attackBtn.classList.toggle("active", aimMode);
    }
    setText(els.attackCount, currentTargets.length > 0 ? `(${currentTargets.length})` : "");
    if (els.overwatchBtn) els.overwatchBtn.disabled = !canOverwatch;
    if (els.hunkerBtn) els.hunkerBtn.disabled = !canHunker;
    const burrowBtn = els.burrowBtn || els.abilityBtn;
    if (burrowBtn) {
      burrowBtn.hidden = !ability;
      burrowBtn.disabled = !canBurrow;
    }
    if (els.retreatBtn) {
      els.retreatBtn.hidden = !(parts[5] ?? "");
      els.retreatBtn.disabled = !canRetreat;
    }
    if (els.prevUnitBtn) els.prevUnitBtn.disabled = playing || done;
    if (els.nextUnitBtn) els.nextUnitBtn.disabled = playing || done;

    if (els.returnBtn) els.returnBtn.hidden = !done;
    if (els.endBtn) {
      els.endBtn.hidden = done && !!els.returnBtn;
      els.endBtn.disabled = playing || done;
      els.endBtn.classList.toggle("all-done", !playing && !done && readyCount === 0);
    }
    if (els.confirmBtn) els.confirmBtn.hidden = playing || done || !pending;
    if (els.seedEl && cfg.getSeed) els.seedEl.textContent = `시드 ${cfg.getSeed()}`;
  }

  function renderRoster(raw) {
    if (!rosterList || raw === lastRosterRaw) return;
    lastRosterRaw = raw;
    rosterList.innerHTML = "";
    for (const line of raw.split("\n").filter(Boolean)) {
      const [x, y, sel, glyph, name, pips, ap, tag] = line.split("\t");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = sel === "1" ? "roster-row selected" : "roster-row";
      btn.innerHTML = `<span class="roster-glyph">${glyph}</span><span>${name}</span><span class="roster-pips">${pips}</span><span class="roster-ap">${ap}</span><span class="roster-tag">${tag || ""}</span>`;
      btn.addEventListener("click", () => {
        if (rosterModal) rosterModal.hidden = true;
        if (skipIfPlaying()) return;
        clearPending();
        aimMode = false;
        act(Number(x), Number(y));
        draw();
      });
      rosterList.appendChild(btn);
    }
  }

  function unitAt(x, y) {
    return parseUnits().find((u) => u.x === x && u.y === y) || null;
  }

  function isReachable(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    return !!(metaNow()[y * COLS + x] & (1 << 4));
  }

  function cellAt(ev, snap) {
    const r = canvas.getBoundingClientRect();
    const fx = ((ev.clientX - r.left) / r.width) * view.cols;
    const fy = ((ev.clientY - r.top) / r.height) * view.rows;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    if (!snap) return toGame(cx, cy);

    const units = parseUnits();
    const hasUnitAt = (dx, dy) => {
      if (dx < 0 || dy < 0 || dx >= view.cols || dy >= view.rows) return false;
      const [gx, gy] = toGame(dx, dy);
      return units.some((u) => u.x === gx && u.y === gy);
    };
    if (hasUnitAt(cx, cy)) return toGame(cx, cy);
    let best = null;
    let bestD = SNAP;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!hasUnitAt(cx + ox, cy + oy)) continue;
        const d = Math.hypot(fx - (cx + ox + 0.5), fy - (cy + oy + 0.5));
        if (d < bestD) {
          bestD = d;
          best = [cx + ox, cy + oy];
        }
      }
    }
    return best ? toGame(best[0], best[1]) : toGame(cx, cy);
  }

  function ensureSelected(silent = false) {
    if (playing || wasm.battle_done()) return false;
    const res = wasm.ensure_selected();
    if (res & (1 << 16)) {
      const x = res & 0xff;
      const y = (res >>> 8) & 0xff;
      if (cfg.onEvent) cfg.onEvent([x, y]);
      if (!silent) draw();
      return true;
    }
    return false;
  }

  function cycleUnit(dir = 1) {
    if (skipIfPlaying() || wasm.battle_done()) return;
    clearPending();
    aimMode = false;
    hoveredChipIndex = -1;
    const res = wasm.select_next(dir >= 0 ? 1 : -1);
    if (res & (1 << 16)) {
      const x = res & 0xff;
      const y = (res >>> 8) & 0xff;
      if (cfg.onEvent) cfg.onEvent([x, y]);
      pushFx({ kind: "pulse", x, y, color: PALETTE[3], dur: 260 });
    }
    draw();
  }

  function selectAimTarget(idx) {
    if (playing || wasm.battle_done() || currentTargets.length === 0) return;
    const n = currentTargets.length;
    aimIndex = ((idx % n) + n) % n;
    aimMode = true;
    pending = null;
    const t = currentTargets[aimIndex];
    wasm.hover(t.x, t.y);
    pushFx({ kind: "pulse", x: t.x, y: t.y, color: PALETTE[4], dur: 240 });
    draw();
  }

  function cycleTarget(dir = 1) {
    if (!aimMode || currentTargets.length === 0) return;
    selectAimTarget(aimIndex + (dir >= 0 ? 1 : -1));
  }

  function cancelAim() {
    if (!aimMode) return;
    aimMode = false;
    hoveredChipIndex = -1;
    if (hoverCell) wasm.hover(hoverCell[0], hoverCell[1]);
    else wasm.hover(-1, -1);
    draw();
  }

  function confirmFire() {
    if (skipIfPlaying() || wasm.battle_done()) return;
    if (!aimMode || !currentTargets[aimIndex]) return;
    const t = currentTargets[aimIndex];
    aimMode = false;
    hoveredChipIndex = -1;
    pending = null;
    act(t.x, t.y);
  }

  function pressAttack() {
    if (skipIfPlaying() || wasm.battle_done()) return;
    if (currentTargets.length === 0) return;
    if (aimMode) {
      confirmFire();
    } else {
      selectAimTarget(0);
    }
  }

  function act(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    aimMode = false;
    hoveredChipIndex = -1;
    const units = parseUnits();
    const sel = units.find((u) => u.isSelected);
    const targetU = units.find((u) => u.x === x && u.y === y);
    const m = metaNow()[y * COLS + x];
    const tile = m & 0x3;
    const reach = !!(m & (1 << 4));

    // 항상 1명의 분대원 선택을 유지: 자기 자신·AI 아군·벽·이동불가·사선불가 적 클릭은 리액션만 주고 선택을 유지한다.
    if (sel && targetU && (targetU.isSelected || targetU.isAi)) {
      pushFx({ kind: "pulse", x, y, color: targetU.isAi ? PALETTE[5] : PALETTE[3], dur: 220 });
      draw();
      return;
    }
    if (sel && targetU && targetU.isEmpire && !targetU.inFireLane) {
      pushFx({ kind: "invalid", x, y, dur: 320 });
      draw();
      return;
    }
    if (sel && !targetU && !reach) {
      pushFx({ kind: tile !== 0 ? "invalid" : "pulse", x, y, color: PALETTE[1], dur: tile !== 0 ? 320 : 220 });
      draw();
      return;
    }

    // 유효 클릭 즉각 리액션 (분대원 전환 펄스, 이동 펄스)
    if (targetU && !targetU.isEmpire) {
      pushFx({ kind: "pulse", x, y, color: targetU.isAi ? PALETTE[5] : PALETTE[3], dur: 260 });
    } else if (sel && reach) {
      pushFx({ kind: "pulse", x, y, color: PALETTE[3], dur: 260 });
    }

    if (wasm.click(x, y) && cfg.onEvent) {
      cfg.onEvent([x, y]);
    }
    play();
  }

  function clearPending() {
    pending = null;
    wasm.hover(-1, -1);
  }

  function showPop(x, y, clientX, clientY) {
    if (!popEl) return false;
    const len = x >= 0 && y >= 0 && x < COLS && y < ROWS ? wasm.inspect(x, y) : 0;
    if (!len) {
      popEl.hidden = true;
      return false;
    }
    popEl.textContent = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.popup_ptr(), len));
    popEl.hidden = false;
    const isFixed = getComputedStyle(popEl).position === "fixed";
    const r = canvas.getBoundingClientRect();
    const [dx, dy] = toDisplay(x, y);
    if (isFixed && clientX !== undefined && clientY !== undefined) {
      const left = Math.min(Math.max(clientX + 12, 8), window.innerWidth - popEl.offsetWidth - 8);
      let top = clientY - popEl.offsetHeight - 10;
      if (top < 8) top = clientY + 16;
      popEl.style.left = `${left}px`;
      popEl.style.top = `${top}px`;
    } else {
      const pr = popEl.offsetParent ? popEl.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
      const cellX = r.left - pr.left + ((dx + 0.5) * r.width) / view.cols;
      const cellY = r.top - pr.top + (dy * r.height) / view.rows;
      const maxLeft = (popEl.offsetParent ? popEl.offsetParent.clientWidth : document.documentElement.clientWidth) - popEl.offsetWidth - 4;
      const left = Math.min(Math.max(cellX - popEl.offsetWidth / 2, 4), Math.max(4, maxLeft));
      let top = cellY - popEl.offsetHeight - 8;
      if (top < 4) top = cellY + r.height / view.rows + 8;
      popEl.style.left = `${left}px`;
      popEl.style.top = `${top}px`;
    }
    return true;
  }

  function hidePop() {
    clearTimeout(holdTimer);
    holdStart = null;
    if (popEl) popEl.hidden = true;
  }

  function endTurn() {
    if (skipIfPlaying()) return;
    if (wasm.battle_done()) return;
    clearPending();
    aimMode = false;
    hoveredChipIndex = -1;
    wasm.end_turn();
    if (cfg.onEvent) cfg.onEvent("e");
    play();
  }

  function useAbility() {
    const btn = els.burrowBtn || els.abilityBtn;
    if (btn && (btn.disabled || btn.hidden)) return;
    if (skipIfPlaying() || wasm.battle_done()) return;
    clearPending();
    aimMode = false;
    if (wasm.ability() && cfg.onEvent) cfg.onEvent("b");
    play();
  }

  function useOverwatch() {
    if (els.overwatchBtn && els.overwatchBtn.disabled) return;
    if (skipIfPlaying() || wasm.battle_done()) return;
    clearPending();
    aimMode = false;
    if (wasm.overwatch() && cfg.onEvent) cfg.onEvent("o");
    play();
  }

  function useHunker() {
    if (els.hunkerBtn && els.hunkerBtn.disabled) return;
    if (skipIfPlaying() || wasm.battle_done()) return;
    clearPending();
    aimMode = false;
    if (wasm.hunker() && cfg.onEvent) cfg.onEvent("h");
    play();
  }

  function useRetreat() {
    if (els.retreatBtn && (els.retreatBtn.disabled || els.retreatBtn.hidden)) return;
    if (skipIfPlaying() || wasm.battle_done()) return;
    clearPending();
    aimMode = false;
    if (wasm.retreat() && cfg.onEvent) cfg.onEvent("r");
    play();
  }

  function handleKey(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (ev.code === "Tab") {
      ev.preventDefault();
      if (aimMode && currentTargets.length > 0) cycleTarget(ev.shiftKey ? -1 : 1);
      else cycleUnit(ev.shiftKey ? -1 : 1);
      return true;
    }
    if (ev.code === "Digit1") {
      ev.preventDefault();
      pressAttack();
      return true;
    }
    if (ev.code === "Digit2" || ev.code === "KeyO") {
      ev.preventDefault();
      useOverwatch();
      return true;
    }
    if (ev.code === "Digit3" || ev.code === "KeyH") {
      ev.preventDefault();
      useHunker();
      return true;
    }
    if (ev.code === "Digit4" || ev.code === "KeyB") {
      ev.preventDefault();
      useAbility();
      return true;
    }
    if (ev.code === "Digit5" || ev.code === "KeyR") {
      ev.preventDefault();
      useRetreat();
      return true;
    }
    if (ev.code === "Enter") {
      if (aimMode) {
        ev.preventDefault();
        confirmFire();
        return true;
      }
      if (pending) {
        ev.preventDefault();
        const [x, y] = pending;
        clearPending();
        act(x, y);
        return true;
      }
      return false;
    }
    if (ev.code === "Escape") {
      if (aimMode) {
        ev.preventDefault();
        cancelAim();
        return true;
      }
      if (pending) {
        ev.preventDefault();
        clearPending();
        draw();
        return true;
      }
      return false;
    }
    if (ev.code === "Space") {
      ev.preventDefault();
      endTurn();
      return true;
    }
    return false;
  }

  function reset() {
    pending = null;
    hoverCell = null;
    playing = false;
    skipRequested = false;
    aimMode = false;
    aimIndex = 0;
    currentTargets = [];
    hoveredChipIndex = -1;
    lastRosterRaw = "";
    lastTargetsKey = "";
    lastBadgeRaw = "";
    fxList = [];
  }

  // 입력 바인딩
  canvas.addEventListener("pointerdown", (ev) => {
    lastPointer = ev.pointerType;
    swallowClick = false;
    if (ev.pointerType === "mouse") return;
    holdStart = [ev.clientX, ev.clientY];
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      const [x, y] = cellAt(ev, true);
      if (showPop(x, y, ev.clientX, ev.clientY)) swallowClick = true;
    }, HOLD_MS);
  });

  canvas.addEventListener("pointerup", (ev) => {
    if (ev.pointerType !== "mouse") hidePop();
  });
  canvas.addEventListener("pointercancel", hidePop);
  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (aimMode) cancelAim();
  });

  canvas.addEventListener("click", (ev) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (skipIfPlaying()) return;
    if (wasm.battle_done()) return;

    if (lastPointer === "mouse") {
      const [x, y] = cellAt(ev, false);
      act(x, y);
      showPop(x, y, ev.clientX, ev.clientY);
      draw();
      return;
    }
    const [x, y] = cellAt(ev, true);
    const u = unitAt(x, y);
    if (pending && pending[0] === x && pending[1] === y) {
      clearPending();
      act(x, y);
    } else if (u && !u.isEmpire && !u.isAi) {
      clearPending();
      act(x, y);
    } else if ((u && u.isEmpire) || isReachable(x, y)) {
      aimMode = false;
      pending = [x, y];
      wasm.hover(x, y);
      pushFx({ kind: "pulse", x, y, color: u && u.isEmpire ? PALETTE[4] : PALETTE[3], dur: 220 });
    } else {
      clearPending();
      act(x, y);
    }
    draw();
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "mouse") {
      if (holdStart && Math.hypot(ev.clientX - holdStart[0], ev.clientY - holdStart[1]) > 10) hidePop();
      return;
    }
    lastPointer = "mouse";
    const [x, y] = cellAt(ev, false);
    hoverCell = [x, y];
    showPop(x, y, ev.clientX, ev.clientY);
    if (playing) return;
    if (aimMode && currentTargets[aimIndex]) {
      const hitIdx = currentTargets.findIndex((t) => t.x === x && t.y === y);
      if (hitIdx >= 0) wasm.hover(x, y);
      else wasm.hover(currentTargets[aimIndex].x, currentTargets[aimIndex].y);
    } else {
      wasm.hover(x, y);
    }
    draw();
  });

  canvas.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType !== "mouse") return;
    hoverCell = null;
    hidePop();
    if (playing) return;
    if (aimMode && currentTargets[aimIndex]) {
      wasm.hover(currentTargets[aimIndex].x, currentTargets[aimIndex].y);
    } else {
      wasm.hover(-1, -1);
    }
    draw();
  });

  const bindBtn = (el, fn) => {
    if (!el) return;
    el.addEventListener("click", (ev) => {
      ev.currentTarget.blur();
      fn();
    });
  };
  bindBtn(els.prevUnitBtn, () => cycleUnit(-1));
  bindBtn(els.nextUnitBtn, () => cycleUnit(1));
  bindBtn(els.attackBtn, pressAttack);
  bindBtn(els.fireBtn, confirmFire);
  bindBtn(els.cancelAimBtn, cancelAim);
  bindBtn(els.overwatchBtn, useOverwatch);
  bindBtn(els.hunkerBtn, useHunker);
  bindBtn(els.burrowBtn || els.abilityBtn, useAbility);
  bindBtn(els.retreatBtn, useRetreat);
  bindBtn(els.endBtn, endTurn);
  bindBtn(els.confirmBtn, () => {
    if (skipIfPlaying() || !pending) return;
    const [x, y] = pending;
    clearPending();
    act(x, y);
  });

  return {
    layout,
    draw,
    play,
    skipIfPlaying,
    clearPending,
    reset,
    endTurn,
    useAbility,
    useOverwatch,
    useHunker,
    useRetreat,
    ensureSelected,
    cycleUnit,
    pressAttack,
    confirmFire,
    cancelAim,
    handleKey,
    hidePop,
    isPlaying: () => playing,
  };
}
