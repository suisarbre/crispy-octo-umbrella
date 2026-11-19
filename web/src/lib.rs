//! 브라우저와 코어 사이의 얇은 경계. wasm-bindgen 없이 숫자와 포인터만 주고받는다.
//! JS는 `frame_ptr`에서 칸 배열을, `text_ptr`에서 상태 문구를 읽어 그리기만 한다.

use sim::{Class, Game, Pos, Side, Tile, Unit, H, W};

/// 팔레트 번호. 실제 색은 www/main.js가 정한다.
pub const BG: u32 = 0;
pub const DIM: u32 = 1;
pub const FG: u32 = 2;
pub const BROOD: u32 = 3;
pub const EMPIRE: u32 = 4;

const CELLS: usize = (W * H) as usize;
const LOG_LINES: usize = 6;
/// 문구 구역 구분자. 순서: 상황, 중계 링크, 선택 유닛, 장부 내역, 장부 결과, 기록.
const SEP: &str = "\u{1f}";

struct State {
    game: Game,
    hover: Option<Pos>,
    frame: [u32; CELLS],
    text: String,
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    // wasm은 단일 스레드고, 모든 export는 JS에서 순서대로 호출된다.
    unsafe {
        let slot = &mut *core::ptr::addr_of_mut!(STATE);
        slot.get_or_insert_with(|| State { game: Game::new(0), hover: None, frame: [0; CELLS], text: String::new() })
    }
}

fn cell(glyph: char, fg: u32, bg: u32) -> u32 {
    glyph as u32 | fg << 24 | bg << 28
}

fn render(s: &mut State) {
    let g = &s.game;
    for y in 0..H {
        for x in 0..W {
            s.frame[(y * W + x) as usize] = match g.tile((x, y)) {
                Tile::Floor => cell('·', DIM, BG),
                Tile::Low => cell('▄', DIM, BG),
                Tile::Wall => cell('█', DIM, BG),
            };
        }
    }
    if let Some(sel) = g.selected {
        if g.units[sel].ap > 0 && g.outcome.is_none() {
            for p in g.reachable(sel) {
                s.frame[(p.1 * W + p.0) as usize] = cell('·', BROOD, BG);
            }
        }
    }
    for (i, u) in g.units.iter().enumerate() {
        if !u.alive() {
            continue;
        }
        let idx = (u.pos.1 * W + u.pos.0) as usize;
        let glyph = u.class.def().glyph;
        match u.side {
            Side::Brood => {
                let spent = u.ap == 0;
                s.frame[idx] = if g.selected == Some(i) {
                    cell(glyph, BG, BROOD)
                } else {
                    cell(glyph, if spent { DIM } else { BROOD }, BG)
                };
            }
            Side::Empire => {
                if g.seen_by(Side::Brood, u.pos) {
                    let targeted = s.hover == Some(u.pos);
                    s.frame[idx] = if targeted { cell(glyph, BG, EMPIRE) } else { cell(glyph, EMPIRE, BG) };
                }
            }
        }
    }

    let (ledger, result) = ledger(g, s.hover);
    let from = g.log.len().saturating_sub(LOG_LINES);
    let sections = [
        match g.outcome {
            Some(Side::Brood) => "제국 분대 전멸".to_string(),
            Some(Side::Empire) => "전원 사망".to_string(),
            None => format!("라운드 {}", g.round),
        },
        link_line(g),
        match g.selected {
            Some(sel) => format!("{}  행동 {}", unit_line(&g.units[sel]), g.units[sel].ap),
            None => "—".to_string(),
        },
        ledger,
        result,
        g.log[from..].join("\n"),
    ];
    s.text = sections.join(SEP);
}

/// 중계기에 누가 물려 있는지. 이 게임의 표식이다.
fn link_line(g: &Game) -> String {
    let up = g.network_up();
    let mut line = String::from(if up { "& ──" } else { "×   " });
    for u in g.units.iter().filter(|u| u.side == Side::Empire && u.class != Class::Relay) {
        line.push(' ');
        line.push(if u.alive() { u.class.def().glyph } else { '·' });
    }
    line.push_str(if up { "  연결" } else { "  두절" });
    line
}

fn unit_line(u: &Unit) -> String {
    let d = u.class.def();
    format!("{} {}  체력 {}/{}", d.glyph, d.name, u.hp, d.hp)
}

fn minus(v: i32) -> String {
    if v > 0 { format!("−{v}") } else { "0".to_string() }
}

/// 명중률 장부. (내역, 결과) 두 조각으로 나눠서 결과만 따로 칠할 수 있게 한다.
fn ledger(g: &Game, hover: Option<Pos>) -> (String, String) {
    let none = || ("—".to_string(), String::new());
    let Some(p) = hover else { return none() };
    let Some(t) = g.unit_at(p) else { return none() };
    let u = &g.units[t];
    if u.side == Side::Brood {
        return (unit_line(u), String::new());
    }
    if !g.seen_by(Side::Brood, p) {
        return none();
    }
    let head = unit_line(u);
    let Some(sel) = g.selected else { return (head, String::new()) };
    match g.shot(sel, t) {
        Some(s) => (
            format!("{head}\n조준 {:>5}\n엄폐 {:>5}\n거리 {:>5}", s.aim, minus(s.cover), minus(s.falloff)),
            format!("명중 {:>5}%", s.chance),
        ),
        None => (head, "사선 없음".to_string()),
    }
}

#[no_mangle]
pub extern "C" fn init(seed: u32) {
    let s = state();
    s.game = Game::new(seed as u64);
    s.hover = None;
    render(s);
}

#[no_mangle]
pub extern "C" fn click(x: i32, y: i32) -> u32 {
    let s = state();
    let changed = s.game.click((x, y));
    render(s);
    changed as u32
}

#[no_mangle]
pub extern "C" fn end_turn() {
    let s = state();
    s.game.end_turn();
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

    #[test]
    fn frame_and_text_fill_in() {
        init(3);
        let s = state();
        assert!(s.frame.iter().all(|&c| c != 0));
        assert!(s.text.starts_with("라운드 1"));
        // 아군 첫 유닛을 고르면 갈 수 있는 칸이 아군 색으로 칠해진다.
        assert_eq!(click(1, 3), 1);
        let s = state();
        assert!(s.frame.iter().any(|&c| c == cell('·', BROOD, BG)));
        end_turn();
        let text = state().text.clone();
        let parts: Vec<&str> = text.split(SEP).collect();
        assert_eq!(parts.len(), 6);
        assert_eq!(parts[0], "라운드 2");
        assert_eq!(parts[1], "& ── h h h h  연결");
    }
}
