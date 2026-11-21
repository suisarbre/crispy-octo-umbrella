//! 월드. 대규모 전구 위에서 자율 아군 AI와 제국 AI가 맞붙고,
//! 플레이어는 단 하나의 정예 특수부대를 직접 통제해 전황을 뒤집는다.
//! 전투와 마찬가지로 결정론적이다. 상태를 바꾸는 입구는 `click`, `select_special`,
//! `command`, `accept_proposal`, `tick`뿐이라서 (시드, 입력과 틱의 순서)만 있으면 그대로 재현된다.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::rng::Rng;
use crate::{Pos, Side};

pub const WW: i32 = 88;
pub const WH: i32 = 48;
/// 하루는 이만큼의 틱이다. 한 턴이 하루다.
pub const TICKS_PER_DAY: u64 = 24;
/// 거점 배치 격자 크기. 11×6 = 66칸 중 45~56개에 거점을 놓는다.
const CELL: i32 = 8;
pub const SECTOR_COLS: i32 = WW / CELL;
pub const SECTOR_ROWS: i32 = WH / CELL;
/// 한 칸을 가는 데 드는 틱: 기본값에 인원이 많을수록 더.
const STEP_TICKS: u32 = 3;
const TICKS_PER_HEAD: u32 = 4;
const MAX_EVENTS: usize = 12;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ground {
    /// 길이 아닌 곳. 못 간다.
    Wild,
    Road,
    /// 거점. `World::sites`의 번호.
    Site(usize),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SiteKind {
    /// 그 진영의 본진.
    Hq(Side),
    /// 아군 전진 기지 (보급 거점).
    Fob,
    /// 은신처 (본진 이전 후보).
    Hideout,
    /// 좁은 길목 / 일반 거점.
    Choke,
    /// 생체질 자원지.
    Resource,
    /// 고지 (넓은 시야).
    Ridge,
    /// 제국 전초.
    Outpost,
    /// 제국 중계탑.
    Relay,
    /// 제국 착륙장.
    Landing,
}

impl SiteKind {
    pub fn label(self) -> &'static str {
        match self {
            SiteKind::Hq(Side::Brood) => "아군 본진",
            SiteKind::Hq(Side::Empire) => "인류 본진",
            SiteKind::Fob => "전진 기지",
            SiteKind::Hideout => "은신처",
            SiteKind::Choke => "길목",
            SiteKind::Resource => "자원지",
            SiteKind::Ridge => "고지",
            SiteKind::Outpost => "제국 전초",
            SiteKind::Relay => "중계탑",
            SiteKind::Landing => "착륙장",
        }
    }

    pub fn glyph(self) -> char {
        match self {
            SiteKind::Hq(_) => '◉',
            SiteKind::Fob => '◎',
            SiteKind::Hideout => '◌',
            SiteKind::Choke => '○',
            SiteKind::Resource => '◈',
            SiteKind::Ridge => '△',
            SiteKind::Outpost => '▣',
            SiteKind::Relay => '┴',
            SiteKind::Landing => '⊞',
        }
    }
}

#[derive(Clone, Debug)]
pub struct Site {
    pub pos: Pos,
    pub kind: SiteKind,
    pub owner: Option<Side>,
    pub code: String,
    pub col: i32,
    pub row: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ForceRole {
    /// 플레이어가 직접 조종하는 유일한 정예 특수부대.
    Special,
    /// 완전 자율 아군 일반군.
    BroodAi,
    /// 제국 주둔/수비대.
    EmpireGarrison,
    /// 제국 순찰대.
    EmpirePatrol,
    /// 제국 보급대.
    EmpireConvoy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Order {
    Hold,
    /// 남은 길. 앞에서부터 한 칸씩 간다.
    Move(Vec<Pos>),
}

/// 부대가 맡은 일. 도착한 뒤에 무엇을 하는가.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Duty {
    None,
    /// 도착하면 숨어서 기다린다.
    Ambush,
    /// 도착하면 거점을 지킨다.
    Garrison,
    /// 두 자리 사이를 오간다.
    Scout(Pos, Pos),
}

/// 플레이어가 고르는 명령. 찍은 칸으로 가서 무엇을 할지.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    Move,
    Ambush,
    /// 거점에만 내릴 수 있다.
    Garrison,
    /// 지금 자리와 찍은 자리를 오간다.
    Scout,
}

#[derive(Clone, Debug)]
pub struct Force {
    pub side: Side,
    pub role: ForceRole,
    pub pos: Pos,
    /// 인원. 많을수록 느리다.
    pub size: u32,
    pub order: Order,
    pub duty: Duty,
    /// 다음 칸까지 쌓인 틱.
    pub progress: u32,
    pub alive: bool,
}

