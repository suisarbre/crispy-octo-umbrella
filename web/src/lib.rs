//! 브라우저와 코어 사이의 얇은 경계. wasm-bindgen 없이 숫자와 포인터만 주고받는다.
//! JS는 `frame_ptr`에서 칸 배열을, `text_ptr`에서 상태 문구를 읽어 그리기만 한다.

use sim::{Game, Pos, Side, Tile, H, W};

/// 팔레트 번호. 실제 색은 www/main.js가 정한다.
pub const BG: u32 = 0;
pub const DIM: u32 = 1;
pub const FG: u32 = 2;
pub const BROOD: u32 = 3;
pub const EMPIRE: u32 = 4;

const CELLS: usize = (W * H) as usize;

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

    let mut t = String::new();
    match g.outcome {
        Some(Side::Brood) => t.push_str("제국 분대 전멸.\n"),
        Some(Side::Empire) => t.push_str("전원 사망.\n"),
        None => t.push_str(&format!("라운드 {}\n", g.round)),
    }
    t.push_str(if g.network_up() { "제국 중계: 연결\n" } else { "제국 중계: 두절\n" });
    match g.selected {
        Some(sel) => {
            let u = &g.units[sel];
            let d = u.class.def();
            t.push_str(&format!("{} {}  체력 {}/{}  행동 {}\n", d.glyph, d.name, u.hp, d.hp, u.ap));
        }
        None => t.push_str("—\n"),
    }
    t.push_str(&hover_line(g, s.hover));
    t.push('\n');
    let from = g.log.len().saturating_sub(6);
    for line in &g.log[from..] {
        t.push('\n');
        t.push_str(line);
    }
    s.text = t;
}

fn hover_line(g: &Game, hover: Option<Pos>) -> String {
    let Some(p) = hover else { return "—".into() };
    let Some(t) = g.unit_at(p) else { return "—".into() };
    let u = &g.units[t];
    let d = u.class.def();
    if u.side == Side::Brood {
        return format!("{} {}  체력 {}/{}", d.glyph, d.name, u.hp, d.hp);
    }
    if !g.seen_by(Side::Brood, p) {
        return "—".into();
    }
    let head = format!("{} {}  체력 {}/{}", d.glyph, d.name, u.hp, d.hp);
    let Some(sel) = g.selected else { return head };
    match g.shot(sel, t) {
        Some(s) => {
            let mut parts = format!("조준 {}", s.aim);
            if s.cover > 0 {
                parts.push_str(&format!(" − 엄폐 {}", s.cover));
            }
            if s.falloff > 0 {
                parts.push_str(&format!(" − 거리 {}", s.falloff));
            }
            format!("{head}   명중 {}%  ({parts})", s.chance)
        }
        None => format!("{head}   사선 없음"),
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
        assert!(state().text.starts_with("라운드 2"));
    }
}
