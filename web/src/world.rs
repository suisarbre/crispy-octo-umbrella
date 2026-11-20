//! 월드 화면의 경계. 전투 쪽과 같은 방식이다: 칸 배열과 문구를 만들어 넘기고, JS는 그리기만 한다.

use sim::world::{in_world, Command, Duty, Ground, Order, SiteKind, World, TICKS_PER_DAY, WH, WW};
use sim::{Pos, Side};

use crate::{cell, BG, BROOD, BROOD_DIM, DIM, EMPIRE, FG};

const CELLS: usize = (WW * WH) as usize;
/// 문구 구역 구분자. 순서: 날짜, 고른 부대, 알림.
const SEP: &str = "\u{1f}";

/// 인원 표시 하나의 비트 배치: x | y<<8 | 인원<<16 | 인류면 `LABEL_EMPIRE` | 고른 부대면 `LABEL_SELECTED`.
/// 같은 칸의 부대는 연달아 나온다. 화면은 그 순서대로 위에서 아래로 쌓는다.
pub const LABEL_EMPIRE: u32 = 1 << 28;
pub const LABEL_SELECTED: u32 = 1 << 29;

/// 길 하나의 머리말: 칸 수 | 고른 부대면 `ROUTE_SELECTED` | 한 칸 가는 틱 수<<20. 그 뒤로 칸마다 x | y<<8.
pub const ROUTE_SELECTED: u32 = 1 << 16;

struct State {
    world: World,
    frame: [u32; CELLS],
    text: String,
    popup: String,
    /// 부대마다 인원 표시 하나. `LABEL_*` 참고.
    labels: Vec<u32>,
    /// 움직이는 아군 부대의 길. `w_routes_ptr` 참고.
    routes: Vec<u32>,
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    // wasm은 단일 스레드고, 모든 export는 JS에서 순서대로 호출된다.
    unsafe {
        let slot = &mut *core::ptr::addr_of_mut!(STATE);
        slot.get_or_insert_with(|| State { world: World::new(0), frame: [0; CELLS], text: String::new(), popup: String::new(), labels: Vec::new(), routes: Vec::new() })
    }
}

fn idx(p: Pos) -> usize {
    (p.1 * WW + p.0) as usize
}

fn side_color(side: Side) -> u32 {
    if side == Side::Brood {
        BROOD
    } else {
        EMPIRE
    }
}

fn side_name(side: Side) -> &'static str {
    if side == Side::Brood {
        "아군"
    } else {
        "인류"
    }
}

