//! 월드 화면의 경계. 칸 배열, 경로, 라벨, 구조화 문구를 만들어 넘기고 JS는 그리기와 카메라만 담당한다.

use sim::world::{
    in_world, Command, Duty, ForceRole, Ground, Order, SiteKind, StopReason, World, SECTOR_COLS,
    SECTOR_ROWS, TICKS_PER_DAY, WH, WW,
};
use sim::{Pos, Side};

use crate::{cell, BG, BROOD, BROOD_DIM, DIM, EMPIRE, FG};

const CELLS: usize = (WW * WH) as usize;
/// 문구 구역 구분자.
/// 0: 데스크탑 상단 바, 1: 모바일 상단 바, 2: 특수부대 요약,
/// 3: 지휘망 제안 목록, 4: 전선 사건 로그, 5: 명령 메뉴 헤더, 6: 알림/충돌.
const SEP: &str = "\u{1f}";

/// 인원 표시 비트 배치:
/// x(8) | y(8)<<8 | 인원(12)<<16 | EMPIRE(28) | SELECTED(29) | SPECIAL(30) | GARRISON(31)
pub const LABEL_EMPIRE: u32 = 1 << 28;
pub const LABEL_SELECTED: u32 = 1 << 29;
pub const LABEL_SPECIAL: u32 = 1 << 30;
pub const LABEL_GARRISON: u32 = 1 << 31;

/// 길 하나의 머리말: 칸 수 | 특수부대면 `ROUTE_SELECTED` | 한 칸 가는 틱 수<<20. 그 뒤로 칸마다 x | y<<8.
pub const ROUTE_SELECTED: u32 = 1 << 16;

struct State {
    world: World,
    frame: [u32; CELLS],
    text: String,
    popup: String,
    labels: Vec<u32>,
    routes: Vec<u32>,
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    unsafe {
        let slot = &mut *core::ptr::addr_of_mut!(STATE);
        slot.get_or_insert_with(|| State {
            world: World::new(0),
            frame: [0; CELLS],
            text: String::new(),
            popup: String::new(),
            labels: Vec::new(),
            routes: Vec::new(),
        })
    }
}

fn idx(p: Pos) -> usize {
    (p.1 * WW + p.0) as usize
}

fn side_color(side: Side) -> u32 {
    if side == Side::Brood { BROOD } else { EMPIRE }
}

fn side_name(side: Side) -> &'static str {
    if side == Side::Brood { "아군" } else { "인류" }
}

/// 4비트 연결 마스크(N=1, E=2, S=4, W=8)에 따른 Box-drawing 글리프.
fn road_glyph(mask: u8, double: bool) -> char {
    if double {
        match mask {
            0b0001 | 0b0100 | 0b0101 => '║',
            0b0010 | 0b1000 | 0b1010 => '═',
            0b0110 => '╔',
            0b1100 => '╗',
            0b0011 => '╚',
            0b1001 => '╝',
            0b0111 => '╠',
            0b1101 => '╣',
            0b1110 => '╦',
            0b1011 => '╩',
            0b1111 => '╬',
            _ => '═',
        }
    } else {
        match mask {
            0b0001 | 0b0100 | 0b0101 => '│',
            0b0010 | 0b1000 | 0b1010 => '─',
            0b0110 => '┌',
            0b1100 => '┐',
            0b0011 => '└',
            0b1001 => '┘',
            0b0111 => '├',
            0b1101 => '┤',
            0b1110 => '┬',
            0b1011 => '┴',
            0b1111 => '┼',
            _ => '·',
        }
    }
}

fn road_mask(w: &World, p: Pos) -> u8 {
    let mut m = 0u8;
    if w.walkable((p.0, p.1 - 1)) { m |= 1; }
    if w.walkable((p.0 + 1, p.1)) { m |= 2; }
    if w.walkable((p.0, p.1 + 1)) { m |= 4; }
    if w.walkable((p.0 - 1, p.1)) { m |= 8; }
    m
}

fn site_color(owner: Option<Side>, kind: SiteKind) -> u32 {
    match owner {
        Some(Side::Brood) => BROOD,
        Some(Side::Empire) => EMPIRE,
        None => match kind {
            SiteKind::Hq(s) => side_color(s),
            _ => FG,
        },
    }
}

