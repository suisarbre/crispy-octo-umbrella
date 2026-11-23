//! 브라우저와 코어 사이의 얇은 경계. wasm-bindgen 없이 숫자와 포인터만 주고받는다.
//! JS는 `frame_ptr`에서 칸 배열을, `text_ptr`에서 문구를 읽어 그리기만 한다.
//!
//! 코어는 입력을 받는 즉시 결과까지 계산한다. 여기서는 그 사이에 일어난 일(`sim::Event`)을
//! 한 박자씩 풀어서 보여준다. 화면은 `view`(보여주는 중인 위치와 체력)를 그리고,
//! 재생이 끝나면 `view`는 코어의 실제 상태와 같아진다.

pub mod world;

use std::collections::VecDeque;

use sim::{dist, rank_label, BattleConfig, BattleObjective, Class, Event, Game, Pos, Side, Tile, H, SIGHT, W};

/// 팔레트 번호. 실제 색은 www/main.js가 정한다.
pub const BG: u32 = 0;
pub const DIM: u32 = 1;
pub const FG: u32 = 2;
pub const BROOD: u32 = 3;
pub const EMPIRE: u32 = 4;
/// 아군 색을 흐리게 한 것. 월드 아군 일반군·비선택 경로, 전투 합동 아군 AI에 쓴다.
pub const BROOD_DIM: u32 = 5;

/// `advance`가 돌려주는 박자 종류. 상위 16비트에 종류, 하위 16비트에 길이(ms).
pub const BEAT_STEP: u32 = 1;
pub const BEAT_TRACER: u32 = 2;
pub const BEAT_HIT: u32 = 3;
pub const BEAT_MISS: u32 = 4;
pub const BEAT_KILL: u32 = 5;
pub const BEAT_BURROW: u32 = 6;
pub const BEAT_SMOKE: u32 = 7;
pub const BEAT_RETREAT: u32 = 8;
pub const BEAT_OVERWATCH: u32 = 9;
pub const BEAT_OW_TRIGGER: u32 = 10;
pub const BEAT_HUNKER: u32 = 11;
pub const BEAT_GRENADE: u32 = 12;
pub const BEAT_MARK: u32 = 13;
pub const BEAT_SUPPRESS: u32 = 14;
pub const BEAT_REGEN: u32 = 15;

const STEP_MS_BROOD: u32 = 55;
const STEP_MS_EMPIRE: u32 = 90;
const TRACER_MS: u32 = 110;
const TRACER_SLOW_MS: u32 = 210;
const IMPACT_MS: u32 = 170;
const IMPACT_SLOW_MS: u32 = 250;
const KILL_MS: u32 = 240;
const BURROW_MS: u32 = 160;
const SMOKE_MS: u32 = 240;
const RETREAT_MS: u32 = 160;
const OVERWATCH_MS: u32 = 180;
const OW_TRIGGER_MS: u32 = 560;
const HUNKER_MS: u32 = 160;
const GRENADE_MS: u32 = 360;
const MARK_MS: u32 = 220;
const SUPPRESS_MS: u32 = 260;
const REGEN_MS: u32 = 240;
/// 빗나간 탄이 표적을 지나 더 날아가는 칸 수.
const OVERSHOOT: usize = 3;

const CELLS: usize = (W * H) as usize;
/// 문구 구역 구분자.
/// 0: 상황, 1: 장부 내역, 2: 장부 결과, 3: 병과 스킬명, 4: 분대원 목록,
/// 5: 후퇴 가능, 6: 월드 전투 헤더, 7: 합동 아군 AI 요약, 8: 경계 가능,
/// 9: 엄호 가능, 10: 사격 가능 적 목록, 11: 선택 분대원 요약,
/// 12: 전투 목표/매복 배너, 13: 전투 종료 브리핑 요약.
const SEP: &str = "\u{1f}";

#[derive(Clone, Copy)]
struct ViewUnit {
    pos: Pos,
    hp: i32,
    burrowed: bool,
    retreated: bool,
    overwatch: bool,
    hunkered: bool,
    marked: bool,
    suppressed: bool,
}

enum Fx {
    None,
    /// 날아가는 탄. `color`는 쏜 쪽 색.
    Tracer { from: Pos, to: Pos, cells: Vec<Pos>, color: u32 },
    /// 맞은 순간. 표적 칸이 번쩍인다.
    Hit { from: Pos, to: Pos, target: usize, dmg: i32, crit: bool, color: u32 },
    /// 빗나간 탄의 자국.
    Miss { from: Pos, to: Pos, cells: Vec<Pos>, target: usize, color: u32 },
    Death { pos: Pos, was_relay: bool },
    Smoke { center: Pos },
    Burrow { pos: Pos },
    Retreat { pos: Pos },
    OverwatchSet { pos: Pos, color: u32 },
    OverwatchTrigger { from: Pos, to: Pos, color: u32 },
    Hunker { pos: Pos, color: u32 },
    Grenade { from: Pos, to: Pos, destroyed: usize, hits: usize },
    Mark { from: Pos, to: Pos },
    Suppress { from: Pos, to: Pos },
    Regen { from: Pos, to: Pos, target: usize, amount: i32 },
}

struct State {
    game: Game,
    hover: Option<Pos>,
    frame: [u32; CELLS],
    /// 칸별 전술 메타데이터:
    /// bits 0..2: tile(0 floor, 1 low, 2 wall) | bit 2: seen | bit 3: smoke
    /// bit 4: reachable | bit 5: in_path | bit 6: retreat_edge | bit 7: memory_ghost
    /// bits 8..16: cover_mask N(8..10), E(10..12), S(12..14), W(14..16) (0 none, 1 low, 2 wall)
    /// bits 16..20: path_step (1..=15)
    /// bit 20: unit_marked | bit 21: unit_suppressed | bits 22..24: unit_rank (0..=3)
    b_meta: [u32; CELLS],
    /// 가시 생존 유닛 목록 (유닛당 2 word).
    b_units: Vec<u32>,
    /// 현재 프레임의 전술 오버레이/이펙트 [kind, a, b, c, d, e, f, g].
    b_fx: [u32; 8],
    /// 중계 신호 펄스: 0 없음, 1 제국 턴 중계 연결, 2 중계기 파괴 두절.
    relay_pulse: u32,
    relay_pulse_armed: bool,
    /// 경계 발동 직후 이어지는 슬로모 사격 여부.
    slowmo_shot: bool,
    text: String,
    /// 길게 누른 유닛의 정보.
    popup: String,
    view: Vec<ViewUnit>,
    /// 보여주는 중인 연막.
    view_smoke: Vec<bool>,
    queue: VecDeque<Event>,
    /// 맨 앞 사격 이벤트를 어디까지 보여줬는지.
    shot_stage: u8,
    fx: Fx,
    log_shown: usize,
    empire_phase: bool,
    allied_ai_phase: bool,
    /// 월드에서 진입한 전투의 제목/조건 태그.
    battle_header: String,
}

impl State {
    fn new(seed: u64) -> State {
        Self::from_game(Game::new(seed), String::new())
    }

    fn from_game(game: Game, battle_header: String) -> State {
        let mut s = State {
            game,
            hover: None,
            frame: [0; CELLS],
            b_meta: [0; CELLS],
            b_units: Vec::new(),
            b_fx: [0; 8],
            relay_pulse: 0,
            relay_pulse_armed: false,
            slowmo_shot: false,
            text: String::new(),
            popup: String::new(),
            view: Vec::new(),
            view_smoke: Vec::new(),
            queue: VecDeque::new(),
            shot_stage: 0,
            fx: Fx::None,
            log_shown: 0,
            empire_phase: false,
            allied_ai_phase: false,
            battle_header,
        };
        s.sync();
        s
    }

    fn playing(&self) -> bool {
        !self.queue.is_empty() || !matches!(self.fx, Fx::None)
    }

    /// 재생을 버리고 실제 상태로 맞춘다.
    fn sync(&mut self) {
        self.queue.clear();
        self.game.events.clear();
        self.shot_stage = 0;
        self.fx = Fx::None;
        self.relay_pulse = 0;
        self.relay_pulse_armed = false;
        self.slowmo_shot = false;
        self.empire_phase = false;
        self.allied_ai_phase = false;
        self.view = self
            .game
            .units
            .iter()
            .map(|u| ViewUnit {
                pos: u.pos,
                hp: u.hp,
                burrowed: u.burrowed,
                retreated: u.retreated,
                overwatch: u.overwatch,
                hunkered: u.hunkered,
                marked: u.marked,
                suppressed: u.suppressed,
            })
            .collect();
        self.view_smoke = self.game.smoke.iter().map(|&s| s > 0).collect();
        self.log_shown = self.game.log.len();
    }