fn render(s: &mut State) {
    let w = &s.world;
    for y in 0..WH {
        for x in 0..WW {
            s.frame[idx((x, y))] = match w.ground((x, y)) {
                Ground::Wild => cell(' ', DIM, BG),
                Ground::Road => cell('·', DIM, BG),
                Ground::Site(i) => match w.sites[i].kind {
                    SiteKind::Plain => cell('○', FG, BG),
                    SiteKind::Hq(side) => cell('◉', side_color(side), BG),
                },
            };
        }
    }
    // 움직이는 아군 부대의 길은 고르지 않아도 흐리게 보인다. 고른 부대의 길은 아군 색으로 그 위에 그린다.
    // 길이 겹치는 칸은 한 번만 찍힌다. 누가 어느 쪽으로 가는지는 끝점 표시와 흐르는 빛으로 가린다.
    s.routes.clear();
    let mut moving: Vec<usize> = (0..w.forces.len()).filter(|&i| w.forces[i].side == Side::Brood).collect();
    moving.sort_by_key(|&i| w.selected == Some(i));
    for &i in &moving {
        let Order::Move(path) = &w.forces[i].order else { continue };
        let color = if w.selected == Some(i) { BROOD } else { BROOD_DIM };
        for &p in path.iter().filter(|&&p| w.ground(p) == Ground::Road) {
            s.frame[idx(p)] = cell('•', color, BG);
        }
    }
    // 끝점은 길을 다 그린 뒤에 찍는다. 다른 부대의 길이 지나가도 끝점 표시가 남게.
    for i in moving {
        let Order::Move(path) = &w.forces[i].order else { continue };
        let selected = w.selected == Some(i);
        if let Some(&end) = path.last() {
            match w.ground(end) {
                Ground::Road => s.frame[idx(end)] = cell('◇', if selected { BROOD } else { FG }, BG),
                // 목적지가 거점이면 거점을 아군 색으로 칠한다.
                Ground::Site(site) if w.sites[site].kind == SiteKind::Plain => s.frame[idx(end)] = cell('○', BROOD, BG),
                _ => {}
            }
        }
        s.routes.push(path.len() as u32 | if selected { ROUTE_SELECTED } else { 0 } | w.forces[i].step_ticks() << 20);
        s.routes.extend(path.iter().map(|p| p.0 as u32 | (p.1 as u32) << 8));
    }
    // 찍어 둔 칸까지의 길. 아직 명령은 안 들어갔다.
    if let (Some(sel), Some(target)) = (w.selected, w.target) {
        if let Some(path) = w.route(w.forces[sel].pos, target) {
            for &p in path.iter().filter(|&&p| w.ground(p) == Ground::Road) {
                s.frame[idx(p)] = cell(if p == target { '◇' } else { '•' }, BROOD, BG);
            }
            if let Ground::Site(site) = w.ground(target) {
                if w.sites[site].kind == SiteKind::Plain {
                    s.frame[idx(target)] = cell('○', BG, BROOD);
                }
            }
        }
    }
    for (i, f) in w.forces.iter().enumerate() {
        let color = side_color(f.side);
        // 고른 부대가 같은 칸의 다른 부대에 가려지지 않게 한다.
        if w.selected.is_some_and(|sel| sel != i && w.forces[sel].pos == f.pos) {
            continue;
        }
        s.frame[idx(f.pos)] = if w.selected == Some(i) { cell('◆', BG, color) } else { cell('◆', color, BG) };
    }

    // 인원 표시. 같은 칸끼리 모이도록 칸 순서로, 그 안에서는 부대 번호 순서로.
    let mut order: Vec<usize> = (0..w.forces.len()).collect();
    order.sort_by_key(|&i| (idx(w.forces[i].pos), i));
    s.labels = order
        .into_iter()
        .map(|i| {
            let f = &w.forces[i];
            let side = if f.side == Side::Empire { LABEL_EMPIRE } else { 0 };
            let selected = if w.selected == Some(i) { LABEL_SELECTED } else { 0 };
            f.pos.0 as u32 | (f.pos.1 as u32) << 8 | f.size.min(0xfff) << 16 | side | selected
        })
        .collect();

    let sections = [
        format!("D+{}", w.day()),
        match w.selected {
            Some(sel) => {
                let f = &w.forces[sel];
                format!("◆ {}명  {}", f.size, doing(f))
            }
            None => "—".to_string(),
        },
        match w.clash {
            Some((a, b)) => format!("충돌  {}명 대 {}명", w.forces[a].size, w.forces[b].size),
            None => String::new(),
        },
    ];
    s.text = sections.join(SEP);
}

/// 부대가 지금 하는 일을 한마디로.
fn doing(f: &sim::world::Force) -> String {
    match (&f.order, f.duty) {
        (_, Duty::Scout(..)) => "정찰".to_string(),
        (Order::Hold, Duty::Ambush) => "매복".to_string(),
        (Order::Hold, Duty::Garrison) => "주둔".to_string(),
        (Order::Hold, Duty::None) => "대기".to_string(),
        (Order::Move(path), Duty::Ambush) => format!("매복하러 이동 {}칸", path.len()),
        (Order::Move(path), Duty::Garrison) => format!("주둔하러 이동 {}칸", path.len()),
        (Order::Move(path), Duty::None) => format!("이동 {}칸", path.len()),
    }
}

/// 칸 하나에 무엇이 있는지. 길게 누르거나 마우스를 올렸을 때 뜬다. 아무것도 없으면 빈 문자열.
fn inspect_text(w: &World, p: Pos) -> String {
    let mut lines = Vec::new();
    if let Ground::Site(i) = w.ground(p) {
        lines.push(match w.sites[i].kind {
            SiteKind::Plain => "○ 거점".to_string(),
            SiteKind::Hq(side) => format!("◉ {} 본진", side_name(side)),
        });
    }
    for i in w.forces_at(p) {
        let f = &w.forces[i];
        // 인류 부대가 무엇을 하는 중인지는 보여주지 않는다.
        if f.side == Side::Brood {
            lines.push(format!("◆ 아군 {}명  {}", f.size, doing(f)));
        } else {
            lines.push(format!("◆ {} {}명", side_name(f.side), f.size));
        }
    }
    lines.join("\n")
}