impl Force {
    /// 한 칸을 가는 데 드는 틱. 특수부대는 기동성이 높다.
    pub fn step_ticks(&self) -> u32 {
        let base = if self.role == ForceRole::Special { STEP_TICKS } else { STEP_TICKS + 1 };
        base + self.size / TICKS_PER_HEAD
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProposalAxis {
    Offense,
    Defense,
    Disrupt,
}

#[derive(Clone, Debug)]
pub struct Proposal {
    pub axis: ProposalAxis,
    pub target: Pos,
    pub site: Option<usize>,
    pub command: Command,
    pub title: String,
    pub reason: String,
    pub eta_ticks: u32,
}

#[derive(Clone, Debug)]
pub struct WorldEvent {
    pub day: u64,
    pub pos: Pos,
    pub text: String,
    pub alert: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StopReason {
    None,
    Clash,
    Arrived,
    Alert,
}

#[derive(Clone, Debug)]
pub struct World {
    pub seed: u64,
    pub ground: Vec<Ground>,
    pub sites: Vec<Site>,
    pub forces: Vec<Force>,
    pub tick: u64,
    /// 특수부대가 선택되어 있는가. 비선택 시 클릭은 지도 조사에 쓴다.
    pub selected: Option<usize>,
    /// 특수부대를 보내려고 찍어 둔 칸. 명령을 고르면 들어가고, 그 전까지는 아무 일도 없다.
    pub target: Option<Pos>,
    /// 지휘망 제안 미리보기 번호.
    pub preview_proposal: Option<usize>,
    /// 특수부대가 마주친 충돌 `(특수부대, 적 부대)`. 생기면 시간이 멈춘다.
    pub clash: Option<(usize, usize)>,
    /// 자동 진행이 멈춘 이유.
    pub stop_reason: StopReason,
    /// 지휘망 작전 제안: `[0]` 주 권고, `[1]` 대안1, `[2]` 대안2.
    pub proposals: Vec<Proposal>,
    /// 최근 전선 사건 (최신순).
    pub events: Vec<WorldEvent>,
    /// 자원 및 거시 지표.
    pub biomass: u32,
    pub research_pct: u32,
    /// 결정론적 난수 상태 (AI 및 모의전용).
    rng: Rng,
}

fn idx(p: Pos) -> usize {
    (p.1 * WW + p.0) as usize
}

pub fn in_world(p: Pos) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < WW && p.1 < WH
}

fn manhattan(a: Pos, b: Pos) -> i32 {
    (a.0 - b.0).abs() + (a.1 - b.1).abs()
}

fn sector_code(col: i32, row: i32) -> String {
    let ch = (b'A' + col.clamp(0, 25) as u8) as char;
    format!("{ch}{}", row + 1)
}

/// `(x, y)`를 길로 칠했을 때 2×2 블록(평행 인접 길)이 생기는지 검사.
fn would_make_2x2(ground: &[Ground], p: Pos) -> bool {
    for oy in [-1, 0] {
        for ox in [-1, 0] {
            let mut filled = 0;
            for dy in 0..=1 {
                for dx in 0..=1 {
                    let q = (p.0 + ox + dx, p.1 + oy + dy);
                    if !in_world(q) {
                        continue;
                    }
                    if q == p || ground[idx(q)] != Ground::Wild {
                        filled += 1;
                    }
                }
            }
            if filled == 4 {
                return true;
            }
        }
    }
    false
}

/// 기존 길과 평행으로 2칸 폭 덩어리를 만들지 않도록 비용 기반 다익스트라로 길을 깐다.
fn carve_road(ground: &mut [Ground], from: Pos, to: Pos) {
    let n = (WW * WH) as usize;
    let mut dist = vec![u32::MAX; n];
    let mut prev = vec![usize::MAX; n];
    let mut prev_dir = vec![4u8; n];
    let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
    let start = idx(from);
    let goal = idx(to);
    dist[start] = 0;
    heap.push(Reverse((0, start)));

    const DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
    while let Some(Reverse((d, u))) = heap.pop() {
        if d > dist[u] {
            continue;
        }
        if u == goal {
            break;
        }
        let ux = (u as i32) % WW;
        let uy = (u as i32) / WW;
        for (dir_i, &(dx, dy)) in DIRS.iter().enumerate() {
            let np = (ux + dx, uy + dy);
            if !in_world(np) {
                continue;
            }
            // 외곽 1칸은 프레임 여백으로 비워 둔다.
            if np.0 == 0 || np.1 == 0 || np.0 == WW - 1 || np.1 == WH - 1 {
                continue;
            }
            let v = idx(np);
            let step_cost = if v == goal {
                1
            } else {
                match ground[v] {
                    Ground::Road | Ground::Site(_) => 1,
                    Ground::Wild => {
                        let mut c = 4;
                        if would_make_2x2(ground, np) {
                            c += 60;
                        }
                        c
                    }
                }
            };
            let turn_cost = if prev_dir[u] < 4 && prev_dir[u] != dir_i as u8 { 2 } else { 0 };
            let nd = d + step_cost + turn_cost;
            if nd < dist[v] {
                dist[v] = nd;
                prev[v] = u;
                prev_dir[v] = dir_i as u8;
                heap.push(Reverse((nd, v)));
            }
        }
    }

    if prev[goal] == usize::MAX {
        return;
    }
    let mut cur = goal;
    while cur != start {
        if ground[cur] == Ground::Wild {
            ground[cur] = Ground::Road;
        }
        cur = prev[cur];
    }
}

impl World {
    pub fn new(seed: u64) -> World {
        let mut rng = Rng::new(seed ^ 0x776f726c64);
        let mut ground = vec![Ground::Wild; (WW * WH) as usize];

        // 11×6 구역 중 약 48~54개에 거점을 배치한다 (서→중→동 리듬).
        let mut grid: Vec<Option<usize>> = vec![None; (SECTOR_COLS * SECTOR_ROWS) as usize];
        let mut sites = Vec::new();
        let home_row = 1 + rng.below((SECTOR_ROWS - 2) as u32) as i32;
        let enemy_row = 1 + rng.below((SECTOR_ROWS - 2) as u32) as i32;
        let fob_row = (home_row + rng.below(3) as i32 - 1).clamp(1, SECTOR_ROWS - 2);

        for cy in 0..SECTOR_ROWS {
            for cx in 0..SECTOR_COLS {
                let forced = (cx == 0 && cy == home_row)
                    || (cx == SECTOR_COLS - 1 && cy == enemy_row)
                    || (cx == 2 && cy == fob_row);
                // 약 20%의 구역을 비워 자연스러운 계곡/공백을 만든다.
                if !forced && rng.below(100) < 20 {
                    continue;
                }
                let x = cx * CELL + 2 + rng.below((CELL - 4) as u32) as i32;
                let y = cy * CELL + 2 + rng.below((CELL - 4) as u32) as i32;
                let (kind, owner) = if cx == 0 && cy == home_row {
                    (SiteKind::Hq(Side::Brood), Some(Side::Brood))
                } else if cx == SECTOR_COLS - 1 && cy == enemy_row {
                    (SiteKind::Hq(Side::Empire), Some(Side::Empire))
                } else if cx == 2 && cy == fob_row {
                    (SiteKind::Fob, Some(Side::Brood))
                } else {
                    pick_site_kind(cx, &mut rng)
                };
                let id = sites.len();
                sites.push(Site { pos: (x, y), kind, owner, code: sector_code(cx, cy), col: cx, row: cy });
                grid[(cy * SECTOR_COLS + cx) as usize] = Some(id);
            }
        }

        // 거점이 최소 42개는 되도록 보강한다.
        for cy in 0..SECTOR_ROWS {
            for cx in 0..SECTOR_COLS {
                if sites.len() >= 48 {
                    break;
                }
                if grid[(cy * SECTOR_COLS + cx) as usize].is_some() {
                    continue;
                }
                let x = cx * CELL + 2 + rng.below((CELL - 4) as u32) as i32;
                let y = cy * CELL + 2 + rng.below((CELL - 4) as u32) as i32;
                let (kind, owner) = pick_site_kind(cx, &mut rng);
                let id = sites.len();
                sites.push(Site { pos: (x, y), kind, owner, code: sector_code(cx, cy), col: cx, row: cy });
                grid[(cy * SECTOR_COLS + cx) as usize] = Some(id);
            }
        }

        // 중계탑과 착륙장이 최소 2개씩은 있도록 보장.
        ensure_site_kind(&mut sites, SiteKind::Relay, Some(Side::Empire), 5, 8, 2);
        ensure_site_kind(&mut sites, SiteKind::Landing, Some(Side::Empire), 8, 10, 2);
        ensure_site_kind(&mut sites, SiteKind::Resource, None, 3, 6, 4);

        for (i, s) in sites.iter().enumerate() {
            ground[idx(s.pos)] = Ground::Site(i);
        }

        // 이웃 거점 간 간선 후보 생성 + 유니온파인드로 전체 연결 보장.
        let mut candidates: Vec<(usize, usize, i32)> = Vec::new();
        for i in 0..sites.len() {
            for j in (i + 1)..sites.len() {
                let dc = (sites[i].col - sites[j].col).abs();
                let dr = (sites[i].row - sites[j].row).abs();
                if (dc == 1 && dr == 0) || (dc == 0 && dr == 1) || (dc == 1 && dr == 1 && rng.below(100) < 25) {
                    candidates.push((i, j, manhattan(sites[i].pos, sites[j].pos)));
                }
            }
        }
        // 후보를 거리순 + 약간의 무작위로 정렬
        candidates.sort_by_key(|&(a, b, d)| (d, a, b));

        let mut group: Vec<usize> = (0..sites.len()).collect();
        fn root(group: &mut [usize], mut i: usize) -> usize {
            while group[i] != i {
                group[i] = group[group[i]];
                i = group[i];
            }
            i
        }

        let mut edges: Vec<(usize, usize)> = Vec::new();
        let mut spare: Vec<(usize, usize)> = Vec::new();
        for (a, b, _) in candidates {
            let (ra, rb) = (root(&mut group, a), root(&mut group, b));
            if ra != rb {
                group[ra] = rb;
                edges.push((a, b));
            } else if rng.below(100) < 35 {
                spare.push((a, b));
            }
        }
        // 혹시 떨어진 섬이 있으면 가장 가까운 거점과 연결.
        for i in 1..sites.len() {
            let (r0, ri) = (root(&mut group, 0), root(&mut group, i));
            if r0 != ri {
                if let Some(best) = (0..sites.len())
                    .filter(|&j| root(&mut group, j) == r0)
                    .min_by_key(|&j| manhattan(sites[i].pos, sites[j].pos))
                {
                    let rb = root(&mut group, best);
                    group[ri] = rb;
                    edges.push((i, best));
                }
            }
        }
        edges.extend(spare);

        for (a, b) in edges {
            carve_road(&mut ground, sites[a].pos, sites[b].pos);
        }
        // 거점 칸 재확인
        for (i, s) in sites.iter().enumerate() {
            ground[idx(s.pos)] = Ground::Site(i);
        }

        // 초기 부대 배치
        let mut forces = Vec::new();
        let brood_hq = sites.iter().position(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap();
        let empire_hq = sites.iter().position(|s| s.kind == SiteKind::Hq(Side::Empire)).unwrap();

        // 0번 부대: 플레이어가 직접 조종하는 유일한 정예 특수부대.
        forces.push(Force {
            side: Side::Brood,
            role: ForceRole::Special,
            pos: sites[brood_hq].pos,
            size: 6,
            order: Order::Hold,
            duty: Duty::None,
            progress: 0,
            alive: true,
        });

        // 아군 AI 일반군 (본진, 전진 기지, 서부·중앙 거점)
        forces.push(make_force(Side::Brood, ForceRole::BroodAi, sites[brood_hq].pos, 8, Duty::Garrison));
        let mut brood_spawned = 0;
        for s in &sites {
            if s.kind == SiteKind::Fob {
                forces.push(make_force(Side::Brood, ForceRole::BroodAi, s.pos, 8, Duty::Garrison));
                brood_spawned += 1;
            } else if s.owner == Some(Side::Brood) && s.kind != SiteKind::Hq(Side::Brood) && brood_spawned < 5 {
                forces.push(make_force(Side::Brood, ForceRole::BroodAi, s.pos, 6, Duty::Garrison));
                brood_spawned += 1;
            }
        }

        // 제국 주둔군 및 순찰대
        forces.push(make_force(Side::Empire, ForceRole::EmpireGarrison, sites[empire_hq].pos, 14, Duty::Garrison));
        let mut patrols = 0;
        for s in &sites {
            match s.kind {
                SiteKind::Outpost => {
                    forces.push(make_force(Side::Empire, ForceRole::EmpireGarrison, s.pos, 7, Duty::Garrison));
                    if patrols < 3 {
                        forces.push(make_force(Side::Empire, ForceRole::EmpirePatrol, s.pos, 5, Duty::None));
                        patrols += 1;
                    }
                }
                SiteKind::Relay => {
                    forces.push(make_force(Side::Empire, ForceRole::EmpireGarrison, s.pos, 5, Duty::Garrison));
                }
                SiteKind::Landing => {
                    forces.push(make_force(Side::Empire, ForceRole::EmpireGarrison, s.pos, 8, Duty::Garrison));
                }
                _ => {}
            }
        }

        let mut world = World {
            seed,
            ground,
            sites,
            forces,
            tick: 0,
            selected: None,
            target: None,
            preview_proposal: None,
            clash: None,
            stop_reason: StopReason::None,
            proposals: Vec::new(),
            events: Vec::new(),
            biomass: 30,
            research_pct: 5,
            rng,
        };
        world.plan_ai_turn();
        world.compute_proposals();
        world.push_event(world.sites[brood_hq].pos, "작전 개시 · 특수부대 본진 대기".to_string(), false);
        world
    }

    pub fn special_index(&self) -> usize {
        0
    }

    pub fn special(&self) -> &Force {
        &self.forces[0]
    }

    pub fn ground(&self, p: Pos) -> Ground {
        if in_world(p) {
            self.ground[idx(p)]
        } else {
            Ground::Wild
        }
    }

    pub fn walkable(&self, p: Pos) -> bool {
        self.ground(p) != Ground::Wild
    }

    pub fn forces_at(&self, p: Pos) -> impl Iterator<Item = usize> + '_ {
        (0..self.forces.len()).filter(move |&i| self.forces[i].alive && self.forces[i].pos == p)
    }

    pub fn supply_summary(&self) -> (u32, u32) {
        let used: u32 = self.forces.iter().filter(|f| f.alive && f.side == Side::Brood).map(|f| f.size).sum();
        let bases = self
            .sites
            .iter()
            .filter(|s| s.owner == Some(Side::Brood) && matches!(s.kind, SiteKind::Hq(Side::Brood) | SiteKind::Fob))
            .count() as u32;
        let cap = (bases * 24).max(20);
        (used, cap)
    }

    /// 특수부대가 현재 보급권(본진/전진 기지에서 적에게 막히지 않은 18칸 이내) 안에 있는가.
    pub fn special_in_supply(&self) -> bool {
        let sp = self.special().pos;
        self.sites.iter().any(|s| {
            s.owner == Some(Side::Brood)
                && matches!(s.kind, SiteKind::Hq(Side::Brood) | SiteKind::Fob)
                && manhattan(s.pos, sp) <= 22
        })
    }

    /// 길을 따라 `from`에서 `to`까지. 출발 칸은 빼고 도착 칸은 넣는다. 길이 없으면 None.
    pub fn route(&self, from: Pos, to: Pos) -> Option<Vec<Pos>> {
        if !self.walkable(from) || !self.walkable(to) {
            return None;
        }
        if from == to {
            return Some(Vec::new());
        }
        let mut prev = vec![usize::MAX; (WW * WH) as usize];
        let mut queue = vec![from];
        prev[idx(from)] = idx(from);
        let mut head = 0;
        while head < queue.len() {
            let p = queue[head];
            head += 1;
            if p == to {
                let mut path = Vec::new();
                let mut i = idx(to);
                while i != idx(from) {
                    path.push(((i as i32) % WW, (i as i32) / WW));
                    i = prev[i];
                }
                path.reverse();
                return Some(path);
            }
            for d in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let n = (p.0 + d.0, p.1 + d.1);
                if self.walkable(n) && prev[idx(n)] == usize::MAX {
                    prev[idx(n)] = idx(p);
                    queue.push(n);
                }
            }
        }
        None
    }

    /// 특수부대를 직접 선택한다 (단축키 F / [분대] 버튼용).
    pub fn select_special(&mut self) -> bool {
        let s = self.special_index();
        if !self.forces[s].alive {
            return false;
        }
        let changed = self.selected != Some(s) || self.target.is_some();
        self.selected = Some(s);
        self.target = None;
        changed
    }

    /// 플레이어 입력: 칸 하나를 누른다.
    /// - 비선택 상태: 특수부대 칸을 누르면 특수부대를 선택한다. 다른 칸을 누르면 선택하지 않고 조사만 한다.
    /// - 선택 상태: 길/거점 칸을 누르면 목적지로 찍어 명령 고르기를 띄운다. 길 밖이나 자기 칸을 누르면 선택을 푼다.
    pub fn click(&mut self, p: Pos) -> bool {
        if !in_world(p) {
            return false;
        }
        let sp = self.special_index();
        if !self.forces[sp].alive {
            return false;
        }
        if self.selected.is_none() {
            if self.forces[sp].pos == p {
                self.selected = Some(sp);
                self.target = None;
                return true;
            }
            return false;
        }
        // 이미 특수부대가 선택된 상태.
        if self.forces[sp].pos == p {
            self.selected = None;
            self.target = None;
            return true;
        }
        if self.route(self.forces[sp].pos, p).is_some_and(|path| !path.is_empty()) {
            let changed = self.target != Some(p);
            self.target = Some(p);
            return changed;
        }
        self.selected = None;
        self.target = None;
        true
    }

    /// 찍어 둔 칸이 거점인가. 주둔은 거점에만 내릴 수 있다.
    pub fn can_garrison(&self) -> bool {
        self.target.is_some_and(|t| matches!(self.ground(t), Ground::Site(_)))
    }

    /// 고른 특수부대를 찍어 둔 칸으로 보내면서 할 일을 정한다.
    pub fn command(&mut self, command: Command) -> bool {
        let (Some(s), Some(target)) = (self.selected, self.target) else { return false };
        if command == Command::Garrison && !self.can_garrison() {
            return false;
        }
        self.issue_special_order(s, target, command)
    }

    /// 지휘망 제안 `i`번을 수락해 즉시 명령을 넣는다.
    pub fn accept_proposal(&mut self, i: usize) -> bool {
        let Some(prop) = self.proposals.get(i).cloned() else { return false };
        let s = self.special_index();
        if !self.forces[s].alive {
            return false;
        }
        let cmd = if prop.command == Command::Garrison && !matches!(self.ground(prop.target), Ground::Site(_)) {
            Command::Move
        } else {
            prop.command
        };
        let ok = self.issue_special_order(s, prop.target, cmd);
        if ok {
            self.preview_proposal = None;
        }
        ok
    }

    fn issue_special_order(&mut self, s: usize, target: Pos, command: Command) -> bool {
        let from = self.forces[s].pos;
        let Some(path) = self.route(from, target) else { return false };
        if path.is_empty() {
            self.forces[s].order = Order::Hold;
        } else {
            self.forces[s].order = Order::Move(path);
        }
        self.forces[s].progress = 0;
        self.forces[s].duty = match command {
            Command::Move => Duty::None,
            Command::Ambush => Duty::Ambush,
            Command::Garrison => Duty::Garrison,
            Command::Scout => Duty::Scout(from, target),
        };
        self.clash = None;
        self.stop_reason = StopReason::None;
        self.selected = None;
        self.target = None;
        true
    }

    /// 길의 끝에 닿았다. 정찰이면 반대쪽 끝으로 돌아선다.
    fn arrive(&mut self, i: usize) {
        self.forces[i].order = Order::Hold;
        if let Duty::Scout(a, b) = self.forces[i].duty {
            let next = if self.forces[i].pos == b { a } else { b };
            if let Some(path) = self.route(self.forces[i].pos, next).filter(|p| !p.is_empty()) {
                self.forces[i].order = Order::Move(path);
            }
            return;
        }
        // 거점에 도착했고 적이 없으면 점령 갱신
        let pos = self.forces[i].pos;
        let side = self.forces[i].side;
        let has_foe = self.forces.iter().any(|f| f.alive && f.side != side && f.pos == pos);
        if !has_foe {
            if let Ground::Site(si) = self.ground(pos) {
                if self.sites[si].owner != Some(side) {
                    self.sites[si].owner = Some(side);
                    let code = self.sites[si].code.clone();
                    let label = self.sites[si].kind.label();
                    let who = if side == Side::Brood { "아군 확보" } else { "제국 점령" };
                    let alert = side == Side::Empire || self.forces[i].role == ForceRole::Special;
                    self.push_event(pos, format!("{code} {label} {who}"), alert);
                    if alert && self.forces[i].role != ForceRole::Special {
                        self.stop_reason = StopReason::Alert;
                    }
                }
            }
        }
        if self.forces[i].role == ForceRole::Special {
            self.stop_reason = StopReason::Arrived;
        }
    }

    pub fn day(&self) -> u64 {
        self.tick / TICKS_PER_DAY
    }

    fn push_event(&mut self, pos: Pos, text: String, alert: bool) {
        let day = self.day();
        self.events.insert(0, WorldEvent { day, pos, text, alert });
        if self.events.len() > MAX_EVENTS {
            self.events.truncate(MAX_EVENTS);
        }
    }

    /// AI끼리의 충돌을 결정론적 모의전으로 처리한다.
    fn resolve_ai_clash(&mut self, a: usize, b: usize) {
        let pos = self.forces[b].pos;
        let a_garrison = if self.forces[a].duty == Duty::Garrison { 2 } else { 0 };
        let b_garrison = if self.forces[b].duty == Duty::Garrison { 2 } else { 0 };
        let a_pow = self.forces[a].size + a_garrison + self.rng.below(3);
        let b_pow = self.forces[b].size + b_garrison + self.rng.below(3);

        let (winner, loser) = if a_pow >= b_pow { (a, b) } else { (b, a) };
        let loss = (self.forces[loser].size / 2).max(1);
        let win_loss = (loss / 2).min(self.forces[winner].size.saturating_sub(1));
        self.forces[winner].size = self.forces[winner].size.saturating_sub(win_loss).max(1);
        self.forces[loser].size = self.forces[loser].size.saturating_sub(loss);

        let loc = match self.ground(pos) {
            Ground::Site(si) => self.sites[si].code.clone(),
            _ => sector_code(pos.0 / CELL, pos.1 / CELL),
        };
        if self.forces[loser].size == 0 {
            self.forces[loser].alive = false;
            self.forces[loser].order = Order::Hold;
            let tag = if self.forces[winner].side == Side::Brood { "아군 승" } else { "제국 승" };
            self.push_event(pos, format!("{loc} 교전 ({tag})"), self.forces[winner].side == Side::Empire);
        } else {
            // 패배한 쪽은 잠시 멈춘다.
            self.forces[loser].order = Order::Hold;
            self.push_event(pos, format!("{loc} 소규모 교전"), false);
        }
        self.forces[a].order = Order::Hold;
    }

    /// 매일 0틱에 아군 AI와 제국 AI가 전선 계획을 갱신한다.
    fn plan_ai_turn(&mut self) {
        // 1. 자원 및 기초 연구 진행
        let brood_resources = self
            .sites
            .iter()
            .filter(|s| s.kind == SiteKind::Resource && s.owner == Some(Side::Brood))
            .count() as u32;
        self.biomass += 2 + brood_resources * 3;
        let empire_relays = self
            .sites
            .iter()
            .filter(|s| s.kind == SiteKind::Relay && s.owner == Some(Side::Empire))
            .count() as u32;
        if self.tick > 0 && self.day() % 2 == 0 {
            self.research_pct = (self.research_pct + 1 + empire_relays / 2).min(100);
        }

        // 2. 제국 보급대 주기적 출발 (3일마다)
        let active_convoys = self
            .forces
            .iter()
            .filter(|f| f.alive && f.role == ForceRole::EmpireConvoy)
            .count();
        if active_convoys < 2 && self.day() % 3 == 0 {
            let sources: Vec<Pos> = self
                .sites
                .iter()
                .filter(|s| s.owner == Some(Side::Empire) && matches!(s.kind, SiteKind::Hq(Side::Empire) | SiteKind::Landing))
                .map(|s| s.pos)
                .collect();
            let dests: Vec<Pos> = self
                .sites
                .iter()
                .filter(|s| s.owner == Some(Side::Empire) && matches!(s.kind, SiteKind::Outpost | SiteKind::Relay))
                .map(|s| s.pos)
                .collect();
            if !sources.is_empty() && !dests.is_empty() {
                let src = sources[self.rng.below(sources.len() as u32) as usize];
                let dst = dests[self.rng.below(dests.len() as u32) as usize];
                if let Some(path) = self.route(src, dst).filter(|p| !p.is_empty()) {
                    self.forces.push(Force {
                        side: Side::Empire,
                        role: ForceRole::EmpireConvoy,
                        pos: src,
                        size: 4,
                        order: Order::Move(path),
                        duty: Duty::None,
                        progress: 0,
                        alive: true,
                    });
                    let code = match self.ground(dst) {
                        Ground::Site(si) => self.sites[si].code.clone(),
                        _ => sector_code(dst.0 / CELL, dst.1 / CELL),
                    };
                    self.push_event(src, format!("{code} 방면 제국 보급대 출발"), false);
                }
            }
        }

        // 3. 제국 순찰대 이동
        let empire_sites: Vec<Pos> = self
            .sites
            .iter()
            .filter(|s| s.owner == Some(Side::Empire) || s.kind == SiteKind::Resource)
            .map(|s| s.pos)
            .collect();
        for i in 0..self.forces.len() {
            if !self.forces[i].alive || self.forces[i].order != Order::Hold {
                continue;
            }
            if self.forces[i].role == ForceRole::EmpirePatrol && !empire_sites.is_empty() {
                let cur = self.forces[i].pos;
                let mut near: Vec<Pos> = empire_sites
                    .iter()
                    .copied()
                    .filter(|&p| p != cur && manhattan(p, cur) <= 28)
                    .collect();
                if near.is_empty() {
                    near = empire_sites.clone();
                }
                let pick = near[self.rng.below(near.len() as u32) as usize];
                if let Some(path) = self.route(cur, pick).filter(|p| !p.is_empty()) {
                    self.forces[i].order = Order::Move(path);
                }
            }
        }

        // 4. 자율 아군 AI 일반군 이동 (가장 가까운 중립 자원지나 약한 제국 거점으로 진격/순환)
        let targets: Vec<Pos> = self
            .sites
            .iter()
            .filter(|s| s.owner != Some(Side::Brood) && !matches!(s.kind, SiteKind::Hq(Side::Empire)))
            .map(|s| s.pos)
            .collect();
        let mut movers = 0;
        for i in 0..self.forces.len() {
            if !self.forces[i].alive || self.forces[i].role != ForceRole::BroodAi {
                continue;
            }
            if self.forces[i].order != Order::Hold {
                movers += 1;
                continue;
            }
            // 본진 수비대는 남기고, 전선 아군 AI 2~3개만 능동적으로 움직인다.
            let at_hq = matches!(self.ground(self.forces[i].pos), Ground::Site(si) if self.sites[si].kind == SiteKind::Hq(Side::Brood));
            if at_hq || movers >= 3 {
                continue;
            }
            let cur = self.forces[i].pos;
            if let Some(&best) = targets.iter().min_by_key(|&&p| manhattan(cur, p)) {
                if let Some(path) = self.route(cur, best).filter(|p| !p.is_empty()) {
                    self.forces[i].order = Order::Move(path);
                    self.forces[i].duty = Duty::None;
                    movers += 1;
                }
            }
        }
    }

    /// 지휘망(AI)이 플레이어 특수부대까지 시뮬레이션해 서로 다른 3개 축에서
    /// 주 권고 1안 + 대안 2안을 계산한다.
    pub fn compute_proposals(&mut self) {
        let sp = self.special();
        if !sp.alive {
            self.proposals.clear();
            return;
        }
        let from = sp.pos;
        let step_t = sp.step_ticks();
        let mut scored: Vec<(i32, Proposal)> = Vec::new();

        // 축 1: 공세/협공 지원 (제국 보급대 차단 또는 아군 AI가 향하는 제국 전초 지원)
        let convoy_target = self
            .forces
            .iter()
            .filter(|f| f.alive && f.role == ForceRole::EmpireConvoy)
            .min_by_key(|f| manhattan(from, f.pos))
            .map(|f| {
                let aim = match &f.order {
                    Order::Move(p) if p.len() > 2 => p[p.len() / 2],
                    _ => f.pos,
                };
                aim
            });
        if let Some(t) = convoy_target {
            if let Some(path) = self.route(from, t) {
                let code = sector_code(t.0 / CELL, t.1 / CELL);
                let eta = path.len() as u32 * step_t;
                scored.push((
                    90 - (path.len() as i32),
                    Proposal {
                        axis: ProposalAxis::Offense,
                        target: t,
                        site: None,
                        command: Command::Ambush,
                        title: format!("{code} 보급로 차단"),
                        reason: "제국 보급대 매복 · 전초 수비 약화".to_string(),
                        eta_ticks: eta,
                    },
                ));
            }
        } else if let Some((si, s)) = self
            .sites
            .iter()
            .enumerate()
            .filter(|(_, s)| s.owner == Some(Side::Empire) && s.kind == SiteKind::Outpost)
            .min_by_key(|(_, s)| manhattan(from, s.pos))
        {
            if let Some(path) = self.route(from, s.pos) {
                let eta = path.len() as u32 * step_t;
                scored.push((
                    82 - (path.len() as i32),
                    Proposal {
                        axis: ProposalAxis::Offense,
                        target: s.pos,
                        site: Some(si),
                        command: Command::Move,
                        title: format!("{} 전초 타격", s.code),
                        reason: "아군 본대 전선 압박 지원".to_string(),
                        eta_ticks: eta,
                    },
                ));
            }
        }

        // 축 2: 방어/보존 (위태로운 아군 자원지·전진기지 주둔 지원)
        let threatened_site = self
            .sites
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                matches!(s.kind, SiteKind::Resource | SiteKind::Fob)
                    && (s.owner == Some(Side::Brood) || s.owner.is_none())
            })
            .min_by_key(|(_, s)| {
                let foe_d = self
                    .forces
                    .iter()
                    .filter(|f| f.alive && f.side == Side::Empire)
                    .map(|f| manhattan(f.pos, s.pos))
                    .min()
                    .unwrap_or(99);
                foe_d * 2 + manhattan(from, s.pos) / 2
            });
        if let Some((si, s)) = threatened_site {
            if let Some(path) = self.route(from, s.pos) {
                let eta = path.len() as u32 * step_t;
                scored.push((
                    85 - (path.len() as i32),
                    Proposal {
                        axis: ProposalAxis::Defense,
                        target: s.pos,
                        site: Some(si),
                        command: Command::Garrison,
                        title: format!("{} {} 주둔", s.code, s.kind.label()),
                        reason: "제국 접근 대비 · 자원/보급선 보존".to_string(),
                        eta_ticks: eta,
                    },
                ));
            }
        }

