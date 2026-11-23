//! 80×52 육각(Hex) 월드 화면의 WASM 경계.
//! 헥스 속성 배열, 이동 경로(하루 눈금 포함), 인원 라벨, 구조화 문구를 만들어 넘긴다.

use sim::world::{
    hex_neighbors, idx, in_world, sector_code, Command, Duty, ForceRole, Order,
    StopReason, World, HEX_COUNT, MAX_SQUAD, RECRUIT_COST, REGENE_COST, TICKS_PER_DAY, WH, WW,
};
use sim::{Gene, Pos, Side};

/// 문구 구역 구분자.
/// 0: 데스크탑 상단 바, 1: 모바일 상단 바, 2: 특수부대 요약,
/// 3: 지휘망 제안 목록, 4: 전선 사건 로그, 5: 명령 메뉴 헤더, 6: 알림/충돌,
/// 7: 특수부대 대원 명부(정비용), 8: 정비 상태 메타.
const SEP: &str = "\u{1f}";

/// 인원 표시 비트 배치:
/// q(8) | r(8)<<8 | 인원(12)<<16 | EMPIRE(28) | SELECTED(29) | SPECIAL(30) | GARRISON(31)
pub const LABEL_EMPIRE: u32 = 1 << 28;
pub const LABEL_SELECTED: u32 = 1 << 29;
pub const LABEL_SPECIAL: u32 = 1 << 30;
pub const LABEL_GARRISON: u32 = 1 << 31;

/// 경로 머리말 플래그:
/// len(16) | ROUTE_SPECIAL(16) | ROUTE_PREVIEW(17) | avg_step_ticks(12)<<20
/// 그 뒤로 `len + 1`개의 노드(출발 헥스 포함): `q(8) | r(8)<<8 | day_mark(8)<<16`.
pub const ROUTE_SPECIAL: u32 = 1 << 16;
pub const ROUTE_PREVIEW: u32 = 1 << 17;

struct State {
    world: World,
    /// 각 헥스의 비트 패킹 상태 (길이 `WW * WH`).
    hexes: Vec<u32>,
    text: String,
    popup: String,
    labels: Vec<u32>,
    routes: Vec<u32>,
    last_battle: [u32; 4],
    /// 선택 중 마우스 호버 또는 웨이포인트 드래그로 가리키는 헥스 (시뮬 상태에는 영향 없음).
    hover_hex: Option<Pos>,
    /// 드래그 중일 때는 기존 target보다 hover_hex 경로 미리보기를 우선 표시한다.
    hover_override: bool,
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    unsafe {
        let slot = &mut *core::ptr::addr_of_mut!(STATE);
        slot.get_or_insert_with(|| State {
            world: World::new(0),
            hexes: vec![0; HEX_COUNT],
            text: String::new(),
            popup: String::new(),
            labels: Vec::new(),
            routes: Vec::new(),
            last_battle: [0; 4],
            hover_hex: None,
            hover_override: false,
        })
    }
}

fn side_code(s: Option<Side>) -> u32 {
    match s {
        None => 0,
        Some(Side::Brood) => 1,
        Some(Side::Empire) => 2,
    }
}

fn side_name(side: Side) -> &'static str {
    if side == Side::Brood { "아군" } else { "인류" }
}