#[no_mangle]
pub extern "C" fn w_init(seed: u32) {
    let s = state();
    s.world = World::new(seed as u64);
    render(s);
}

#[no_mangle]
pub extern "C" fn w_click(x: i32, y: i32) -> u32 {
    let s = state();
    let changed = s.world.click((x, y));
    render(s);
    changed as u32
}

/// 고른 부대에 명령을 내린다. 0 이동, 1 매복, 2 주둔, 3 정찰. 들어갔으면 1.
#[no_mangle]
pub extern "C" fn w_command(kind: u32) -> u32 {
    let s = state();
    let command = match kind {
        0 => Command::Move,
        1 => Command::Ambush,
        2 => Command::Garrison,
        3 => Command::Scout,
        _ => return 0,
    };
    let done = s.world.command(command);
    render(s);
    done as u32
}

/// 명령을 고를 차례인가. 아니면 0. 맞으면 1 | 주둔할 수 있으면 2 | 찍은 칸 x<<8 | y<<16.
#[no_mangle]
pub extern "C" fn w_menu() -> u32 {
    let w = &state().world;
    match (w.selected, w.target) {
        (Some(_), Some(t)) => 1 | (w.can_garrison() as u32) << 1 | (t.0 as u32) << 8 | (t.1 as u32) << 16,
        _ => 0,
    }
}

/// 시간을 `n`틱 넘긴다. 실제로 넘어간 틱 수를 돌려준다. 충돌이 나면 거기서 멈춘다.
#[no_mangle]
pub extern "C" fn w_tick(n: u32) -> u32 {
    let s = state();
    let before = s.world.tick;
    for _ in 0..n {
        s.world.tick();
    }
    render(s);
    (s.world.tick - before) as u32
}

/// 오늘 남은 틱 수. 하루를 넘길 때 이만큼 굴린다.
#[no_mangle]
pub extern "C" fn w_ticks_left_today() -> u32 {
    let t = state().world.tick;
    (TICKS_PER_DAY - t % TICKS_PER_DAY) as u32
}

/// 충돌로 시간이 멈춰 있는가.
#[no_mangle]
pub extern "C" fn w_halted() -> u32 {
    state().world.clash.is_some() as u32
}

#[no_mangle]
pub extern "C" fn w_cols() -> i32 {
    WW
}

#[no_mangle]
pub extern "C" fn w_rows() -> i32 {
    WH
}

#[no_mangle]
pub extern "C" fn w_frame_ptr() -> *const u32 {
    state().frame.as_ptr()
}

/// 움직이는 아군 부대의 길들. 길마다 머리말 하나와 칸들. 화면이 방향을 보여주는 빛을 흘리는 데 쓴다.
#[no_mangle]
pub extern "C" fn w_routes_ptr() -> *const u32 {
    state().routes.as_ptr()
}

#[no_mangle]
pub extern "C" fn w_routes_len() -> usize {
    state().routes.len()
}

#[no_mangle]
pub extern "C" fn w_labels_ptr() -> *const u32 {
    state().labels.as_ptr()
}

#[no_mangle]
pub extern "C" fn w_labels_len() -> usize {
    state().labels.len()
}

#[no_mangle]
pub extern "C" fn w_text_ptr() -> *const u8 {
    state().text.as_ptr()
}

#[no_mangle]
pub extern "C" fn w_text_len() -> usize {
    state().text.len()
}

#[no_mangle]
pub extern "C" fn w_inspect(x: i32, y: i32) -> usize {
    let s = state();
    s.popup = if in_world((x, y)) { inspect_text(&s.world, (x, y)) } else { String::new() };
    s.popup.len()
}

#[no_mangle]
pub extern "C" fn w_popup_ptr() -> *const u8 {
    state().popup.as_ptr()
}

#[no_mangle]
pub extern "C" fn w_fingerprint_lo() -> u32 {
    state().world.fingerprint() as u32
}