fn format_eta(ticks: u32) -> String {
    let tenths = ((ticks * 10) + (TICKS_PER_DAY as u32 / 2)) / TICKS_PER_DAY as u32;
    let whole = tenths / 10;
    let frac = tenths % 10;
    if frac == 0 {
        format!("{whole}일")
    } else {
        format!("{whole}.{frac}일")
    }
}

fn progress_bar(pct: u32) -> String {
    let filled = ((pct.min(100) + 5) / 10) as usize;
    let mut s = String::with_capacity(12);
    s.push('[');
    for i in 0..10 {
        s.push(if i < filled { '■' } else { '·' });
    }
    s.push(']');
    s
}

fn render(s: &mut State) {
    let w = &s.world;
    // 1. 지형 바탕 + 8×8 구역 기준점(+) + Box-drawing 도로 + 거점
    for y in 0..WH {
        for x in 0..WW {
            let p = (x, y);
            s.frame[idx(p)] = match w.ground(p) {
                Ground::Wild => {
                    if x > 0 && y > 0 && x < WW - 1 && y < WH - 1 && x % 8 == 0 && y % 8 == 0 {
                        cell('+', DIM, BG)
                    } else {
                        cell(' ', DIM, BG)
                    }
                }
                Ground::Road => cell(road_glyph(road_mask(w, p), false), DIM, BG),
                Ground::Site(i) => {
                    let site = &w.sites[i];
                    cell(site.kind.glyph(), site_color(site.owner, site.kind), BG)
                }
            };
        }
    }

    // 2. 움직이는 아군 경로: 아군 AI 일반군은 BROOD_DIM 단선, 특수부대는 BROOD 이중선.
    s.routes.clear();
    let sp_idx = w.special_index();
    let mut moving: Vec<usize> = (0..w.forces.len())
        .filter(|&i| w.forces[i].alive && w.forces[i].side == Side::Brood)
        .collect();
    // 특수부대를 가장 나중에 그려 위에 덮이도록 한다.
    moving.sort_by_key(|&i| i == sp_idx);

    for &i in &moving {
        let Order::Move(path) = &w.forces[i].order else { continue };
        let is_special = i == sp_idx;
        let color = if is_special { BROOD } else { BROOD_DIM };
        for &p in path.iter().filter(|&&p| w.ground(p) == Ground::Road) {
            s.frame[idx(p)] = cell(road_glyph(road_mask(w, p), is_special), color, BG);
        }
        // 특수부대 이동 경로 위 하루 경계 눈금(1, 2, ...)
        if is_special {
            let step_t = w.forces[i].step_ticks().max(1);
            let mut acc = 0u32;
            let mut day_mark = 1u32;
            for &p in path {
                acc += step_t;
                if acc >= day_mark * TICKS_PER_DAY as u32 && day_mark <= 9 {
                    if w.ground(p) == Ground::Road {
                        let ch = char::from_digit(day_mark, 10).unwrap_or('+');
                        s.frame[idx(p)] = cell(ch, BG, BROOD);
                    }
                    day_mark += 1;
                }
            }
        }
        if let Some(&end) = path.last() {
            if w.ground(end) == Ground::Road {
                s.frame[idx(end)] = cell('◇', if is_special { BROOD } else { FG }, BG);
            }
        }
        s.routes.push(
            path.len() as u32
                | if is_special { ROUTE_SELECTED } else { 0 }
                | w.forces[i].step_ticks() << 20,
        );
        s.routes.extend(path.iter().map(|p| p.0 as u32 | (p.1 as u32) << 8));
    }

    // 3. 지휘망 제안 미리보기 또는 목적지 찍은 경로 미리보기
    let preview_target = w
        .target
        .or_else(|| w.preview_proposal.and_then(|pi| w.proposals.get(pi)).map(|p| p.target));
    if let Some(target) = preview_target {
        let sp = w.special();
        if let Some(path) = w.route(sp.pos, target) {
            let step_t = sp.step_ticks().max(1);
            let mut acc = 0u32;
            let mut day_mark = 1u32;
            for &p in &path {
                acc += step_t;
                if w.ground(p) == Ground::Road {
                    if acc >= day_mark * TICKS_PER_DAY as u32 && day_mark <= 9 {
                        let ch = char::from_digit(day_mark, 10).unwrap_or('+');
                        s.frame[idx(p)] = cell(ch, BG, BROOD);
                        day_mark += 1;
                    } else if p == target {
                        s.frame[idx(p)] = cell('◇', BG, BROOD);
                    } else {
                        s.frame[idx(p)] = cell(road_glyph(road_mask(w, p), true), BROOD, BG);
                    }
                }
            }
            if let Ground::Site(si) = w.ground(target) {
                s.frame[idx(target)] = cell(w.sites[si].kind.glyph(), BG, BROOD);
            }
        }
    }

    // 4. 부대 그리기 (거점 공존 규칙: 거점 위에서는 거점 글리프를 지우지 않고 색/반전으로 점유 표시)
    for (i, f) in w.forces.iter().enumerate() {
        if !f.alive {
            continue;
        }
        // 특수부대가 같은 칸에 있으면 일반 부대가 덮지 않게 건너뛴다.
        if i != sp_idx && w.forces[sp_idx].alive && w.forces[sp_idx].pos == f.pos {
            continue;
        }
        let is_special = i == sp_idx;
        let is_selected = w.selected == Some(i);
        match w.ground(f.pos) {
            Ground::Site(si) => {
                let g = w.sites[si].kind.glyph();
                if is_selected {
                    s.frame[idx(f.pos)] = cell(g, BG, BROOD);
                } else if is_special {
                    s.frame[idx(f.pos)] = cell(g, BROOD, BG);
                } else if f.side == Side::Empire {
                    s.frame[idx(f.pos)] = cell(g, EMPIRE, BG);
                }
            }
            _ => {
                let glyph = if is_special {
                    match (&f.order, f.duty) {
                        (Order::Hold, Duty::Ambush) => '∩',
                        (_, Duty::Scout(..)) => '◇',
                        _ => '◆',
                    }
                } else if f.side == Side::Brood {
                    '▪'
                } else {
                    '◆'
                };
                let color = if is_special {
                    BROOD
                } else if f.side == Side::Brood {
                    BROOD_DIM
                } else {
                    EMPIRE
                };
                s.frame[idx(f.pos)] = if is_selected { cell(glyph, BG, color) } else { cell(glyph, color, BG) };
            }
        }
    }

    // 충돌 지점 강조
    if let Some((_, foe)) = w.clash {
        let p = w.forces[foe].pos;
        s.frame[idx(p)] = cell('×', BG, EMPIRE);
    }

    // 5. 인원 라벨 패킹
    let mut order: Vec<usize> = (0..w.forces.len()).filter(|&i| w.forces[i].alive).collect();
    order.sort_by_key(|&i| (idx(w.forces[i].pos), i != sp_idx, i));
    s.labels = order
        .into_iter()
        .map(|i| {
            let f = &w.forces[i];
            let mut flags = 0u32;
            if f.side == Side::Empire { flags |= LABEL_EMPIRE; }
            if w.selected == Some(i) { flags |= LABEL_SELECTED; }
            if i == sp_idx { flags |= LABEL_SPECIAL; }
            if f.duty == Duty::Garrison && f.order == Order::Hold { flags |= LABEL_GARRISON; }
            f.pos.0 as u32 | (f.pos.1 as u32) << 8 | f.size.min(0xfff) << 16 | flags
        })
        .collect();

    // 6. 문구 구역 생성
    let (sup_used, sup_cap) = w.supply_summary();
    let header_desktop = format!(
        "D+{:02} │ 보급 {}/{} │ 생체질 {} │ 기초연구 {} {}%",
        w.day(),
        sup_used,
        sup_cap,
        w.biomass,
        progress_bar(w.research_pct),
        w.research_pct
    );
    let header_mobile = format!("D+{:02} │ 보급 {}/{} │ 연구 {}%", w.day(), sup_used, sup_cap, w.research_pct);

    let sp = w.special();
    let sp_loc = match w.ground(sp.pos) {
        Ground::Site(si) => format!("{} {}", w.sites[si].code, w.sites[si].kind.label()),
        _ => format!("{} 길 위", sector_label(sp.pos)),
    };
    let sup_tag = if w.special_in_supply() { "보급권 내" } else { "보급권 밖" };
    let sp_summary = format!(
        "특수부대 ({}명)\n위치  {} ({})\n상태  {}\n편성  ψ1  θ2  λ2  ν1",
        sp.size,
        sp_loc,
        sup_tag,
        doing(sp)
    );

    let proposals_text = w
        .proposals
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let tag = match i {
                0 => "권고",
                1 => "대안1",
                _ => "대안2",
            };
            format!("{tag}\t{}\t{}\t{}\t{}\t{}", p.title, p.reason, format_eta(p.eta_ticks), p.target.0, p.target.1)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let events_text = w
        .events
        .iter()
        .map(|e| format!("D+{:02}\t{}\t{}\t{}\t{}", e.day, e.pos.0, e.pos.1, if e.alert { 1 } else { 0 }, e.text))
        .collect::<Vec<_>>()
        .join("\n");

    let menu_header = match (w.selected, w.target) {
        (Some(sel), Some(t)) => {
            let loc = match w.ground(t) {
                Ground::Site(si) => format!("{} {}", w.sites[si].code, w.sites[si].kind.label()),
                _ => format!("{} 길목", sector_label(t)),
            };
            if let Some(path) = w.route(w.forces[sel].pos, t) {
                let ticks = path.len() as u32 * w.forces[sel].step_ticks();
                let arr_day = (w.tick + ticks as u64) / TICKS_PER_DAY;
                format!("{loc} · {}칸 · {} (D+{arr_day})", path.len(), format_eta(ticks))
            } else {
                loc
            }
        }
        _ => String::new(),
    };

    let notice = match w.clash {
        Some((a, b)) => format!("충돌  특수부대 {}명 대 제국 {}명  (전투 진입 대기)", w.forces[a].size, w.forces[b].size),
        None => String::new(),
    };

    s.text = [header_desktop, header_mobile, sp_summary, proposals_text, events_text, menu_header, notice].join(SEP);
}