fn format_eta(ticks: u32) -> String {
    let tenths = ((ticks * 10) + (TICKS_PER_DAY as u32 / 2)) / TICKS_PER_DAY as u32;
    let whole = tenths / 10;
    let frac = tenths % 10;
    if frac == 0 { format!("{whole}일") } else { format!("{whole}.{frac}일") }
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

fn push_route(out: &mut Vec<u32>, w: &World, role: ForceRole, size: u32, start: Pos, path: &[Pos], flags: u32) {
    if path.is_empty() {
        return;
    }
    let total_ticks = w.path_ticks(role, size, path);
    let avg = (total_ticks / path.len() as u32).clamp(2, 30);
    out.push((path.len() as u32) | flags | (avg << 20));
    out.push(start.0 as u32 | ((start.1 as u32) << 8));
    let show_days = (flags & (ROUTE_SPECIAL | ROUTE_PREVIEW)) != 0;
    let mut acc = 0u32;
    let mut day_mark = 1u32;
    for &p in path {
        let mut mark = 0u32;
        if show_days {
            acc += w.hex_step_ticks(role, size, p);
            if acc >= day_mark * TICKS_PER_DAY as u32 && day_mark <= 9 {
                mark = day_mark;
                day_mark += 1;
            }
        }
        out.push(p.0 as u32 | ((p.1 as u32) << 8) | (mark << 16));
    }
}

fn render(s: &mut State) {
    let w = &s.world;
    if s.hexes.len() != HEX_COUNT {
        s.hexes.resize(HEX_COUNT, 0);
    }

    // 1. 헥스 지형 + 도로 연결 마스크 + Civ 영토 경계 마스크 패킹
    for r in 0..WH {
        for q in 0..WW {
            let p = (q, r);
            let i = idx(p);
            let tcode = w.terrain[i].code();
            let has_road = w.road[i];
            let terr = w.territory[i];
            let (skind, sowner) = match w.site_at[i] {
                Some(si) => (w.sites[si].kind.code(), side_code(w.sites[si].owner)),
                None => (0, 0),
            };
            let in_sup = if w.brood_supply[i] { 1u32 } else { 0 };

            let mut road_mask = 0u32;
            let mut border_mask = 0u32;
            let nbs = hex_neighbors(p);
            for (d, np) in nbs.into_iter().enumerate() {
                if in_world(np) {
                    let ni = idx(np);
                    if has_road && w.road[ni] {
                        road_mask |= 1 << d;
                    }
                    if terr.is_some() && w.territory[ni] != terr {
                        border_mask |= 1 << d;
                    }
                } else if terr.is_some() {
                    border_mask |= 1 << d;
                }
            }

            s.hexes[i] = tcode
                | ((has_road as u32) << 3)
                | (side_code(terr) << 4)
                | (skind << 6)
                | (sowner << 10)
                | (in_sup << 12)
                | (road_mask << 13)
                | (border_mask << 19);
        }
    }

    // 2. 부대 마커 (특수부대가 우선 표시되도록 마지막에 덮는다)
    let sp_idx = w.special_index();
    for (i, f) in w.forces.iter().enumerate() {
        if !f.alive || i == sp_idx {
            continue;
        }
        let marker = if f.side == Side::Brood { 4u32 } else { 5u32 };
        let hi = idx(f.pos);
        s.hexes[hi] = (s.hexes[hi] & !(0b111 << 25)) | (marker << 25);
    }
    if w.forces[sp_idx].alive {
        let sp = &w.forces[sp_idx];
        let marker = match (&sp.order, sp.duty) {
            (Order::Hold, Duty::Ambush) => 2u32,
            (_, Duty::Scout(..)) => 3u32,
            _ => 1u32,
        };
        let hi = idx(sp.pos);
        let sel = if w.selected == Some(sp_idx) { 1u32 << 28 } else { 0 };
        s.hexes[hi] = (s.hexes[hi] & !(0b111 << 25)) | (marker << 25) | sel;
    }
    if let Some(t) = w.target {
        s.hexes[idx(t)] |= 1 << 29;
    }
    if let Some((_, foe)) = w.clash {
        let hi = idx(w.forces[foe].pos);
        s.hexes[hi] = (s.hexes[hi] & !(0b111 << 25)) | (6 << 25);
    }

    // 3. 이동 경로 & 미리보기 경로 패킹
    s.routes.clear();
    for (i, f) in w.forces.iter().enumerate() {
        if !f.alive || f.side != Side::Brood {
            continue;
        }
        if let Order::Move(path) = &f.order {
            let flags = if i == sp_idx { ROUTE_SPECIAL } else { 0 };
            push_route(&mut s.routes, w, f.role, f.size, f.pos, path, flags);
        }
    }
    let hover_preview = if w.selected.is_some() {
        s.hover_hex.filter(|&p| p != w.special().pos && w.walkable(p))
    } else {
        None
    };
    let preview_target = if s.hover_override {
        hover_preview.or(w.target)
    } else {
        w.target
            .or(hover_preview)
            .or_else(|| w.preview_proposal.and_then(|pi| w.proposals.get(pi)).map(|p| p.target))
    };
    if let Some(target) = preview_target {
        let sp = w.special();
        if let Some(path) = w.route(sp.pos, target) {
            push_route(&mut s.routes, w, ForceRole::Special, sp.size, sp.pos, &path, ROUTE_PREVIEW);
        }
    }

    // 4. 인원 라벨 패킹
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
            f.pos.0 as u32 | ((f.pos.1 as u32) << 8) | (f.size.min(0xfff) << 16) | flags
        })
        .collect();

    // 5. 문구 구역 생성
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
    let sp_loc = match w.site_index_at(sp.pos) {
        Some(si) => format!("{} {}", w.sites[si].code, w.sites[si].kind.label()),
        None => format!("{} {}", sector_code(sp.pos), w.terrain_at(sp.pos).label()),
    };
    let in_sup = w.special_in_supply();
    let sup_tag = if in_sup { "보급권 내" } else { "보급권 밖" };
    let [n_sn, n_bu, n_br, n_pl] = w.squad_counts();
    let (missing_hp, heal_cost) = w.heal_needed();
    let hp_tag = if missing_hp > 0 { format!(" · 부상 −{missing_hp}") } else { String::new() };
    let sp_summary = format!(
        "특수부대 ({}/{}명{})\n위치  {} ({})\n상태  {}\n편성  ψ{}  θ{}  λ{}  ν{}",
        w.squad.len(),
        MAX_SQUAD,
        hp_tag,
        sp_loc,
        sup_tag,
        doing(w, sp),
        n_sn,
        n_bu,
        n_br,
        n_pl
    );

    let proposals_text = w
        .proposals
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let tag = match i { 0 => "권고", 1 => "대안1", _ => "대안2" };
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
            let loc = match w.site_index_at(t) {
                Some(si) => format!("{} {}", w.sites[si].code, w.sites[si].kind.label()),
                None => format!(
                    "{} {}{}",
                    sector_code(t),
                    w.terrain_at(t).label(),
                    if w.has_road(t) { "·도로" } else { "" }
                ),
            };
            let f = &w.forces[sel];
            if let Some((path, ticks)) = w.route_for(f.role, f.size, f.pos, t) {
                let arr_day = (w.tick + ticks as u64) / TICKS_PER_DAY;
                format!("{loc} · {}헥스 · {} (D+{arr_day})", path.len(), format_eta(ticks))
            } else {
                loc
            }
        }
        _ => String::new(),
    };

    let notice = if let Some(v) = w.victory {
        if v == Side::Brood { "전구 승리 — 인류 본진 점령 완료".to_string() } else { "작전 실패 — 특수부대 전멸".to_string() }
    } else if let Some(cfg) = w.battle_config() {
        let tags = if cfg.tags.is_empty() { String::new() } else { format!(" [{}]", cfg.tags.join(" · ")) };
        format!("조우: {} ({} 대 {}){tags}", cfg.title, w.squad.len(), cfg.empire.len())
    } else {
        String::new()
    };

    let squad_rows = w
        .squad
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let pips: String = (0..t.max_hp).map(|k| if k < t.hp { '●' } else { '○' }).collect();
            let gid = match t.gene { Gene::Plain => 0, Gene::Sniper => 1, Gene::Burst => 2, Gene::Burrow => 3 };
            format!("{i}\t{}\t{}\t{pips}\t{}/{}\t{}\t{gid}", t.glyph(), t.name(), t.hp, t.max_hp, t.battles)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let can_recruit = if in_sup && w.clash.is_none() && w.squad.len() < MAX_SQUAD && w.biomass >= RECRUIT_COST { 1 } else { 0 };
    let refit_meta = format!(
        "{}\t{}\t{}\t{}\t{}\t{}\t{}",
        if in_sup && w.clash.is_none() { 1 } else { 0 },
        w.biomass,
        missing_hp,
        heal_cost,
        can_recruit,
        RECRUIT_COST,
        REGENE_COST
    );

    s.text = [
        header_desktop,
        header_mobile,
        sp_summary,
        proposals_text,
        events_text,
        menu_header,
        notice,
        squad_rows,
        refit_meta,
    ]
    .join(SEP);
}