/// 화면 확인용 (examples/wdump.rs). 칸 배열과 문구를 JSON으로 찍는다.
#[doc(hidden)]
pub fn dump(seed: u32, clicks: &[Pos], ticks: u32) -> String {
    w_init(seed);
    // x가 음수면 명령이다: (-1, 종류).
    for &(x, y) in clicks {
        if x < 0 {
            w_command(y as u32);
        } else {
            w_click(x, y);
        }
    }
    w_tick(ticks);
    let s = state();
    format!("{{\"frame\":{:?},\"labels\":{:?},\"routes\":{:?},\"menu\":{},\"text\":{:?}}}", s.frame.to_vec(), s.labels, s.routes, w_menu(), s.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_screen() {
        w_init(3);
        let s = state();
        let home = s.world.sites.iter().find(|x| x.kind == SiteKind::Hq(Side::Brood)).unwrap().pos;
        assert!(s.text.starts_with("D+0"));
        assert_eq!(w_ticks_left_today(), 24);
        assert_eq!(s.frame[idx(home)], cell('◆', BROOD, BG));

        // 부대마다 인원 표시가 하나씩. 본진의 셋은 한 칸에 6, 6, 2 순서로 쌓인다.
        assert_eq!(s.labels.len(), s.world.forces.len());
        let at_home: Vec<u32> = s.labels.iter().filter(|&&l| (l & 0xff, (l >> 8) & 0xff) == (home.0 as u32, home.1 as u32)).map(|l| (l >> 16) & 0xfff).collect();
        assert_eq!(at_home, vec![6, 6, 2]);
        assert_eq!(s.labels.iter().filter(|&&l| l & LABEL_EMPIRE != 0).count(), 3);
        assert!(s.labels.iter().all(|&l| l & LABEL_SELECTED == 0));

        // 본진 칸에는 본진과 부대 셋이 있다.
        assert!(w_inspect(home.0, home.1) > 0);
        assert_eq!(state().popup.lines().count(), 4);
        assert!(state().popup.starts_with("◉ 아군 본진"));

        // 부대를 골라 거점을 찍으면 명령을 고를 차례가 된다. 아직 움직이지 않는다.
        assert_eq!(w_click(home.0, home.1), 1);
        assert_eq!(state().labels.iter().filter(|&&l| l & LABEL_SELECTED != 0).count(), 1);
        assert_eq!(w_menu(), 0);
        let sel = state().world.selected.unwrap();
        let dest = state().world.sites.iter().find(|x| x.kind == SiteKind::Plain).unwrap().pos;
        assert_eq!(w_click(dest.0, dest.1), 1);
        assert_eq!(w_menu(), 1 | 2 | (dest.0 as u32) << 8 | (dest.1 as u32) << 16);
        assert!(state().frame.iter().any(|&c| c == cell('•', BROOD, BG)));
        assert!(state().routes.is_empty());

        // 길 위의 칸을 찍으면 주둔은 못 고른다.
        let road = state().world.route(home, dest).unwrap()[0];
        w_click(road.0, road.1);
        assert_eq!(w_menu() & 2, 0);
        assert_eq!(w_command(2), 0);
        w_click(dest.0, dest.1);

        // 명령을 고르면 선택이 풀리고, 길은 흐린 아군 색으로 남는다.
        assert_eq!(w_command(2), 1);
        assert_eq!(w_menu(), 0);
        let s = state();
        assert!(s.world.selected.is_none());
        assert!(s.frame.iter().any(|&c| c == cell('•', BROOD_DIM, BG)));
        assert!(!s.frame.iter().any(|&c| c == cell('•', BROOD, BG)));
        assert_eq!(s.frame[idx(dest)], cell('○', BROOD, BG), "목적지 거점은 아군 색");
        let Order::Move(path) = &s.world.forces[sel].order else { panic!("이동 중이어야 한다") };
        assert_eq!(s.routes.len(), path.len() + 1);
        assert_eq!(s.routes[0] & 0xffff, path.len() as u32);
        assert_eq!(s.routes[0] & ROUTE_SELECTED, 0);
        assert_eq!(s.routes[1], path[0].0 as u32 | (path[0].1 as u32) << 8);
        w_inspect(home.0, home.1);
        assert!(state().popup.contains("주둔하러 이동"));

        // 다시 고르면 그 길이 아군 색으로 바뀐다.
        let at = s.world.forces[sel].pos;
        while state().world.selected != Some(sel) {
            w_click(at.0, at.1);
        }
        assert!(state().frame.iter().any(|&c| c == cell('•', BROOD, BG)));
        assert_ne!(state().routes[0] & ROUTE_SELECTED, 0);

        // 시간이 가면 움직인다.
        assert_eq!(w_tick(30), 30);
        assert_ne!(state().world.forces[sel].pos, home);
        assert!(state().text.starts_with("D+1"));
        assert_eq!(w_ticks_left_today(), 18);
        assert_eq!(w_halted(), 0);
    }
}
