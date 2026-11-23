// 단독 전술 전투 화면: 세이브/불러오기/단축키를 관리하고 렌더링·입력은 battle_view.js에 위임한다.
import { createBattleView } from "./battle_view.js";

const SAVE_KEY = "crispy-octo-umbrella/save";
const SAVE_VERSION = 1;
const $ = (id) => document.getElementById(id);

const { instance } = await WebAssembly.instantiateStreaming(fetch("game.wasm"));
const wasm = instance.exports;

let save = { v: SAVE_VERSION, seed: 0, events: [] };
const rosterModal = $("roster-modal");

function persist() {
  save.fp = wasm.fingerprint_lo();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // 저장 공간을 못 쓰는 환경이면 파일 내보내기만 쓴다.
  }
}

function fail(message) {
  $("err").textContent = message;
}

const battle = createBattleView({
  wasm,
  canvas: $("screen"),
  mainEl: document.querySelector("main"),
  popEl: $("pop"),
  rosterModal,
  rosterList: $("roster-list"),
  els: {
    status: $("status"),
    ledger: $("ledger"),
    result: $("result"),
    abilityBtn: $("ability"),
    abilityName: $("ability-name"),
    overwatchBtn: $("overwatch"),
    retreatBtn: $("retreat"),
    confirmBtn: $("confirm"),
    aimEl: $("aim"),
    endBtn: $("end"),
    endBtn2: $("end2"),
    seedEl: $("seed"),
  },
  getSeed: () => save.seed,
  onEvent: (ev) => {
    save.events.push(ev);
    persist();
  },
});

function newGame(seed) {
  battle.reset();
  save = { v: SAVE_VERSION, seed, events: [] };
  wasm.init(seed);
  persist();
  battle.draw();
}

function load(data) {
  if (!data || data.v !== SAVE_VERSION || !Number.isInteger(data.seed) || !Array.isArray(data.events)) {
    throw new Error("세이브 형식이 맞지 않음");
  }
  battle.reset();
  wasm.init(data.seed);
  for (const e of data.events) {
    if (e === "e") wasm.end_turn();
    else if (e === "b") wasm.ability();
    else if (e === "o") wasm.overwatch();
    else if (e === "r") wasm.retreat();
    else if (Array.isArray(e) && e.length === 2) wasm.click(e[0] | 0, e[1] | 0);
    else throw new Error("세이브 형식이 맞지 않음");
  }
  wasm.skip();
  if (data.fp !== undefined && data.fp !== wasm.fingerprint_lo()) {
    throw new Error("다른 버전에서 만든 세이브라 재현이 안 됨");
  }
  save = { v: SAVE_VERSION, seed: data.seed, events: data.events };
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    battle.layout();
    battle.draw();
  }, 100);
});

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
    battle.endTurn();
  } else if (ev.code === "KeyO" && !$("overwatch").hasAttribute("data-off")) {
    battle.useOverwatch();
  } else if (ev.code === "KeyB" && !$("ability").hasAttribute("data-off")) {
    battle.useAbility();
  } else if (ev.code === "KeyR" && !$("retreat").hasAttribute("data-off")) {
    battle.useRetreat();
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
  battle.draw();
});

battle.layout();
try {
  load(JSON.parse(localStorage.getItem(SAVE_KEY)));
  battle.draw();
} catch {
  newGame(crypto.getRandomValues(new Uint32Array(1))[0]);
}