    /// 코어가 방금 쌓은 이벤트를 재생 줄에 올린다.
    fn enqueue(&mut self, empire_phase: bool) {
        let events = std::mem::take(&mut self.game.events);
        if events.is_empty() && self.queue.is_empty() {
            self.sync();
            return;
        }
        self.queue.extend(events);
        self.empire_phase = empire_phase;
        if empire_phase {
            self.relay_pulse_armed = self
                .view
                .iter()
                .zip(&self.game.units)
                .any(|(v, u)| u.class == Class::Relay && v.hp > 0 && !v.retreated);
        }
    }

    /// 보여주는 중인 위치 기준으로 아군이 `p`를 보고 있는가.
    fn seen(&self, p: Pos) -> bool {
        self.view.iter().zip(&self.game.units).any(|(v, u)| {
            u.side == Side::Brood && v.hp > 0 && !v.retreated && dist(v.pos, p) <= SIGHT && self.game.los(v.pos, p)
        })
    }

    fn view_unit_at(&self, p: Pos) -> Option<usize> {
        self.view.iter().position(|v| v.hp > 0 && !v.retreated && v.pos == p)
    }

    /// 다음 박자를 화면에 반영한다. 돌려주는 값은 종류<<16 | 길이(ms). 끝났으면 0.
    fn advance(&mut self) -> u32 {
        loop {
            self.fx = Fx::None;
            self.relay_pulse = 0;
            let Some(event) = self.queue.front().cloned() else {
                self.sync();
                return 0;
            };
            match event {
                Event::Step { unit, from, to } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    let u = &self.game.units[unit];
                    let empire = u.side == Side::Empire;
                    self.allied_ai_phase = !empire && u.ai_controlled;
                    if empire && self.relay_pulse_armed {
                        self.relay_pulse_armed = false;
                        self.relay_pulse = 1;
                    }
                    let before = empire && self.seen(from);
                    self.view[unit].pos = to;
                    self.view[unit].burrowed = false;
                    self.view[unit].overwatch = false;
                    self.view[unit].hunkered = false;
                    // 시야 밖에서 시야 밖으로 가는 적은 보여주지 않는다.
                    if empire && !before && !self.seen(to) {
                        continue;
                    }
                    return BEAT_STEP << 16 | if empire { STEP_MS_EMPIRE } else { STEP_MS_BROOD };
                }
                Event::Shot { shooter, target, hit, crit, dmg, killed, log_lines } => {
                    let su = &self.game.units[shooter];
                    let empire = su.side == Side::Empire;
                    self.allied_ai_phase = !empire && su.ai_controlled;
                    if empire && self.relay_pulse_armed {
                        self.relay_pulse_armed = false;
                        self.relay_pulse = 1;
                    }
                    let (a, b) = (self.view[shooter].pos, self.view[target].pos);
                    let color = if su.side == Side::Brood {
                        if su.ai_controlled { BROOD_DIM } else { BROOD }
                    } else {
                        EMPIRE
                    };
                    match self.shot_stage {
                        0 => {
                            self.view[shooter].burrowed = false;
                            self.view[shooter].overwatch = false;
                            self.view[shooter].hunkered = false;
                            self.fx = Fx::Tracer { from: a, to: b, cells: Game::line(a, b), color };
                            self.shot_stage = 1;
                            let ms = if self.slowmo_shot { TRACER_SLOW_MS } else { TRACER_MS };
                            return BEAT_TRACER << 16 | ms;
                        }
                        1 => {
                            self.log_shown += log_lines;
                            self.shot_stage = 2;
                            let ms = if self.slowmo_shot { IMPACT_SLOW_MS } else { IMPACT_MS };
                            if hit {
                                self.fx = Fx::Hit { from: a, to: b, target, dmg, crit, color };
                                return BEAT_HIT << 16 | ms;
                            }
                            self.fx = Fx::Miss { from: a, to: b, cells: self.overshoot(a, b), target, color };
                            return BEAT_MISS << 16 | ms;
                        }
                        _ => {
                            self.queue.pop_front();
                            self.shot_stage = 0;
                            self.slowmo_shot = false;
                            self.view[target].hp -= dmg;
                            if killed {
                                let was_relay = self.game.units[target].class == Class::Relay;
                                if was_relay {
                                    self.relay_pulse = 2;
                                }
                                self.fx = Fx::Death { pos: b, was_relay };
                                return BEAT_KILL << 16 | KILL_MS;
                            }
                        }
                    }
                }
                Event::Burrow { unit } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    self.view[unit].burrowed = true;
                    self.view[unit].overwatch = false;
                    self.view[unit].hunkered = false;
                    self.fx = Fx::Burrow { pos: self.view[unit].pos };
                    return BEAT_BURROW << 16 | BURROW_MS;
                }
                Event::Smoke { center, .. } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    self.allied_ai_phase = false;
                    if self.relay_pulse_armed {
                        self.relay_pulse_armed = false;
                        self.relay_pulse = 1;
                    }
                    for y in center.1 - 1..=center.1 + 1 {
                        for x in center.0 - 1..=center.0 + 1 {
                            if in_frame((x, y)) && self.game.tile((x, y)) != Tile::Wall {
                                self.view_smoke[idx((x, y))] = true;
                            }
                        }
                    }
                    self.fx = Fx::Smoke { center };
                    return BEAT_SMOKE << 16 | SMOKE_MS;
                }
                Event::Retreat { unit } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    self.view[unit].retreated = true;
                    self.view[unit].overwatch = false;
                    self.view[unit].hunkered = false;
                    self.fx = Fx::Retreat { pos: self.view[unit].pos };
                    return BEAT_RETREAT << 16 | RETREAT_MS;
                }
                Event::Overwatch { unit } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    let u = &self.game.units[unit];
                    let empire = u.side == Side::Empire;
                    self.allied_ai_phase = !empire && u.ai_controlled;
                    self.view[unit].overwatch = true;
                    self.view[unit].hunkered = false;
                    let pos = self.view[unit].pos;
                    if empire && !self.seen(pos) {
                        continue;
                    }
                    let color = if empire {
                        EMPIRE
                    } else if u.ai_controlled {
                        BROOD_DIM
                    } else {
                        BROOD
                    };
                    self.fx = Fx::OverwatchSet { pos, color };
                    return BEAT_OVERWATCH << 16 | OVERWATCH_MS;
                }
                Event::OverwatchTrigger { shooter, target } => {
                    self.queue.pop_front();
                    let su = &self.game.units[shooter];
                    let empire = su.side == Side::Empire;
                    self.view[shooter].overwatch = false;
                    self.slowmo_shot = true;
                    let color = if empire {
                        EMPIRE
                    } else if su.ai_controlled {
                        BROOD_DIM
                    } else {
                        BROOD
                    };
                    self.fx = Fx::OverwatchTrigger {
                        from: self.view[shooter].pos,
                        to: self.view[target].pos,
                        color,
                    };
                    return BEAT_OW_TRIGGER << 16 | OW_TRIGGER_MS;
                }
                Event::Hunker { unit } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    let u = &self.game.units[unit];
                    let empire = u.side == Side::Empire;
                    self.allied_ai_phase = !empire && u.ai_controlled;
                    self.view[unit].hunkered = true;
                    self.view[unit].overwatch = false;
                    let pos = self.view[unit].pos;
                    if empire && !self.seen(pos) {
                        continue;
                    }
                    let color = if empire {
                        EMPIRE
                    } else if u.ai_controlled {
                        BROOD_DIM
                    } else {
                        BROOD
                    };
                    self.fx = Fx::Hunker { pos, color };
                    return BEAT_HUNKER << 16 | HUNKER_MS;
                }
                Event::Grenade { unit, to, destroyed, hits } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    let from = self.view[unit].pos;
                    self.view[unit].burrowed = false;
                    self.view[unit].overwatch = false;
                    self.view[unit].hunkered = false;
                    let hit_count = hits.len();
                    for (t, dmg, killed) in hits {
                        self.view[t].hp -= dmg;
                        self.view[t].hunkered = false;
                        if killed && self.game.units[t].class == Class::Relay {
                            self.relay_pulse = 2;
                        }
                    }
                    self.fx = Fx::Grenade { from, to, destroyed: destroyed.len(), hits: hit_count };
                    return BEAT_GRENADE << 16 | GRENADE_MS;
                }
                Event::Mark { unit, target } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    self.view[target].marked = true;
                    self.fx = Fx::Mark { from: self.view[unit].pos, to: self.view[target].pos };
                    return BEAT_MARK << 16 | MARK_MS;
                }
                Event::Suppress { unit, target } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    self.view[unit].burrowed = false;
                    self.view[unit].overwatch = false;
                    self.view[unit].hunkered = false;
                    self.view[target].suppressed = true;
                    self.view[target].overwatch = false;
                    self.fx = Fx::Suppress { from: self.view[unit].pos, to: self.view[target].pos };
                    return BEAT_SUPPRESS << 16 | SUPPRESS_MS;
                }
                Event::Regen { unit, target, amount } => {
                    self.queue.pop_front();
                    self.slowmo_shot = false;
                    self.view[target].hp = (self.view[target].hp + amount).min(self.game.units[target].max_hp);
                    self.fx = Fx::Regen {
                        from: self.view[unit].pos,
                        to: self.view[target].pos,
                        target,
                        amount,
                    };
                    return BEAT_REGEN << 16 | REGEN_MS;
                }
            }
        }
    }

    /// 표적을 지나친 탄이 더 날아간 칸들. 벽이나 유닛에서 멈춘다.
    fn overshoot(&self, a: Pos, b: Pos) -> Vec<Pos> {
        let far = (b.0 + (b.0 - a.0) * 2, b.1 + (b.1 - a.1) * 2);
        let mut out = Vec::new();
        for p in Game::line(b, far).into_iter().take(OVERSHOOT) {
            if !in_frame(p) || self.game.tile(p) == Tile::Wall || self.view_unit_at(p).is_some() {
                break;
            }
            out.push(p);
        }
        out
    }
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    // wasm은 단일 스레드고, 모든 export는 JS에서 순서대로 호출된다.
    unsafe {
        let slot = &mut *core::ptr::addr_of_mut!(STATE);
        slot.get_or_insert_with(|| State::new(0))
    }
}