fn doing(w: &World, f: &sim::world::Force) -> String {
    match (&f.order, f.duty) {
        (_, Duty::Scout(..)) => "정찰 중".to_string(),
        (Order::Hold, Duty::Ambush) => "매복 중".to_string(),
        (Order::Hold, Duty::Garrison) => "주둔 중".to_string(),
        (Order::Hold, Duty::None) => "대기".to_string(),
        (Order::Move(path), duty) => {
            let ticks = w.path_ticks(f.role, f.size, path);
            let verb = match duty {
                Duty::Ambush => "매복 이동",
                Duty::Garrison => "주둔 이동",
                _ => "이동 중",
            };
            format!("{verb} · {}헥스 ({})", path.len(), format_eta(ticks))
        }
    }
}

fn inspect_text(w: &World, p: Pos) -> String {
    let mut lines = Vec::new();
    let terr = w.terrain_at(p);
    let road_tag = if w.has_road(p) { " · 도로" } else { "" };
    let own_tag = match w.territory[idx(p)] {
        Some(Side::Brood) => " · 아군 영역",
        Some(Side::Empire) => " · 제국 영역",
        None => "",
    };
    let sup_tag = if w.brood_supply[idx(p)] { " · 보급" } else { "" };
    lines.push(format!("{} {}{road_tag}{own_tag}{sup_tag}", sector_code(p), terr.label()));

    if let Some(si) = w.site_index_at(p) {
        let s = &w.sites[si];
        let own = match s.owner { Some(Side::Brood) => "아군", Some(Side::Empire) => "제국", None => "중립" };
        lines.push(format!("{} {} {} [{own}]", s.kind.glyph(), s.code, s.kind.label()));
    }
    for i in w.forces_at(p) {
        let f = &w.forces[i];
        match f.role {
            ForceRole::Special => lines.push(format!("◆ 특수부대 {}명  {}", f.size, doing(w, f))),
            ForceRole::BroodAi => lines.push(format!("▪ 아군 일반군 {}명  {}", f.size, doing(w, f))),
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
    s.hover_hex = None;
    s.hover_override = false;
    render(s);
}

#[no_mangle]
pub extern "C" fn w_click(x: i32, y: i32) -> u32 {
    let s = state();
    let changed = s.world.click((x, y));
    s.hover_override = false;
    render(s);
    changed as u32
}

/// 마우스 호버 또는 웨이포인트 드래그 중 실시간 경로 미리보기 갱신 (시뮬 상태 불변).
#[no_mangle]
pub extern "C" fn w_hover(x: i32, y: i32, override_target: u32) {
    let s = state();
    let next = if in_world((x, y)) { Some((x, y)) } else { None };
    let ov = override_target != 0;
    if s.hover_hex == next && s.hover_override == ov {
        return;
    }
    s.hover_hex = next;
    s.hover_override = ov;
    render(s);
}

#[no_mangle]
pub extern "C" fn w_select_special() -> u32 {
    let s = state();
    let changed = s.world.select_special();
    s.hover_override = false;
    render(s);
    changed as u32
}

#[no_mangle]
pub extern "C" fn w_special_pos() -> u32 {
    let w = &state().world;
    let sp = w.special();
    let sel = if w.selected == Some(w.special_index()) { 1 } else { 0 };
    sp.pos.0 as u32 | ((sp.pos.1 as u32) << 8) | (sel << 16)
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
        (Some(_), Some(t)) => 1 | ((w.can_garrison() as u32) << 1) | ((t.0 as u32) << 8) | ((t.1 as u32) << 16),
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn w_tick(n: u32) -> u32 {
    let s = state();
    let before = s.world.tick;
    for _ in 0..n {
        s.world.tick();
        if s.world.clash.is_some() || s.world.victory.is_some() {
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
    (state().world.clash.is_some() || state().world.victory.is_some()) as u32
}

#[no_mangle]
pub extern "C" fn w_has_clash() -> u32 {
    state().world.clash.is_some() as u32
}

#[no_mangle]
pub extern "C" fn w_victory() -> u32 {
    match state().world.victory {
        None => 0,
        Some(Side::Brood) => 1,
        Some(Side::Empire) => 2,
    }
}

#[no_mangle]
pub extern "C" fn w_in_supply() -> u32 {
    let w = &state().world;
    (w.clash.is_none() && w.victory.is_none() && w.special_in_supply()) as u32
}

#[no_mangle]
pub extern "C" fn w_heal_squad() -> u32 {
    let s = state();
    let ok = s.world.heal_squad();
    render(s);
    ok as u32
}

#[no_mangle]
pub extern "C" fn w_regene(idx: u32, gene: u32) -> u32 {
    let g = match gene {
        0 => Gene::Plain,
        1 => Gene::Sniper,
        2 => Gene::Burst,
        3 => Gene::Burrow,
        _ => return 0,
    };
    let s = state();
    let ok = s.world.regene_trooper(idx as usize, g);
    render(s);
    ok as u32
}

#[no_mangle]
pub extern "C" fn w_recruit() -> u32 {
    let s = state();
    let ok = s.world.recruit_trooper();
    render(s);
    ok as u32
}

#[no_mangle]
pub extern "C" fn w_enter_battle() -> u32 {
    let cfg = {
        let s = state();
        match s.world.battle_config() {
            Some(c) => c,
            None => return 0,
        }
    };
    crate::start_world_battle(&cfg);
    1
}

#[no_mangle]
pub extern "C" fn w_finish_battle() -> u32 {
    let Some((won, allied_losses, empire_losses, packed_hp)) = crate::extract_world_battle_result() else {
        return 0;
    };
    let s = state();
    s.last_battle = [won as u32, allied_losses, empire_losses, packed_hp];
    let ok = s.world.resolve_battle(won, allied_losses, empire_losses, packed_hp);
    render(s);
    ok as u32
}

#[no_mangle]
pub extern "C" fn w_last_battle_word(k: u32) -> u32 {
    state().last_battle.get(k as usize).copied().unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn w_apply_battle(won: u32, allied_losses: u32, empire_losses: u32, packed_hp: u32) -> u32 {
    let s = state();
    let ok = s.world.resolve_battle(won != 0, allied_losses, empire_losses, packed_hp);
    render(s);
    ok as u32
}

#[no_mangle]
pub extern "C" fn w_cols() -> i32 {
    WW
}

#[no_mangle]
pub extern "C" fn w_rows() -> i32 {
    WH
}

/// 80×52 헥스 속성 버퍼 포인터.
#[no_mangle]
pub extern "C" fn w_hex_ptr() -> *const u32 {
    state().hexes.as_ptr()
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
        "{{\"hexes\":{:?},\"labels\":{:?},\"routes\":{:?},\"menu\":{},\"text\":{:?}}}",
        s.hexes, s.labels, s.routes, w_menu(), s.text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_world_screen_80x52() {
        let _guard = crate::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        w_init(3);
        let s = state();
        let home = s.world.special().pos;
        assert!(s.text.starts_with("D+00"));
        assert_eq!(w_cols(), 80);
        assert_eq!(w_rows(), 52);
        assert_eq!(s.hexes.len(), 80 * 52);
        assert_eq!(w_in_supply(), 1);
        // 본진 헥스에 거점 코드(1)와 특수부대 마커(1)가 공존한다.
        let h = s.hexes[idx(home)];
        assert_eq!((h >> 6) & 0xf, 1);
        assert_eq!((h >> 25) & 0x7, 1);

        // 보급권 내 개조·충원
        assert_eq!(w_regene(5, 1), 1);
        assert_eq!(w_recruit(), 1);
        assert_eq!(state().world.squad.len(), 7);

        // 비선택 클릭은 명령을 열지 않는다.
        let dest = state().world.sites.iter().find(|x| x.pos != home).unwrap().pos;
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

    #[test]
    fn world_clash_enters_battle_and_persists_casualties() {
        let _guard = crate::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        w_init(5);
        let enemy_idx = state().world.forces.iter().position(|f| f.alive && f.side == Side::Empire).unwrap();
        state().world.clash = Some((0, enemy_idx));
        assert_eq!(w_has_clash(), 1);
        assert_eq!(w_enter_battle(), 1);

        let packed = (3 << 4) | (5 << 8) | (5 << 12) | (5 << 16) | (5 << 20);
        assert_eq!(w_apply_battle(1, 0, 5, packed), 1);
        assert_eq!(w_has_clash(), 0);
        assert_eq!(state().world.squad.len(), 5);
        assert_eq!(state().world.squad[0].hp, 3);
        assert_eq!(state().world.squad[0].battles, 1);
    }

    #[test]
    fn joint_battle_and_retreat_preserves_veterans() {
        let cfg = sim::BattleConfig {
            seed: 42,
            special: vec![(0, Gene::Sniper, 4), (1, Gene::Burrow, 5)],
            allied_ai: 2,
            empire: vec![sim::Class::Trooper, sim::Class::Trooper, sim::Class::Relay],
            ambush: true,
            garrison: false,
            relay_cut: true,
            biome: sim::BattleBiome::Forest,
            title: "테스트 교전".to_string(),
            tags: vec!["기습".to_string()],
        };
        let mut g = sim::Game::from_battle(&cfg);
        assert!(g.units.iter().all(|u| u.class != sim::Class::Relay));
        let ai_pos = g.units.iter().find(|u| u.ai_controlled).unwrap().pos;
        assert!(!g.click(ai_pos));
        assert!(g.units[1].burrowed);
        g.end_turn();
        assert_eq!(g.round, 2);

        for i in 0..2 {
            let y = g.units[i].pos.1;
            assert!(g.click(g.units[i].pos));
            assert!(g.click((0, y)));
            assert!(g.can_retreat());
            assert!(g.retreat());
        }
        assert_eq!(g.outcome, Some(Side::Empire));
        assert!(g.units[0].retreated && g.units[0].hp > 0);
        assert!(g.units[1].retreated && g.units[1].hp > 0);
    }
}