fn sector_label(p: Pos) -> String {
    let col = (p.0 / 8).clamp(0, SECTOR_COLS - 1);
    let row = (p.1 / 8).clamp(0, SECTOR_ROWS - 1);
    format!("{}{}", (b'A' + col as u8) as char, row + 1)
}

fn doing(f: &sim::world::Force) -> String {
    match (&f.order, f.duty) {
        (_, Duty::Scout(..)) => "정찰 중".to_string(),
        (Order::Hold, Duty::Ambush) => "매복 중".to_string(),
        (Order::Hold, Duty::Garrison) => "주둔 중".to_string(),
        (Order::Hold, Duty::None) => "대기".to_string(),
        (Order::Move(path), duty) => {
            let ticks = path.len() as u32 * f.step_ticks();
            let verb = match duty {
                Duty::Ambush => "매복 이동",
                Duty::Garrison => "주둔 이동",
                _ => "이동 중",
            };
            format!("{verb} · 잔여 {}칸 ({})", path.len(), format_eta(ticks))
        }
    }
}

fn inspect_text(w: &World, p: Pos) -> String {
    let mut lines = Vec::new();
    if let Ground::Site(i) = w.ground(p) {
        let s = &w.sites[i];
        let own = match s.owner {
            Some(Side::Brood) => "아군",
            Some(Side::Empire) => "제국",
            None => "중립",
        };
        lines.push(format!("{} {} {} [{}]", s.kind.glyph(), s.code, s.kind.label(), own));
    }
    for i in w.forces_at(p) {
        let f = &w.forces[i];
        match f.role {
            ForceRole::Special => lines.push(format!("◆ 특수부대 {}명  {}", f.size, doing(f))),
            ForceRole::BroodAi => lines.push(format!("▪ 아군 일반군 {}명  {}", f.size, doing(f))),
            ForceRole::EmpireConvoy => lines.push(format!("◆ 제국 보급대 {}명", f.size)),
            ForceRole::EmpirePatrol => lines.push(format!("◆ 제국 순찰대 {}명", f.size)),
            ForceRole::EmpireGarrison => lines.push(format!("◆ {} 주둔군 {}명", side_name(f.side), f.size)),
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

#[no_mangle]
pub extern "C" fn w_select_special() -> u32 {
    let s = state();
    let changed = s.world.select_special();
    render(s);
    changed as u32
}

/// 특수부대 좌표와 선택 상태: x | y<<8 | (selected<<16).
#[no_mangle]
pub extern "C" fn w_special_pos() -> u32 {
    let w = &state().world;
    let sp = w.special();
    let sel = if w.selected == Some(w.special_index()) { 1 } else { 0 };
    sp.pos.0 as u32 | (sp.pos.1 as u32) << 8 | (sel << 16)
}

#[no_mangle]
pub extern "C" fn w_preview_proposal(idx: i32) {
    let s = state();
    s.world.preview_proposal = if idx >= 0 && (idx as usize) < s.world.proposals.len() {
        Some(idx as usize)
    } else {
        None
    };
    render(s);
}

#[no_mangle]
pub extern "C" fn w_accept_proposal(idx: u32) -> u32 {
    let s = state();
    let ok = s.world.accept_proposal(idx as usize);
    render(s);
    ok as u32
}

/// 고른 특수부대에 명령을 내린다. 0 이동, 1 매복, 2 주둔, 3 정찰. 들어갔으면 1.
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

#[no_mangle]
pub extern "C" fn w_menu() -> u32 {
    let w = &state().world;
    match (w.selected, w.target) {
        (Some(_), Some(t)) => 1 | (w.can_garrison() as u32) << 1 | (t.0 as u32) << 8 | (t.1 as u32) << 16,
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn w_tick(n: u32) -> u32 {
    let s = state();
    let before = s.world.tick;
    for _ in 0..n {
        s.world.tick();
        if s.world.clash.is_some() {
            break;
        }
    }
    render(s);
    (s.world.tick - before) as u32
}

#[no_mangle]
pub extern "C" fn w_stop_reason() -> u32 {
    match state().world.stop_reason {
        StopReason::None => 0,
        StopReason::Clash => 1,
        StopReason::Arrived => 2,
        StopReason::Alert => 3,
    }
}

#[no_mangle]
pub extern "C" fn w_ticks_left_today() -> u32 {
    let t = state().world.tick;
    (TICKS_PER_DAY - t % TICKS_PER_DAY) as u32
}

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

/// 화면 확인용 (examples/wdump.rs).
#[doc(hidden)]
pub fn dump(seed: u32, clicks: &[Pos], ticks: u32) -> String {
    w_init(seed);
    for &(x, y) in clicks {
        if x < 0 {
            w_command(y as u32);
        } else {
            w_click(x, y);
        }
    }
    w_tick(ticks);
    let s = state();
    format!(
        "{{\"frame\":{:?},\"labels\":{:?},\"routes\":{:?},\"menu\":{},\"text\":{:?}}}",
        s.frame.to_vec(),
        s.labels,
        s.routes,
        w_menu(),
        s.text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_screen_large_theater() {
        w_init(3);
        let s = state();
        let home = s.world.special().pos;
        assert!(s.text.starts_with("D+00"));
        assert_eq!(w_ticks_left_today(), 24);
        // 거점 공존: 본진 위에 특수부대가 있어도 ◉가 유지된다.
        assert_eq!(s.frame[idx(home)], cell('◉', BROOD, BG));
        assert!(s.labels.iter().any(|&l| l & LABEL_SPECIAL != 0));
        assert_eq!(s.world.proposals.len(), 3);

        // 비선택 상태에서 다른 거점을 찍으면 명령 메뉴가 열리지 않는다.
        let dest = s.world.sites.iter().find(|x| x.pos != home).unwrap().pos;
        assert_eq!(w_click(dest.0, dest.1), 0);
        assert_eq!(w_menu(), 0);

        // 특수부대 클릭 후 거점을 찍으면 명령 메뉴와 ETA가 뜬다.
        assert_eq!(w_click(home.0, home.1), 1);
        assert_eq!(w_click(dest.0, dest.1), 1);
        assert_ne!(w_menu(), 0);
        assert_eq!(w_command(2), 1);
        assert_eq!(w_menu(), 0);

        // 제안 수락 및 시간 진행
        assert_eq!(w_accept_proposal(0), 1);
        assert_eq!(w_tick(24), 24);
        assert!(state().text.starts_with("D+01"));
    }
}