pub(crate) fn cell(glyph: char, fg: u32, bg: u32) -> u32 {
    glyph as u32 | fg << 24 | bg << 28
}

fn idx(p: Pos) -> usize {
    (p.1 * W + p.0) as usize
}

fn in_frame(p: Pos) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < W && p.1 < H
}

fn quantize_dir12(dx: i32, dy: i32) -> u32 {
    if dx == 0 && dy == 0 {
        return 0;
    }
    let ang = (dy as f64).atan2(dx as f64);
    let norm = if ang < 0.0 { ang + std::f64::consts::TAU } else { ang };
    let step = ((norm / std::f64::consts::TAU) * 12.0).round() as u32 % 12;
    step + 1
}

fn cover_bits(g: &Game, p: Pos) -> u32 {
    if g.tile(p) != Tile::Floor {
        return 0;
    }
    let dirs = [(0, -1), (1, 0), (0, 1), (-1, 0)]; // N, E, S, W
    let mut mask = 0u32;
    for (k, d) in dirs.iter().enumerate() {
        let n = (p.0 + d.0, p.1 + d.1);
        if !in_frame(n) {
            continue;
        }
        let code = match g.tile(n) {
            Tile::Low => 1u32,
            Tile::Wall => 2u32,
            Tile::Floor => 0u32,
        };
        mask |= code << (k * 2);
    }
    mask
}

