//! 브라우저와 코어 사이의 얇은 경계. wasm-bindgen 없이 숫자와 포인터만 주고받는다.
//! JS는 `frame_ptr`에서 칸 배열을, `text_ptr`에서 문구를 읽어 그리기만 한다.
//!
//! 코어는 입력을 받는 즉시 결과까지 계산한다. 여기서는 그 사이에 일어난 일(`sim::Event`)을
//! 한 박자씩 풀어서 보여준다. 화면은 `view`(보여주는 중인 위치와 체력)를 그리고,
//! 재생이 끝나면 `view`는 코어의 실제 상태와 같아진다.

pub mod world;

use std::collections::VecDeque;

use sim::{dist, Class, Event, Game, Pos, Side, Tile, H, SIGHT, W};

/// 팔레트 번호. 실제 색은 www/main.js가 정한다.
pub const BG: u32 = 0;
pub const DIM: u32 = 1;
pub const FG: u32 = 2;
pub const BROOD: u32 = 3;
pub const EMPIRE: u32 = 4;

/// `advance`가 돌려주는 박자 종류. 상위 16비트에 종류, 하위 16비트에 길이(ms).
pub const BEAT_STEP: u32 = 1;
pub const BEAT_TRACER: u32 = 2;
pub const BEAT_HIT: u32 = 3;
pub const BEAT_MISS: u32 = 4;
pub const BEAT_KILL: u32 = 5;
pub const BEAT_BURROW: u32 = 6;
pub const BEAT_SMOKE: u32 = 7;

const STEP_MS_BROOD: u32 = 55;
const STEP_MS_EMPIRE: u32 = 90;
const TRACER_MS: u32 = 110;
const IMPACT_MS: u32 = 170;
const KILL_MS: u32 = 240;
const BURROW_MS: u32 = 160;
const SMOKE_MS: u32 = 240;
/// 빗나간 탄이 표적을 지나 더 날아가는 칸 수.
const OVERSHOOT: usize = 3;

const CELLS: usize = (W * H) as usize;
/// 문구 구역 구분자. 순서: 상황, 중계 링크, 장부 내역, 장부 결과, 쓸 수 있는 능력.
const SEP: &str = "\u{1f}";

#[derive(Clone, Copy)]
struct ViewUnit {
    pos: Pos,
    hp: i32,
    burrowed: bool,
}

enum Fx {
    None,
    /// 날아가는 탄. `color`는 쏜 쪽 색.
    Tracer { cells: Vec<Pos>, color: u32 },
    /// 맞은 순간. 표적 칸이 번쩍인다.
    Hit { target: usize, dmg: i32 },
    /// 빗나간 탄의 자국.
    Miss { cells: Vec<Pos>, target: usize },
    Death { pos: Pos },
}

struct State {
    game: Game,
    hover: Option<Pos>,
    frame: [u32; CELLS],
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
}