        // 축 3: 교란/첩보 (제국 중계탑 타격 또는 고지 정찰)
        let disrupt_site = self
            .sites
            .iter()
            .enumerate()
            .filter(|(_, s)| s.owner == Some(Side::Empire) && matches!(s.kind, SiteKind::Relay | SiteKind::Landing))
            .min_by_key(|(_, s)| manhattan(from, s.pos));
        if let Some((si, s)) = disrupt_site {
            if let Some(path) = self.route(from, s.pos) {
                let eta = path.len() as u32 * step_t;
                let (title, reason) = if s.kind == SiteKind::Relay {
                    (format!("{} 중계탑 타격", s.code), "구역 제국 보고망 차단 · 증거 은폐".to_string())
                } else {
                    (format!("{} 착륙장 기습", s.code), "제국 증원 유입 지연".to_string())
                };
                scored.push((
                    84 - (path.len() as i32),
                    Proposal {
                        axis: ProposalAxis::Disrupt,
                        target: s.pos,
                        site: Some(si),
                        command: Command::Move,
                        title,
                        reason,
                        eta_ticks: eta,
                    },
                ));
            }
        } else if let Some((si, s)) = self
            .sites
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind == SiteKind::Ridge)
            .min_by_key(|(_, s)| manhattan(from, s.pos))
        {
            if let Some(path) = self.route(from, s.pos) {
                let eta = path.len() as u32 * step_t;
                scored.push((
                    75 - (path.len() as i32),
                    Proposal {
                        axis: ProposalAxis::Disrupt,
                        target: s.pos,
                        site: Some(si),
                        command: Command::Scout,
                        title: format!("{} 고지 정찰", s.code),
                        reason: "인근 제국 편제 및 보급로 감청".to_string(),
                        eta_ticks: eta,
                    },
                ));
            }
        }

        scored.sort_by(|a, b| b.0.cmp(&a.0));
        self.proposals = scored.into_iter().map(|(_, p)| p).collect();
    }

    /// 시간을 한 틱 넘긴다. 특수부대가 적과 마주치면 `clash`가 서고 그 뒤로는 넘어가지 않는다.
    pub fn tick(&mut self) {
        if self.clash.is_some() {
            return;
        }
        self.stop_reason = StopReason::None;
        self.tick += 1;

        for i in 0..self.forces.len() {
            if !self.forces[i].alive {
                continue;
            }
            let Order::Move(path) = &self.forces[i].order else { continue };
            let Some(&next) = path.first() else {
                self.arrive(i);
                continue;
            };
            self.forces[i].progress += 1;
            if self.forces[i].progress < self.forces[i].step_ticks() {
                continue;
            }
            self.forces[i].progress = 0;
            let side = self.forces[i].side;
            let foe = (0..self.forces.len()).find(|&j| self.forces[j].alive && self.forces[j].pos == next && self.forces[j].side != side);
            if let Some(foe) = foe {
                let involves_special =
                    self.forces[i].role == ForceRole::Special || self.forces[foe].role == ForceRole::Special;
                if involves_special {
                    self.forces[i].order = Order::Hold;
                    let (sp, en) = if self.forces[i].role == ForceRole::Special { (i, foe) } else { (foe, i) };
                    self.clash = Some((sp, en));
                    self.stop_reason = StopReason::Clash;
                    let loc = sector_code(next.0 / CELL, next.1 / CELL);
                    self.push_event(next, format!("{loc} 특수부대 적과 조우"), true);
                    return;
                } else {
                    self.resolve_ai_clash(i, foe);
                    continue;
                }
            }
            self.forces[i].pos = next;
            let mut arrived = false;
            if let Order::Move(path) = &mut self.forces[i].order {
                path.remove(0);
                arrived = path.is_empty();
            }
            if arrived {
                self.arrive(i);
            }
        }

        // 하루가 바뀌는 시점에 AI 계획 및 지휘망 제안을 갱신한다.
        if self.tick % TICKS_PER_DAY == 0 {
            self.plan_ai_turn();
            self.compute_proposals();
        }
    }

    pub fn fingerprint(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        };
        mix(self.tick);
        mix(self.biomass as u64);
        mix(self.research_pct as u64);
        for f in &self.forces {
            if !f.alive {
                continue;
            }
            mix(idx(f.pos) as u64);
            mix(f.size as u64);
            mix(f.progress as u64);
            mix(match &f.order {
                Order::Hold => 0,
                Order::Move(path) => 1 + path.len() as u64,
            });
            mix(match f.duty {
                Duty::None => 0,
                Duty::Ambush => 1,
                Duty::Garrison => 2,
                Duty::Scout(a, b) => 3 + (idx(a) as u64) * 4096 + idx(b) as u64 * 16_777_216,
            });
        }
        h
    }
}