fn render(s: &mut State) {
    let playing = s.playing();
    let g = &s.game;
    for y in 0..H {
        for x in 0..W {
            let p = (x, y);
            let i = idx(p);
            let tile = g.tile(p);
            let smoke = s.view_smoke[i];
            let seen = s.seen(p);
            s.frame[i] = match tile {
                Tile::Floor if smoke => cell('≈', DIM, BG),
                Tile::Floor if x == 0 && y % 2 == 1 => cell('◁', DIM, BG),
                Tile::Floor => cell('·', DIM, BG),
                Tile::Low => cell('▄', DIM, BG),
                Tile::Wall => cell('█', DIM, BG),
            };
            let tcode = match tile {
                Tile::Floor => 0u32,
                Tile::Low => 1u32,
                Tile::Wall => 2u32,
            };
            let mut meta = tcode;
            if seen {
                meta |= 1 << 2;
            }
            if smoke {
                meta |= 1 << 3;
            }
            if tile == Tile::Floor && x == 0 {
                meta |= 1 << 6;
            }
            meta |= cover_bits(g, p) << 8;
            s.b_meta[i] = meta;
        }
    }

    // 마지막 목격 잔상 (?): 현재 시야 밖이지만 아군이 기억하고 있는 생존 제국 유닛의 마지막 위치.
    for (i, u) in g.units.iter().enumerate() {
        if u.side != Side::Empire || s.view[i].hp <= 0 || s.view[i].retreated {
            continue;
        }
        if let Some(m) = g.memory[i] {
            if in_frame(m) && !s.seen(m) {
                s.b_meta[idx(m)] |= 1 << 7;
            }
        }
    }

    let can_act = !playing && g.outcome.is_none();
    if let (Some(sel), true) = (g.selected, can_act) {
        if g.units[sel].ap > 0 {
            for p in g.reachable(sel) {
                let ch = if p.0 == 0 && p.1 % 2 == 1 { '◁' } else { '·' };
                s.frame[idx(p)] = cell(ch, BROOD, BG);
                s.b_meta[idx(p)] |= 1 << 4;
            }
            // 가리킨 칸까지 실제로 걸어갈 길.
            if let Some(path) = s.hover.and_then(|h| g.path_to(sel, h)) {
                for (step, p) in path.into_iter().enumerate() {
                    s.frame[idx(p)] = cell('•', BROOD, BG);
                    let ord = ((step + 1).min(15) as u32) << 16;
                    s.b_meta[idx(p)] |= (1 << 5) | ord;
                }
            }
        }
    }

    let lanes = fire_lanes(s, can_act);

    s.b_fx = [0; 8];
    let slowmo = s.slowmo_shot as u32;
    match &s.fx {
        Fx::Tracer { from, to, cells, color } => {
            for &p in cells {
                // 엄폐물은 가리지 않는다. 탄은 바닥 칸에만 그린다.
                if g.tile(p) == Tile::Floor {
                    s.frame[idx(p)] = cell('•', *color, BG);
                }
            }
            s.b_fx = [2, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, *color, slowmo, 0];
        }
        Fx::Hit { from, to, dmg, crit, color, .. } => {
            s.b_fx = [
                3,
                from.0 as u32,
                from.1 as u32,
                to.0 as u32,
                to.1 as u32,
                *dmg as u32,
                *color,
                slowmo | ((*crit as u32) << 1),
            ];
        }
        Fx::Miss { from, to, cells, color, .. } => {
            for &p in cells.iter().filter(|p| g.tile(**p) == Tile::Floor) {
                s.frame[idx(p)] = cell('•', DIM, BG);
            }
            let end = cells.last().copied().unwrap_or(*to);
            s.b_fx = [
                4,
                from.0 as u32,
                from.1 as u32,
                to.0 as u32,
                to.1 as u32,
                end.0 as u32,
                end.1 as u32,
                *color | (slowmo << 8),
            ];
        }
        Fx::Death { pos, was_relay } => {
            s.frame[idx(*pos)] = cell('×', FG, BG);
            s.b_fx = [5, pos.0 as u32, pos.1 as u32, *was_relay as u32, 0, 0, 0, 0];
        }
        Fx::Smoke { center } => {
            s.b_fx = [6, center.0 as u32, center.1 as u32, 0, 0, 0, 0, 0];
        }
        Fx::Burrow { pos } => {
            s.b_fx = [7, pos.0 as u32, pos.1 as u32, 0, 0, 0, 0, 0];
        }
        Fx::Retreat { pos } => {
            s.b_fx = [8, pos.0 as u32, pos.1 as u32, 0, 0, 0, 0, 0];
        }
        Fx::OverwatchSet { pos, color } => {
            s.b_fx = [9, pos.0 as u32, pos.1 as u32, *color, 0, 0, 0, 0];
        }
        Fx::OverwatchTrigger { from, to, color } => {
            s.b_fx = [10, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, *color, 0, 0];
        }
        Fx::Hunker { pos, color } => {
            s.b_fx = [11, pos.0 as u32, pos.1 as u32, *color, 0, 0, 0, 0];
        }
        Fx::Grenade { from, to, destroyed, hits } => {
            s.b_fx = [12, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, *destroyed as u32, *hits as u32, 0];
        }
        Fx::Mark { from, to } => {
            s.b_fx = [13, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, 0, 0, 0];
        }
        Fx::Suppress { from, to } => {
            s.b_fx = [14, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, 0, 0, 0];
        }
        Fx::Regen { from, to, amount, .. } => {
            s.b_fx = [15, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, *amount as u32, 0, 0];
        }
        Fx::None => {
            // 조준 미리보기 (선택한 아군이 보이는 적을 가리킬 때)
            if let (true, Some(sel), Some(hp)) = (can_act, g.selected, s.hover) {
                if g.units[sel].ap > 0 {
                    if let Some(t) = g.unit_at(hp) {
                        if g.units[t].side == Side::Empire && g.visible_to(Side::Brood, t) {
                            let from = g.units[sel].pos;
                            let to = g.units[t].pos;
                            match g.shot(sel, t) {
                                Some(shot) => {
                                    s.b_fx = [
                                        1,
                                        from.0 as u32,
                                        from.1 as u32,
                                        to.0 as u32,
                                        to.1 as u32,
                                        shot.chance.max(0) as u32,
                                        shot.cover.max(0) as u32,
                                        1,
                                    ];
                                }
                                None => {
                                    s.b_fx = [1, from.0 as u32, from.1 as u32, to.0 as u32, to.1 as u32, 0, 0, 0];
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    s.b_units.clear();
    for (i, u) in g.units.iter().enumerate() {
        let v = s.view[i];
        if v.hp <= 0 || v.retreated {
            continue;
        }
        // 땅에 숨은 아군은 흙더미로 보인다.
        let glyph = if v.burrowed { '∩' } else { u.glyph() };
        let struck = matches!(s.fx, Fx::Hit { target, .. } if target == i);
        let lane_info = lanes.shots.iter().find(|&&(t, _, _)| t == i).copied();
        let in_lane = lane_info.is_some();
        let flanked = lane_info.is_some_and(|(_, _, cov)| cov == 0);
        let shown = match u.side {
            Side::Brood if u.ai_controlled => Some(if struck {
                cell(glyph, BG, FG)
            } else {
                cell(glyph, BROOD_DIM, BG)
            }),
            Side::Brood => Some(if struck {
                cell(glyph, BG, FG)
            } else if g.selected == Some(i) && can_act {
                cell(glyph, BG, BROOD)
            } else {
                cell(glyph, if u.ap == 0 && !playing { DIM } else { BROOD }, BG)
            }),
            Side::Empire if s.seen(v.pos) => Some(if struck {
                cell(glyph, BG, FG)
            } else if s.hover == Some(v.pos) && can_act {
                cell(glyph, BG, EMPIRE)
            } else if in_lane {
                // 사선에 들어온 적은 바탕이 밝다.
                cell(glyph, EMPIRE, DIM)
            } else {
                cell(glyph, EMPIRE, BG)
            }),
            Side::Empire => None,
        };
        if let Some(c) = shown {
            s.frame[idx(v.pos)] = c;
            let hp = (v.hp.clamp(0, 15)) as u32;
            let max_hp = (u.max_hp.clamp(1, 15)) as u32;
            let ap = if playing { 0 } else { (u.ap.min(3)) as u32 };
            let mut w0 = (v.pos.0 as u32)
                | ((v.pos.1 as u32) << 8)
                | (hp << 16)
                | (max_hp << 20)
                | (ap << 24);
            if u.side == Side::Empire { w0 |= 1 << 26; }
            if u.ai_controlled { w0 |= 1 << 27; }
            if g.selected == Some(i) && can_act { w0 |= 1 << 28; }
            if v.burrowed { w0 |= 1 << 29; }
            if in_lane { w0 |= 1 << 30; }
            if struck { w0 |= 1 << 31; }

            let shield_dir = if u.class == Class::Shield {
                g.shield_facing(i).map_or(0, |(dx, dy)| quantize_dir12(dx, dy))
            } else {
                0
            };
            let mut w1 = (glyph as u32) | (shield_dir << 21);
            if u.class == Class::Sensor { w1 |= 1 << 25; }
            if u.class == Class::Relay { w1 |= 1 << 26; }
            if s.hover == Some(v.pos) && can_act { w1 |= 1 << 27; }
            if flanked { w1 |= 1 << 28; }
            if u.side == Side::Brood && !u.ai_controlled && v.pos.0 == 0 && u.ap > 0 && can_act {
                w1 |= 1 << 29;
            }
            if v.overwatch { w1 |= 1 << 30; }
            if v.hunkered { w1 |= 1 << 31; }
            s.b_units.push(w0);
            s.b_units.push(w1);

            // 표식/제압/계급 상태는 b_meta 상위 비트(20..24)에 패킹한다.
            let mi = idx(v.pos);
            if v.marked { s.b_meta[mi] |= 1 << 20; }
            if v.suppressed { s.b_meta[mi] |= 1 << 21; }
            s.b_meta[mi] |= ((u.rank.min(3) as u32) & 0x3) << 22;
        }
    }

    let (ledger, result) = if can_act { ledger(s, &lanes) } else { ("—".to_string(), String::new()) };
    let retreated_any = g.units.iter().any(|u| u.side == Side::Brood && !u.ai_controlled && u.retreated);
    let ai_alive = g
        .units
        .iter()
        .enumerate()
        .filter(|(i, u)| u.side == Side::Brood && u.ai_controlled && s.view[*i].hp > 0)
        .count();
    let skill_name = if can_act {
        g.class_skill_info().map_or_else(String::new, |(_, name, _)| name.to_string())
    } else {
        String::new()
    };
    let sections = [
        match (playing, g.outcome) {
            (true, _) if matches!(s.fx, Fx::OverwatchTrigger { .. }) => "경계 발동!".to_string(),
            (true, _) if s.allied_ai_phase => "아군 일반군 행동".to_string(),
            (true, _) if s.empire_phase => "제국 행동".to_string(),
            (false, Some(Side::Brood)) if g.objective == BattleObjective::DestroyRelay => "중계기 파괴 완료".to_string(),
            (false, Some(Side::Brood)) => "제국 분대 전멸".to_string(),
            (false, Some(Side::Empire)) if retreated_any => "특수부대 후퇴 생환".to_string(),
            (false, Some(Side::Empire)) => "전원 사망".to_string(),
            _ => format!("라운드 {}", g.round),
        },
        ledger,
        result,
        skill_name,
        roster_text(s),
        if can_act && g.can_retreat() { "후퇴".to_string() } else { String::new() },
        s.battle_header.clone(),
        if ai_alive > 0 { format!("AI 아군 {ai_alive}명") } else { String::new() },
        if can_act && g.can_overwatch() { "경계".to_string() } else { String::new() },
        if can_act && g.can_hunker() { "엄호".to_string() } else { String::new() },
        if can_act { targets_text(s) } else { String::new() },
        selected_text(s, can_act),
        objective_text(s),
        if !playing && g.outcome.is_some() { battle_summary_text(s) } else { String::new() },
    ];
    s.text = sections.join(SEP);
}

fn objective_text(s: &State) -> String {
    let g = &s.game;
    let mut parts = Vec::new();
    match g.objective {
        BattleObjective::DestroyRelay => {
            let left = g
                .units
                .iter()
                .enumerate()
                .filter(|(i, u)| u.side == Side::Empire && u.class == Class::Relay && s.view[*i].hp > 0)
                .count();
            parts.push(format!("목표: 중계기 파괴 (남은 {left})"));
        }
        BattleObjective::AmbushConvoy => {
            parts.push("목표: 보급대 차단 (+보너스 생체질)".to_string());
        }
        BattleObjective::Eliminate => {}
    }
    if g.ambush_turn && g.outcome.is_none() {
        parts.push("매복 기습 1턴! 조준+15 · 엄폐 무시".to_string());
    }
    parts.join(" · ")
}

fn battle_summary_text(s: &State) -> String {
    let g = &s.game;
    let won = if g.outcome == Some(Side::Brood) { 1 } else { 0 };
    let player_units: Vec<&sim::Unit> = g
        .units
        .iter()
        .filter(|u| u.side == Side::Brood && !u.ai_controlled)
        .collect();
    let survivors = player_units.iter().filter(|u| u.hp > 0).count();
    let kia = player_units.len().saturating_sub(survivors);
    let empire_kills = g.units.iter().filter(|u| u.side == Side::Empire && u.hp <= 0).count();
    let mut out = format!(
        "{won}|{}|{survivors}|{kia}|{empire_kills}|{}",
        g.round,
        g.objective.label()
    );
    for u in player_units {
        let state_str = if u.hp <= 0 {
            "전사"
        } else if u.retreated {
            "생환"
        } else {
            "생존"
        };
        out.push_str(&format!(
            "\n{}\t{}\t{}\t{}\t{}\t{}\t{}\t{state_str}",
            u.callsign(),
            rank_label(u.rank),
            u.glyph(),
            u.name(),
            u.hp.max(0),
            u.max_hp,
            u.kills
        ));
    }
    out
}

/// 현재 선택 분대원이 제자리에서 쏠 수 있는 적 표적 목록 (XCOM 조준/하단 표적 칩용).
/// 줄마다 x\ty\t글리프\t이름\t체력\t최대체력\t명중률\t조준\t엄폐\t거리감점\t치명타\t표식\t제압.
fn targets_text(s: &State) -> String {
    let g = &s.game;
    let Some(sel) = g.selected.filter(|&i| g.units[i].alive() && g.units[i].ap > 0) else {
        return String::new();
    };
    let mut list = Vec::new();
    for (t, u) in g.units.iter().enumerate() {
        if u.side == Side::Empire && g.visible_to(Side::Brood, t) {
            if let Some(shot) = g.shot(sel, t) {
                list.push((shot.chance, t, shot));
            }
        }
    }
    list.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    list.into_iter()
        .map(|(_, t, shot)| {
            let u = &g.units[t];
            format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                u.pos.0,
                u.pos.1,
                u.glyph(),
                u.name(),
                u.hp.max(0),
                u.max_hp,
                shot.chance,
                shot.aim,
                shot.cover,
                shot.falloff,
                shot.crit,
                u.marked as u8,
                u.suppressed as u8
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 현재 선택 분대원 요약 (하단 XCOM HUD 좌측 슬롯용).
/// 형식: 글리프\t이름\t체력\t최대체력\t행동\t상태태그\tx\ty\t남은행동유닛수\t파열탄수\t스킬코드\t스킬명\t호출부호\t계급.
fn selected_text(s: &State, can_act: bool) -> String {
    let g = &s.game;
    let ready_count = g
        .units
        .iter()
        .filter(|u| u.side == Side::Brood && !u.ai_controlled && u.alive() && u.ap > 0)
        .count();
    let Some(i) = g.selected else {
        return format!("\t\t0\t0\t0\t\t-1\t-1\t{ready_count}\t0\t0\t\t\t");
    };
    let u = &g.units[i];
    let v = s.view[i];
    let ap = if can_act { u.ap } else { 0 };
    let tag = if v.overwatch {
        "경계"
    } else if v.hunkered {
        "엄호"
    } else if v.burrowed {
        "잠복"
    } else if v.pos.0 == 0 && ap > 0 {
        "후퇴가능"
    } else if ap == 0 {
        "완료"
    } else {
        ""
    };
    let (sk_code, sk_name) = if can_act {
        g.class_skill_info().map_or((0, ""), |(c, n, _)| (c, n))
    } else {
        (0, "")
    };
    format!(
        "{}\t{}\t{}\t{}\t{ap}\t{tag}\t{}\t{}\t{ready_count}\t{}\t{sk_code}\t{sk_name}\t{}\t{}",
        u.glyph(),
        u.name(),
        v.hp.max(0),
        u.max_hp,
        v.pos.0,
        v.pos.1,
        u.grenades,
        u.callsign(),
        rank_label(u.rank)
    )
}

/// 분대원 목록(토글 창용). 줄마다 x\ty\t선택\t글리프\t이름\t체력핍\t행동\t상태\t호출부호\t계급.
fn roster_text(s: &State) -> String {
    let g = &s.game;
    let playing = s.playing();
    g.units
        .iter()
        .enumerate()
        .filter(|(i, u)| u.side == Side::Brood && !u.ai_controlled && s.view[*i].hp > 0 && !s.view[*i].retreated)
        .map(|(i, u)| {
            let v = s.view[i];
            let max = u.max_hp;
            let hp = v.hp.max(0);
            let pips: String = (0..max).map(|k| if k < hp { '●' } else { '○' }).collect();
            let sel = if g.selected == Some(i) && !playing { 1 } else { 0 };
            let ap = if playing { 0 } else { u.ap };
            let tag = if v.overwatch {
                "경계"
            } else if v.hunkered {
                "엄호"
            } else if v.burrowed {
                "숨음"
            } else if v.pos.0 == 0 && ap > 0 {
                "후퇴가능"
            } else if ap == 0 {
                "완료"
            } else {
                ""
            };
            format!(
                "{}\t{}\t{sel}\t{}\t{}\t{pips}\t행동 {ap}\t{tag}\t{}\t{}",
                v.pos.0,
                v.pos.1,
                u.glyph(),
                u.name(),
                u.callsign(),
                rank_label(u.rank)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 길게 눌렀을 때 뜨는 창의 내용. 보이는 유닛이 없는 칸이면 빈 문자열.
fn inspect_text(s: &State, p: Pos) -> String {
    let Some(i) = s.view_unit_at(p) else { return String::new() };
    let u = &s.game.units[i];
    if u.side == Side::Empire && !s.seen(p) {
        return String::new();
    }
    let (hp, max) = (s.view[i].hp.max(0), u.max_hp);
    let pips: String = (0..max).map(|k| if k < hp { '●' } else { '○' }).collect();
    let cs = u.callsign();
    let head = if cs.is_empty() {
        format!("{} {}", u.glyph(), u.name())
    } else if u.rank > 0 {
        format!("{} {} [{cs} · {}]", u.glyph(), u.name(), rank_label(u.rank))
    } else {
        format!("{} {} [{cs}]", u.glyph(), u.name())
    };
    let mut out = format!("{head}\n체력 {pips} {hp}/{max}");
    if u.side == Side::Brood {
        out.push_str(&format!("\n행동 {}", if s.playing() { 0 } else { u.ap }));
    }
    if s.view[i].burrowed {
        out.push_str("\n숨음");
    }
    if s.view[i].overwatch {
        out.push_str("\n경계 태세");
    }
    if s.view[i].hunkered {
        out.push_str("\n엄호 중 (+30 방어 · 치명 면역)");
    }
    if s.view[i].marked {
        out.push_str("\n표식됨 (피격 조준+20 · 치명+15%)");
    }
    if s.view[i].suppressed {
        out.push_str("\n제압됨 (조준 −30 · 이동 저하)");
    }
    out
}

fn minus(v: i32) -> String {
    if v > 0 {
        format!("−{v}")
    } else {
        "0".to_string()
    }
}

/// 선택한 유닛이 어디서 쏜다고 칠 때 누구를 쏠 수 있는가.
struct Lanes {
    /// 이동할 칸을 가리키는 중이면 true. 그때는 그 칸에서 본 사선이다.
    after_move: bool,
    /// 이동에 마지막 행동을 쓴다. 사선은 다음 턴에 쏠 수 있는 것이다.
    next_turn: bool,
    /// (적, 명중률, 엄폐). 명중률 높은 순.
    shots: Vec<(usize, i32, i32)>,
}

/// 지금 보이는 적만 따진다. 옮겨 가서 새로 보일 적은 미리 알려주지 않는다.
fn fire_lanes(s: &State, can_act: bool) -> Lanes {
    let g = &s.game;
    let mut lanes = Lanes { after_move: false, next_turn: false, shots: Vec::new() };
    let Some(sel) = g.selected.filter(|&i| can_act && g.units[i].ap > 0) else { return lanes };
    let mut from = g.units[sel].pos;
    if let Some(h) = s.hover.filter(|&h| g.path_to(sel, h).is_some()) {
        lanes.after_move = true;
        lanes.next_turn = g.units[sel].ap < 2;
        from = h;
    }
    // 제자리면 지금 상태 그대로, 옮겨 가면 움직인 것으로 친다. 다음 턴 것이면 그 자리에서 안 움직이고 쏘는 것이다.
    let me = &g.units[sel];
    let settled = if lanes.after_move { lanes.next_turn } else { !me.moved };
    let ambush = !lanes.after_move && me.burrowed;
    for (t, u) in g.units.iter().enumerate() {
        if u.side == Side::Empire && g.visible_to(Side::Brood, t) {
            if let Some(shot) = g.shot_calc(sel, from, u.pos, Some(t), settled, ambush) {
                lanes.shots.push((t, shot.chance, shot.cover));
            }
        }
    }
    lanes.shots.sort_by(|a, b| b.1.cmp(&a.1));
    lanes
}

fn lanes_text(s: &State, lanes: &Lanes) -> String {
    let head = match (lanes.after_move, lanes.next_turn) {
        (true, true) => "이동 후, 다음 턴",
        (true, false) => "이동 후",
        _ => "여기서",
    };
    if lanes.shots.is_empty() {
        return format!("{head}\n사선 없음");
    }
    let mut out = head.to_string();
    for &(t, chance, _) in &lanes.shots {
        let u = &s.game.units[t];
        out.push_str(&format!("\n{chance:>3}%  {} {}", u.glyph(), u.name()));
    }
    out
}

/// 장부. (내역, 결과) 두 조각으로 나눠서 결과만 따로 칠할 수 있게 한다.
/// 적을 가리키면 그 사격의 명중률 내역, 아니면 선택한 유닛의 사선 목록.
/// 재생 중이 아닐 때만 부르므로 `view`와 코어 상태가 같다.
fn ledger(s: &State, lanes: &Lanes) -> (String, String) {
    let g = &s.game;
    let has_lanes = g.selected.is_some_and(|i| g.units[i].ap > 0);
    let none = || (if has_lanes { lanes_text(s, lanes) } else { "—".to_string() }, String::new());
    let Some(p) = s.hover else { return none() };
    let Some(t) = g.unit_at(p) else { return none() };
    if g.units[t].side == Side::Brood || !g.seen_by(Side::Brood, p) {
        return none();
    }
    let head = format!("{} {}", g.units[t].glyph(), g.units[t].name());
    let Some(sel) = g.selected else { return (head, String::new()) };
    match g.shot(sel, t) {
        Some(shot) => (
            format!("{head}\n조준 {:>5}\n엄폐 {:>5}\n거리 {:>5}", shot.aim, minus(shot.cover), minus(shot.falloff)),
            format!("명중 {:>5}%", shot.chance),
        ),
        None => (head, "사선 없음".to_string()),
    }
}

#[no_mangle]
pub extern "C" fn init(seed: u32) {
    let s = state();
    *s = State::new(seed as u64);
    render(s);
}

#[no_mangle]
pub extern "C" fn click(x: i32, y: i32) -> u32 {
    let s = state();
    let changed = s.game.click((x, y));
    s.enqueue(false);
    render(s);
    changed as u32
}

#[no_mangle]
pub extern "C" fn end_turn() {
    let s = state();
    s.game.end_turn();
    s.enqueue(true);
    render(s);
}

/// 선택한 유닛의 능력을 쓴다. 지금은 잠복 하나다.
#[no_mangle]
pub extern "C" fn ability() -> u32 {
    let s = state();
    let changed = s.game.burrow();
    s.enqueue(false);
    render(s);
    changed as u32
}

/// 선택한 유닛을 경계 태세로 전환한다.
#[no_mangle]
pub extern "C" fn overwatch() -> u32 {
    let s = state();
    let changed = s.game.overwatch();
    s.enqueue(false);
    render(s);
    changed as u32
}

/// 선택한 유닛을 엄호(Hunker Down) 태세로 전환한다.
#[no_mangle]
pub extern "C" fn hunker() -> u32 {
    let s = state();
    let changed = s.game.hunker();
    s.enqueue(false);
    render(s);
    changed as u32
}

/// 선택한 플레이어 유닛을 좌측 가장자리에서 후퇴시킨다.
#[no_mangle]
pub extern "C" fn retreat() -> u32 {
    let s = state();
    let changed = s.game.retreat();
    s.enqueue(false);
    render(s);
    changed as u32
}

/// 선택한 플레이어 유닛이 `(x, y)`에 파열탄(엄폐 파괴 수류탄)을 투척한다.
#[no_mangle]
pub extern "C" fn grenade(x: i32, y: i32) -> u32 {
    let s = state();
    let changed = s.game.grenade((x, y));
    s.enqueue(false);
    render(s);
    changed as u32
}

/// 선택한 플레이어 유닛의 병과 고유 스킬을 실행한다 (`x < 0`이면 대상 없음/자기 자신).
#[no_mangle]
pub extern "C" fn class_skill(x: i32, y: i32) -> u32 {
    let s = state();
    let target = if x < 0 { None } else { Some((x, y)) };
    let changed = s.game.class_skill(target);
    s.enqueue(false);
    render(s);
    changed as u32
}

fn pack_selected(pos: Pos) -> u32 {
    (1 << 16) | (pos.0 as u32) | ((pos.1 as u32) << 8)
}

/// 항상 분대원 1명이 선택돼 있도록 보장한다.
/// 현재 선택 유닛이 없거나 행동이 끝났다면 남은 AP가 있는 첫 분대원을, 모두가 0 AP면 첫 생존 분대원을 고른다.
/// 선택이 바뀌면 `(1 << 16) | x | (y << 8)`, 그대로면 0을 돌려준다.
#[no_mangle]
pub extern "C" fn ensure_selected() -> u32 {
    let s = state();
    if s.playing() || s.game.outcome.is_some() {
        return 0;
    }
    let g = &mut s.game;
    let player_units: Vec<usize> = g
        .units
        .iter()
        .enumerate()
        .filter(|(_, u)| u.side == Side::Brood && !u.ai_controlled && u.alive())
        .map(|(i, _)| i)
        .collect();
    if player_units.is_empty() {
        return 0;
    }
    let cur_ok = g
        .selected
        .is_some_and(|i| player_units.contains(&i) && (g.units[i].ap > 0 || player_units.iter().all(|&j| g.units[j].ap == 0)));
    if cur_ok {
        return 0;
    }
    let pick = player_units
        .iter()
        .copied()
        .find(|&i| g.units[i].ap > 0)
        .unwrap_or(player_units[0]);
    if g.selected == Some(pick) {
        return 0;
    }
    g.selected = Some(pick);
    let pos = g.units[pick].pos;
    render(s);
    pack_selected(pos)
}

/// 다음(dir >= 0) 또는 이전(dir < 0) 분대원으로 전환한다 (행동 가능한 분대원 우선 순환).
/// 선택이 바뀌면 `(1 << 16) | x | (y << 8)`, 그대로면 0.
#[no_mangle]
pub extern "C" fn select_next(dir: i32) -> u32 {
    let s = state();
    if s.playing() || s.game.outcome.is_some() {
        return 0;
    }
    let g = &mut s.game;
    let all: Vec<usize> = g
        .units
        .iter()
        .enumerate()
        .filter(|(_, u)| u.side == Side::Brood && !u.ai_controlled && u.alive())
        .map(|(i, _)| i)
        .collect();
    if all.is_empty() {
        return 0;
    }
    let ready: Vec<usize> = all.iter().copied().filter(|&i| g.units[i].ap > 0).collect();
    let pool = if ready.is_empty() { &all } else { &ready };
    let next = match g.selected.and_then(|cur| pool.iter().position(|&i| i == cur)) {
        Some(idx) => {
            if dir >= 0 {
                pool[(idx + 1) % pool.len()]
            } else {
                pool[(idx + pool.len() - 1) % pool.len()]
            }
        }
        None => {
            if dir >= 0 {
                pool[0]
            } else {
                pool[pool.len() - 1]
            }
        }
    };
    if g.selected == Some(next) {
        return 0;
    }
    g.selected = Some(next);
    let pos = g.units[next].pos;
    render(s);
    pack_selected(pos)
}

/// 전투가 끝났는가. 0: 진행 중, 1: 아군 승리, 2: 패배/후퇴.
#[no_mangle]
pub extern "C" fn battle_done() -> u32 {
    let s = state();
    if s.playing() {
        return 0;
    }
    match s.game.outcome {
        None => 0,
        Some(Side::Brood) => 1,
        Some(Side::Empire) => 2,
    }
}

pub(crate) fn start_world_battle(cfg: &BattleConfig) {
    let header = if cfg.tags.is_empty() {
        cfg.title.clone()
    } else {
        format!("{} · {}", cfg.title, cfg.tags.join(" · "))
    };
    let s = state();
    *s = State::from_game(Game::from_battle(cfg), header);
    render(s);
}

/// 끝난 월드 전투에서 `(won, allied_losses, empire_losses, packed_hp, packed_kills)`를 추출한다.
pub(crate) fn extract_world_battle_result() -> Option<(bool, u32, u32, u32, u32)> {
    let s = state();
    let outcome = s.game.outcome?;
    let won = outcome == Side::Brood;
    let mut packed_hp = 0u32;
    let mut packed_kills = 0u32;
    let mut allied_losses = 0u32;
    let mut empire_losses = 0u32;
    for u in &s.game.units {
        if let Some(slot) = u.squad_slot {
            if slot < 8 && u.hp > 0 {
                // 생존(전장 생존 또는 후퇴 생환)
                let hp = (u.hp as u32).min(15);
                let kills = (u.kills as u32).min(15);
                packed_hp |= hp << (slot * 4);
                packed_kills |= kills << (slot * 4);
            }
        } else if u.side == Side::Brood && u.ai_controlled && u.hp <= 0 {
            allied_losses += 1;
        } else if u.side == Side::Empire && u.hp <= 0 {
            empire_losses += 1;
        }
    }
    Some((won, allied_losses, empire_losses, packed_hp, packed_kills))
}

/// 다음 박자로 넘긴다. 종류<<16 | 길이(ms)를 돌려주고, 보여줄 게 없으면 0.
#[no_mangle]
pub extern "C" fn advance() -> u32 {
    let s = state();
    let beat = s.advance();
    render(s);
    beat
}

/// 남은 재생을 건너뛰고 실제 상태를 바로 보여준다.
#[no_mangle]
pub extern "C" fn skip() {
    let s = state();
    s.sync();
    render(s);
}

/// 화면 표시용. 게임 상태는 건드리지 않는다.
#[no_mangle]
pub extern "C" fn hover(x: i32, y: i32) {
    let s = state();
    s.hover = if x < 0 { None } else { Some((x, y)) };
    render(s);
}

#[no_mangle]
pub extern "C" fn cols() -> i32 {
    W
}

#[no_mangle]
pub extern "C" fn rows() -> i32 {
    H
}

#[no_mangle]
pub extern "C" fn frame_ptr() -> *const u32 {
    state().frame.as_ptr()
}

#[no_mangle]
pub extern "C" fn text_ptr() -> *const u8 {
    state().text.as_ptr()
}

/// 칸 하나를 들여다본다. 보이는 유닛이 있으면 `popup_ptr`에 내용을 쓰고 길이를 돌려준다. 없으면 0.
#[no_mangle]
pub extern "C" fn inspect(x: i32, y: i32) -> usize {
    let s = state();
    s.popup = inspect_text(s, (x, y));
    s.popup.len()
}

#[no_mangle]
pub extern "C" fn popup_ptr() -> *const u8 {
    state().popup.as_ptr()
}

/// 빗나간 사격이면 `damage_float`의 이 비트가 켜진다.
pub const FLOAT_MISS: u32 = 1 << 24;
/// 치명타 적중이면 이 비트가 켜진다.
pub const FLOAT_CRIT: u32 = 1 << 25;
/// 회복(재생)이면 이 비트가 켜진다.
pub const FLOAT_HEAL: u32 = 1 << 26;

/// 지금 박자에 표적 위로 띄울 것. 없으면 0.
#[no_mangle]
pub extern "C" fn damage_float() -> u32 {
    let s = state();
    let at = |target: usize| {
        let p = s.view[target].pos;
        (p.0 as u32) << 8 | (p.1 as u32) << 16
    };
    match &s.fx {
        Fx::Hit { target, dmg, crit, .. } => *dmg as u32 | at(*target) | if *crit { FLOAT_CRIT } else { 0 },
        Fx::Miss { target, .. } => FLOAT_MISS | at(*target),
        Fx::Regen { target, amount, .. } => FLOAT_HEAL | (*amount as u32) | at(*target),
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn b_meta_ptr() -> *const u32 {
    state().b_meta.as_ptr()
}

#[no_mangle]
pub extern "C" fn b_units_ptr() -> *const u32 {
    state().b_units.as_ptr()
}

#[no_mangle]
pub extern "C" fn b_units_len() -> usize {
    state().b_units.len()
}

#[no_mangle]
pub extern "C" fn b_fx_ptr() -> *const u32 {
    state().b_fx.as_ptr()
}

#[no_mangle]
pub extern "C" fn b_fx_len() -> usize {
    state().b_fx.len()
}

#[no_mangle]
pub extern "C" fn b_relay_pulse() -> u32 {
    state().relay_pulse
}

#[no_mangle]
pub extern "C" fn text_len() -> usize {
    state().text.len()
}

/// 세이브 검증용. 불러온 입력을 다시 돌린 뒤 이 값이 저장된 값과 같아야 한다.
#[no_mangle]
pub extern "C" fn fingerprint_lo() -> u32 {
    state().game.fingerprint() as u32
}

#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use sim::Class;

    fn glyph_at(p: Pos) -> u32 {
        state().frame[idx(p)] & 0x1fffff
    }

    // 전역 상태 하나를 쓰므로 테스트 간 경합을 막기 위해 잠금을 잡는다.
    #[test]
    fn playback() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        init(3);
        assert!(state().frame.iter().all(|&c| c != 0));
        let parts: Vec<String> = state().text.split(SEP).map(String::from).collect();
        assert_eq!(parts.len(), 14);
        assert_eq!(parts[0], "라운드 1");
        assert_eq!(parts[4].lines().count(), 4);

        // 선택은 보여줄 일이 없다. 길게 누르면 호출부호·체력·행동이 나온다.
        assert_eq!(click(1, 3), 1);
        assert_eq!(advance(), 0);
        assert!(inspect(1, 3) > 0);
        assert!(state().popup.starts_with("ψ 저격 ["));
        assert!(state().popup.contains("\n체력 ●●●●● 5/5\n행동 2"));
        assert_eq!(inspect(2, 3), 0);
        assert_eq!(inspect(W - 2, 5), 0, "안 보이는 적은 안 나온다");
        assert!(state().frame.iter().any(|&c| c == cell('·', BROOD, BG)));

        // 가리킨 칸까지의 길이 굵은 점으로 뜬다.
        let dest = *state().game.reachable(0).iter().max_by_key(|p| p.0).unwrap();
        let path = state().game.path_to(0, dest).unwrap();
        hover(dest.0, dest.1);
        assert_eq!(state().frame.iter().filter(|&&c| c == cell('•', BROOD, BG)).count(), path.len());

        // 이동은 한 칸에 한 박자. 그동안 유닛은 길 위에 있다.
        assert_eq!(click(dest.0, dest.1), 1);
        assert_eq!(state().game.units[0].pos, dest);
        assert_eq!(glyph_at((1, 3)), 'ψ' as u32);
        for p in &path {
            assert_eq!(advance() >> 16, BEAT_STEP);
            assert_eq!(glyph_at(*p), 'ψ' as u32);
        }
        assert_eq!(advance(), 0);

        // 건너뛰면 실제 상태와 같아진다.
        end_turn();
        skip();
        let s = state();
        assert!(!s.playing());
        for (v, u) in s.view.iter().zip(&s.game.units) {
            assert_eq!((v.pos, v.hp), (u.pos, u.hp));
        }
        assert!(s.text.starts_with("라운드 2"));

        // 잠복 개조 유닛을 고르면 능력이 뜨고, 쓰면 흙더미가 된다.
        assert_eq!(click(1, 9), 1);
        assert_eq!(state().text.split(SEP).nth(3), Some("잠복"));
        assert_eq!(ability(), 1);
        assert_eq!(advance() >> 16, BEAT_BURROW);
        assert_eq!(glyph_at((1, 9)), '∩' as u32);
        assert_eq!(advance(), 0);
        assert!(state().game.units[2].burrowed);
        assert_eq!(state().text.split(SEP).nth(3), Some(""));
        assert_eq!(ability(), 0);
        inspect(1, 9);
        assert!(state().popup.ends_with("행동 1\n숨음"));

        // 갈 수 없는 빈 칸을 누르면 선택이 풀린다.
        assert!(state().game.selected.is_some());
        assert_eq!(click(W - 1, 0), 1);
        assert!(state().game.selected.is_none());
    }

    #[test]
    fn enemies_in_the_line_of_fire_are_marked() {
        let mut s = State::new(1);
        s.game.tiles.iter_mut().for_each(|t| *t = Tile::Floor);
        let enemy = s.game.units.iter().position(|u| u.class == Class::Trooper).unwrap();
        s.game.units[0].pos = (5, 5);
        s.game.units[enemy].pos = (10, 5);
        s.game.click((5, 5));
        s.sync();
        let at = idx((10, 5));

        render(&mut s);
        assert_eq!(s.frame[at], cell('h', EMPIRE, DIM));
        assert!(s.text.contains("여기서\n 85%  h 보병"), "{}", s.text);

        // 벽 뒤로 들어가면 표시가 꺼지고, 벽을 비켜 설 칸을 가리키면 다시 켜진다.
        s.game.tiles[idx((7, 5))] = Tile::Wall;
        render(&mut s);
        assert_eq!(s.frame[at], cell('h', EMPIRE, BG));
        assert!(s.text.contains("여기서\n사선 없음"));
        s.hover = Some((5, 8));
        render(&mut s);
        assert_eq!(s.frame[at], cell('h', EMPIRE, DIM));
        assert!(s.text.contains("이동 후\n"));

        // 마지막 행동으로 가도 사선은 보여준다. 다음 턴 것이라고 밝힌다.
        s.game.units[0].ap = 1;
        render(&mut s);
        assert_eq!(s.frame[at], cell('h', EMPIRE, DIM));
        assert!(s.text.contains("이동 후, 다음 턴\n"));
    }

    /// 끝까지 재생하면 어느 판이든 실제 상태에 도착하고, 사격은 탄 → 결과 순으로 나온다.
    #[test]
    fn playback_always_lands_on_the_real_state() {
        let (mut hits, mut misses, mut kills, mut hidden_steps) = (0, 0, 0, 0);
        for seed in 0..60u64 {
            let mut s = State::new(seed);
            for _ in 0..25 {
                for u in 0..s.game.units.len() {
                    if s.game.units[u].side != Side::Brood || !s.game.units[u].alive() {
                        continue;
                    }
                    s.game.click(s.game.units[u].pos);
                    let target = (0..s.game.units.len()).find(|&t| s.game.shot(u, t).is_some());
                    let to = match target {
                        Some(t) => s.game.units[t].pos,
                        None => match s.game.reachable(u).iter().max_by_key(|p| p.0) {
                            Some(p) => *p,
                            None => continue,
                        },
                    };
                    s.game.click(to);
                    s.enqueue(false);
                }
                s.game.end_turn();
                s.enqueue(true);
                let steps_queued = s.queue.iter().filter(|e| matches!(e, Event::Step { .. })).count();
                let mut steps_shown = 0;
                let mut last = 0;
                let mut beats = 0;
                loop {
                    let kind = s.advance() >> 16;
                    render(&mut s);
                    match kind {
                        0 => break,
                        BEAT_STEP => steps_shown += 1,
                        BEAT_HIT => hits += 1,
                        BEAT_MISS => misses += 1,
                        BEAT_KILL => kills += 1,
                        _ => {}
                    }
                    if kind == BEAT_HIT || kind == BEAT_MISS {
                        assert_eq!(last, BEAT_TRACER, "seed {seed}");
                    }
                    // 맞으면 피해 숫자, 빗나가면 빗나감 표시, 그 밖에는 아무것도 안 뜬다.
                    let float = match &s.fx {
                        Fx::Hit { dmg, .. } => *dmg as u32,
                        Fx::Miss { .. } => FLOAT_MISS,
                        _ => 0,
                    };
                    assert_eq!(float != 0, kind == BEAT_HIT || kind == BEAT_MISS);
                    assert_eq!(float == FLOAT_MISS, kind == BEAT_MISS);
                    last = kind;
                    beats += 1;
                    assert!(beats < 2000, "seed {seed}: 재생이 안 끝남");
                }
                hidden_steps += steps_queued - steps_shown;
                for (v, u) in s.view.iter().zip(&s.game.units) {
                    assert_eq!((v.pos, v.hp), (u.pos, u.hp), "seed {seed}");
                }
                assert_eq!(s.log_shown, s.game.log.len());
                if s.game.outcome.is_some() {
                    break;
                }
            }
        }
        println!("적중 {hits} / 빗나감 {misses} / 사망 {kills} / 가려진 이동 {hidden_steps}");
        assert!(hits > 0 && misses > 0 && kills > 0 && hidden_steps > 0);
    }

    #[test]
    fn battle_overlay_buffers_and_ghosts() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut g = Game::with_units(9, &[sim::Gene::Sniper], &[Class::Shield, Class::Sensor, Class::Relay]);
        g.tiles.fill(Tile::Floor);
        g.tiles[idx((8, 6))] = Tile::Low;
        g.tiles[idx((8, 5))] = Tile::Wall;
        g.units[0].pos = (4, 6);
        g.units[1].pos = (9, 6); // Shield
        g.units[2].pos = (10, 8); // Sensor
        g.units[3].pos = (24, 6); // Relay (시야 밖)
        g.memory[3] = Some((24, 6)); // 마지막 목격 잔상

        let s = state();
        *s = State::from_game(g, String::new());
        s.game.click((4, 6));
        s.hover = Some((9, 6));
        render(s);

        // (7, 6)의 동쪽(E, bits 10..12)에 낮은 엄폐(1)가 표시된다.
        let m_adj = s.b_meta[idx((7, 6))];
        assert_eq!((m_adj >> 10) & 0x3, 1);
        assert_ne!(m_adj & (1 << 2), 0, "아군 시야 내");

        // (24, 6)은 시야 밖이지만 memory_ghost(bit 7)가 켜진다.
        let m_ghost = s.b_meta[idx((24, 6))];
        assert_eq!(m_ghost & (1 << 2), 0);
        assert_ne!(m_ghost & (1 << 7), 0);

        // 조준 미리보기 b_fx[0] == 1 (방패병 조준)
        assert_eq!(s.b_fx[0], 1);
        assert_eq!(s.b_fx[1], 4);
        assert_eq!(s.b_fx[3], 9);
        assert_eq!(s.b_fx[7], 1);

        // 방패병의 shield_dir != 0 및 탐지기의 is_sensor == 1 확인
        assert!(b_units_len() >= 6);
        let mut saw_shield = false;
        let mut saw_sensor = false;
        for chunk in s.b_units.chunks_exact(2) {
            let w1 = chunk[1];
            if ((w1 >> 21) & 0xf) != 0 {
                saw_shield = true;
            }
            if (w1 & (1 << 25)) != 0 {
                saw_sensor = true;
            }
        }
        assert!(saw_shield, "방패병 방향 벡터가 채워져야 한다");
        assert!(saw_sensor, "탐지기 플래그가 채워져야 한다");
    }

    #[test]
    fn overwatch_slowmo_playback_beat_order() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut g = Game::with_units(15, &[sim::Gene::Plain], &[Class::Trooper]);
        g.tiles.fill(Tile::Floor);
        g.units[0].pos = (4, 6);
        g.units[1].pos = (10, 6);
        g.units[1].overwatch = true;

        let s = state();
        *s = State::from_game(g, String::new());
        render(s);
        // 제국 경계 플래그(w1 bit 30)가 b_units에 노출된다.
        assert!(s.b_units.chunks_exact(2).any(|c| (c[0] & (1 << 26)) != 0 && (c[1] & (1 << 30)) != 0));

        // 아군이 선택 후 경계로 전환되는 박자 확인
        assert_eq!(click(4, 6), 1);
        assert_eq!(state().text.split(SEP).nth(8), Some("경계"));
        assert_eq!(overwatch(), 1);
        assert_eq!(advance() >> 16, BEAT_OVERWATCH);
        assert_eq!(state().b_fx[0], 9);
        assert_eq!(advance(), 0);

        // 아군이 다시 행동력을 갖고 이동하면 제국 경계가 STEP -> OW_TRIGGER(슬로모) -> TRACER(슬로모) -> HIT/MISS 순으로 재생된다.
        state().game.units[0].ap = 2;
        state().game.units[0].overwatch = false;
        state().sync();
        assert_eq!(click(4, 6), 1);
        assert_eq!(click(5, 6), 1);
        assert_eq!(advance() >> 16, BEAT_STEP);
        let ow_beat = advance();
        assert_eq!(ow_beat >> 16, BEAT_OW_TRIGGER);
        assert_eq!(ow_beat & 0xffff, OW_TRIGGER_MS);
        assert_eq!(state().b_fx[0], 10);
        assert!(state().text.starts_with("경계 발동!"));
        let tr_beat = advance();
        assert_eq!(tr_beat >> 16, BEAT_TRACER);
        assert_eq!(tr_beat & 0xffff, TRACER_SLOW_MS);
        assert_eq!(state().b_fx[6], 1, "슬로모 사격 플래그가 켜져야 한다");
        let imp_beat = advance();
        assert!(imp_beat >> 16 == BEAT_HIT || imp_beat >> 16 == BEAT_MISS);
        assert_eq!(imp_beat & 0xffff, IMPACT_SLOW_MS);
    }

    #[test]
    fn xcom_hunker_and_unit_cycling() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut g = Game::with_units(33, &[sim::Gene::Sniper, sim::Gene::Burst], &[Class::Trooper, Class::Shield]);
        g.tiles.fill(Tile::Floor);
        g.units[0].pos = (4, 6);
        g.units[1].pos = (4, 9);
        g.units[2].pos = (10, 6);
        g.units[3].pos = (12, 8);
        let s = state();
        *s = State::from_game(g, String::new());
        render(s);

        // ensure_selected는 첫 분대원을 자동 선택한다.
        let p0 = ensure_selected();
        assert_ne!(p0 & (1 << 16), 0);
        assert_eq!((p0 & 0xff, (p0 >> 8) & 0xff), (4, 6));
        assert_eq!(state().game.selected, Some(0));

        // 사격 가능 적 목록(parts[10])에 적 2명이 포함된다.
        let parts: Vec<String> = state().text.split(SEP).map(String::from).collect();
        assert_eq!(parts[9], "엄호");
        assert_eq!(parts[10].lines().count(), 2);
        assert!(parts[11].starts_with("ψ\t저격"));

        // Tab(select_next)으로 다음 분대원으로 순환한다.
        let p1 = select_next(1);
        assert_eq!((p1 & 0xff, (p1 >> 8) & 0xff), (4, 9));
        assert_eq!(state().game.selected, Some(1));

        // 3번 엄호 실행 -> BEAT_HUNKER 재생 -> 다음 ensure_selected는 행동 가능한 0번 분대원으로 자동 전환.
        assert_eq!(hunker(), 1);
        assert_eq!(advance() >> 16, BEAT_HUNKER);
        assert_eq!(state().b_fx[0], 11);
        assert!(state().b_units.chunks_exact(2).any(|c| (c[1] & (1 << 31)) != 0));
        assert_eq!(advance(), 0);
        let next = ensure_selected();
        assert_eq!((next & 0xff, (next >> 8) & 0xff), (4, 6));
    }
}