impl State {
    fn new(seed: u64) -> State {
        let mut s = State {
            game: Game::new(seed),
            hover: None,
            frame: [0; CELLS],
            text: String::new(),
            popup: String::new(),
            view: Vec::new(),
            view_smoke: Vec::new(),
            queue: VecDeque::new(),
            shot_stage: 0,
            fx: Fx::None,
            log_shown: 0,
            empire_phase: false,
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
        self.empire_phase = false;
        self.view = self.game.units.iter().map(|u| ViewUnit { pos: u.pos, hp: u.hp, burrowed: u.burrowed }).collect();
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
    }

    /// 보여주는 중인 위치 기준으로 아군이 `p`를 보고 있는가.
    fn seen(&self, p: Pos) -> bool {
        self.view.iter().zip(&self.game.units).any(|(v, u)| {
            u.side == Side::Brood && v.hp > 0 && dist(v.pos, p) <= SIGHT && self.game.los(v.pos, p)
        })
    }

    fn view_unit_at(&self, p: Pos) -> Option<usize> {
        self.view.iter().position(|v| v.hp > 0 && v.pos == p)
    }

    /// 다음 박자를 화면에 반영한다. 돌려주는 값은 종류<<16 | 길이(ms). 끝났으면 0.
    fn advance(&mut self) -> u32 {
        loop {
            self.fx = Fx::None;
            let Some(event) = self.queue.front().cloned() else {
                self.sync();
                return 0;
            };
            match event {
                Event::Step { unit, from, to } => {
                    self.queue.pop_front();
                    let empire = self.game.units[unit].side == Side::Empire;
                    let before = empire && self.seen(from);
                    self.view[unit].pos = to;
                    self.view[unit].burrowed = false;
                    // 시야 밖에서 시야 밖으로 가는 적은 보여주지 않는다.
                    if empire && !before && !self.seen(to) {
                        continue;
                    }
                    return BEAT_STEP << 16 | if empire { STEP_MS_EMPIRE } else { STEP_MS_BROOD };
                }
                Event::Shot { shooter, target, hit, dmg, killed, log_lines } => {
                    let (a, b) = (self.view[shooter].pos, self.view[target].pos);
                    match self.shot_stage {
                        0 => {
                            let color = if self.game.units[shooter].side == Side::Brood { BROOD } else { EMPIRE };
                            self.view[shooter].burrowed = false;
                            self.fx = Fx::Tracer { cells: Game::line(a, b), color };
                            self.shot_stage = 1;
                            return BEAT_TRACER << 16 | TRACER_MS;
                        }
                        1 => {
                            self.log_shown += log_lines;
                            self.shot_stage = 2;
                            if hit {
                                self.fx = Fx::Hit { target, dmg };
                                return BEAT_HIT << 16 | IMPACT_MS;
                            }
                            self.fx = Fx::Miss { cells: self.overshoot(a, b), target };
                            return BEAT_MISS << 16 | IMPACT_MS;
                        }
                        _ => {
                            self.queue.pop_front();
                            self.shot_stage = 0;
                            self.view[target].hp -= dmg;
                            if killed {
                                self.fx = Fx::Death { pos: b };
                                return BEAT_KILL << 16 | KILL_MS;
                            }
                        }
                    }
                }
                Event::Burrow { unit } => {
                    self.queue.pop_front();
                    self.view[unit].burrowed = true;
                    return BEAT_BURROW << 16 | BURROW_MS;
                }
                Event::Smoke { center, .. } => {
                    self.queue.pop_front();
                    for y in center.1 - 1..=center.1 + 1 {
                        for x in center.0 - 1..=center.0 + 1 {
                            if in_frame((x, y)) && self.game.tile((x, y)) != Tile::Wall {
                                self.view_smoke[idx((x, y))] = true;
                            }
                        }
                    }
                    return BEAT_SMOKE << 16 | SMOKE_MS;
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

fn render(s: &mut State) {
    let playing = s.playing();
    let g = &s.game;
    for y in 0..H {
        for x in 0..W {
            s.frame[idx((x, y))] = match g.tile((x, y)) {
                Tile::Floor if s.view_smoke[idx((x, y))] => cell('≈', DIM, BG),
                Tile::Floor => cell('·', DIM, BG),
                Tile::Low => cell('▄', DIM, BG),
                Tile::Wall => cell('█', DIM, BG),
            };
        }
    }

    let can_act = !playing && g.outcome.is_none();
    if let (Some(sel), true) = (g.selected, can_act) {
        if g.units[sel].ap > 0 {
            for p in g.reachable(sel) {
                s.frame[idx(p)] = cell('·', BROOD, BG);
            }
            // 가리킨 칸까지 실제로 걸어갈 길.
            if let Some(path) = s.hover.and_then(|h| g.path_to(sel, h)) {
                for p in path {
                    s.frame[idx(p)] = cell('•', BROOD, BG);
                }
            }
        }
    }

    let lanes = fire_lanes(s, can_act);

    match &s.fx {
        Fx::Tracer { cells, color } => {
            for &p in cells {
                // 엄폐물은 가리지 않는다. 탄은 바닥 칸에만 그린다.
                if g.tile(p) == Tile::Floor {
                    s.frame[idx(p)] = cell('•', *color, BG);
                }
            }
        }
        Fx::Miss { cells, .. } => {
            for &p in cells.iter().filter(|p| g.tile(**p) == Tile::Floor) {
                s.frame[idx(p)] = cell('•', DIM, BG);
            }
        }
        Fx::Death { pos } => s.frame[idx(*pos)] = cell('×', FG, BG),
        Fx::Hit { .. } | Fx::None => {}
    }

    for (i, u) in g.units.iter().enumerate() {
        let v = s.view[i];
        if v.hp <= 0 {
            continue;
        }
        // 땅에 숨은 아군은 흙더미로 보인다.
        let glyph = if v.burrowed { '∩' } else { u.glyph() };
        let struck = matches!(s.fx, Fx::Hit { target, .. } if target == i);
        let shown = match u.side {
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
            } else if lanes.shots.iter().any(|&(t, _)| t == i) {
                // 사선에 들어온 적은 바탕이 밝다.
                cell(glyph, EMPIRE, DIM)
            } else {
                cell(glyph, EMPIRE, BG)
            }),
            Side::Empire => None,
        };
        if let Some(c) = shown {
            s.frame[idx(v.pos)] = c;
        }
    }

    let (ledger, result) = if can_act { ledger(s, &lanes) } else { ("—".to_string(), String::new()) };
    let sections = [
        match (playing, g.outcome) {
            (true, _) if s.empire_phase => "제국 행동".to_string(),
            (false, Some(Side::Brood)) => "제국 분대 전멸".to_string(),
            (false, Some(Side::Empire)) => "전원 사망".to_string(),
            _ => format!("라운드 {}", g.round),
        },
        link_line(s),
        ledger,
        result,
        if can_act && g.can_burrow() { "잠복".to_string() } else { String::new() },
    ];
    s.text = sections.join(SEP);
}

/// 중계기에 누가 물려 있는지. 이 게임의 표식이다.
fn link_line(s: &State) -> String {
    let units = s.game.units.iter().zip(&s.view).filter(|(u, _)| u.side == Side::Empire);
    let up = units.clone().any(|(u, v)| u.class == Class::Relay && v.hp > 0);
    let mut line = String::from(if up { "& ──" } else { "×   " });
    for (u, v) in units.filter(|(u, _)| u.class != Class::Relay) {
        line.push(' ');
        line.push(if v.hp > 0 { u.glyph() } else { '·' });
    }
    line.push_str(if up { "  연결" } else { "  두절" });
    line
}

/// 길게 눌렀을 때 뜨는 창의 내용. 보이는 유닛이 없는 칸이면 빈 문자열.
fn inspect_text(s: &State, p: Pos) -> String {
    let Some(i) = s.view_unit_at(p) else { return String::new() };
    let u = &s.game.units[i];
    if u.side == Side::Empire && !s.seen(p) {
        return String::new();
    }
    let (hp, max) = (s.view[i].hp.max(0), u.class.def().hp);
    let pips: String = (0..max).map(|k| if k < hp { '●' } else { '○' }).collect();
    let mut out = format!("{} {}\n체력 {pips} {hp}/{max}", u.glyph(), u.name());
    if u.side == Side::Brood {
        out.push_str(&format!("\n행동 {}", if s.playing() { 0 } else { u.ap }));
    }
    if s.view[i].burrowed {
        out.push_str("\n숨음");
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
    /// (적, 명중률). 높은 순.
    shots: Vec<(usize, i32)>,
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
                lanes.shots.push((t, shot.chance));
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
    for &(t, chance) in &lanes.shots {
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

/// 지금 박자에 표적 위로 띄울 것. 없으면 0. 맞았으면 피해 | x<<8 | y<<16, 빗나갔으면 거기에 `FLOAT_MISS`.
#[no_mangle]
pub extern "C" fn damage_float() -> u32 {
    let s = state();
    let at = |target: usize| {
        let p = s.view[target].pos;
        (p.0 as u32) << 8 | (p.1 as u32) << 16
    };
    match &s.fx {
        Fx::Hit { target, dmg } => *dmg as u32 | at(*target),
        Fx::Miss { target, .. } => FLOAT_MISS | at(*target),
        _ => 0,
    }
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
mod tests {
    use super::*;

    fn glyph_at(p: Pos) -> u32 {
        state().frame[idx(p)] & 0x1fffff
    }

    // 전역 상태 하나를 쓰므로 한 테스트 안에서 순서대로 본다.
    #[test]
    fn playback() {
        init(3);
        assert!(state().frame.iter().all(|&c| c != 0));
        let parts: Vec<String> = state().text.split(SEP).map(String::from).collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0], "라운드 1");
        assert_eq!(parts[1], "& ── h h h s h  연결");

        // 선택은 보여줄 일이 없다. 길게 누르면 체력과 행동이 나온다.
        assert_eq!(click(1, 3), 1);
        assert_eq!(advance(), 0);
        assert!(inspect(1, 3) > 0);
        assert_eq!(state().popup, "ψ 저격\n체력 ●●●●● 5/5\n행동 2");
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
        assert!(state().text.ends_with("잠복"));
        assert_eq!(ability(), 1);
        assert_eq!(advance() >> 16, BEAT_BURROW);
        assert_eq!(glyph_at((1, 9)), '∩' as u32);
        assert_eq!(advance(), 0);
        assert!(state().game.units[2].burrowed);
        assert!(!state().text.ends_with("잠복"));
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
}