fn make_force(side: Side, role: ForceRole, pos: Pos, size: u32, duty: Duty) -> Force {
    Force { side, role, pos, size, order: Order::Hold, duty, progress: 0, alive: true }
}

fn pick_site_kind(col: i32, rng: &mut Rng) -> (SiteKind, Option<Side>) {
    let r = rng.below(100);
    if col <= 2 {
        // 서부 (변경·은신처)
        if r < 45 {
            (SiteKind::Hideout, Some(Side::Brood))
        } else if r < 70 {
            (SiteKind::Choke, Some(Side::Brood))
        } else {
            (SiteKind::Resource, Some(Side::Brood))
        }
    } else if col <= 6 {
        // 중앙 (자원지·고지·분쟁지)
        if r < 28 {
            (SiteKind::Resource, None)
        } else if r < 52 {
            (SiteKind::Ridge, None)
        } else if r < 80 {
            (SiteKind::Choke, None)
        } else {
            (SiteKind::Relay, Some(Side::Empire))
        }
    } else if col <= 8 {
        // 중동부 (제국 전초·중계탑)
        if r < 45 {
            (SiteKind::Outpost, Some(Side::Empire))
        } else if r < 72 {
            (SiteKind::Relay, Some(Side::Empire))
        } else if r < 88 {
            (SiteKind::Choke, Some(Side::Empire))
        } else {
            (SiteKind::Resource, Some(Side::Empire))
        }
    } else {
        // 동부 (제국 착륙장·전초)
        if r < 42 {
            (SiteKind::Landing, Some(Side::Empire))
        } else if r < 82 {
            (SiteKind::Outpost, Some(Side::Empire))
        } else {
            (SiteKind::Choke, Some(Side::Empire))
        }
    }
}

fn ensure_site_kind(sites: &mut [Site], kind: SiteKind, owner: Option<Side>, min_col: i32, max_col: i32, min_count: usize) {
    let mut have = sites.iter().filter(|s| s.kind == kind).count();
    if have >= min_count {
        return;
    }
    for s in sites.iter_mut() {
        if have >= min_count {
            break;
        }
        if s.col >= min_col && s.col <= max_col && s.kind == SiteKind::Choke {
            s.kind = kind;
            s.owner = owner;
            have += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_theater_has_40_to_60_connected_sites() {
        for seed in 0..20 {
            let w = World::new(seed);
            assert!(
                (40..=66).contains(&w.sites.len()),
                "seed {seed}: sites = {}",
                w.sites.len()
            );
            for s in &w.sites[1..] {
                assert!(w.route(w.sites[0].pos, s.pos).is_some(), "seed {seed}: {:?}", s.pos);
            }
            assert!(w.sites.iter().any(|s| s.kind == SiteKind::Hq(Side::Brood)));
            assert!(w.sites.iter().any(|s| s.kind == SiteKind::Hq(Side::Empire)));
            assert_eq!(w.proposals.len(), 3, "seed {seed}: should have 1+2 proposals");
        }
    }

    #[test]
    fn maps_differ_by_seed_and_repeat_for_the_same_seed() {
        assert_eq!(World::new(5).ground, World::new(5).ground);
        assert_ne!(World::new(5).ground, World::new(6).ground);
    }

    #[test]
    fn clicking_other_tiles_without_selecting_special_does_not_command() {
        let mut w = World::new(3);
        let sp_pos = w.special().pos;
        let other = w.sites.iter().find(|s| s.pos != sp_pos).unwrap().pos;
        assert!(!w.click(other), "비선택 상태 클릭은 명령이 아니라 조사다");
        assert!(w.selected.is_none());
        assert!(w.click(sp_pos), "특수부대 클릭 시 선택된다");
        assert_eq!(w.selected, Some(0));
        assert!(w.click(other), "선택 후 목적지 클릭 시 타깃이 찍힌다");
        assert_eq!(w.target, Some(other));
        assert!(w.command(Command::Move));
        assert!(matches!(w.special().order, Order::Move(_)));
    }

    #[test]
    fn accept_proposal_issues_order_and_ticks_deterministically() {
        let run = || {
            let mut w = World::new(9);
            assert!(w.accept_proposal(0));
            for _ in 0..120 {
                w.tick();
            }
            w.fingerprint()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn special_garrison_and_scout_work() {
        let mut w = World::new(3);
        let start = w.special().pos;
        let site = w.sites.iter().map(|x| x.pos).find(|&p| p != start).unwrap();
        let path = w.route(start, site).unwrap();
        let road = path[0];
        assert!(w.select_special());
        w.click(road);
        assert!(!w.can_garrison());
        assert!(!w.command(Command::Garrison));
        assert!(w.command(Command::Ambush));
        for _ in 0..50 {
            w.tick();
        }
        assert_eq!(w.special().duty, Duty::Ambush);
    }
}
