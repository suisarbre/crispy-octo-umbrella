//! 월드. 80×52 육각(Hex, odd-q) 대규모 전구 위에서 자율 아군 AI와 제국 AI가 맞붙고,
//! 플레이어는 단 하나의 정예 특수부대를 직접 통제해 전황을 뒤집는다.
//! 도로를 타면 이동 비용이 낮고 보급이 멀리 닿아 자연스럽게 도로망이 전략의 축이 되며,
//! 특수부대는 숲·고지 야지를 횡단해 우회 침투와 매복을 건다.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::rng::Rng;
use crate::{
    format_callsign, rank_aim_bonus, rank_from_service, rank_hp_bonus, rank_label, BattleBiome, BattleConfig,
    BattleObjective, Class, Gene, Pos, Side,
};

/// 문명 5 보통(Standard) 크기 기준 80×52 육각 전구.
pub const WW: i32 = 80;
pub const WH: i32 = 52;
pub const HEX_COUNT: usize = (WW * WH) as usize;
/// 하루는 이만큼의 틱이다. 한 턴이 하루다.
pub const TICKS_PER_DAY: u64 = 24;
/// 거점 배치 매크로 격자 (10×6 구역 중 45~56개 거점 배치).
pub const SECTOR_COLS: i32 = 10;
pub const SECTOR_ROWS: i32 = 6;
const MAX_EVENTS: usize = 12;

pub const MAX_SQUAD: usize = 8;
pub const HEAL_COST_PER_HP: u32 = 2;
pub const REGENE_COST: u32 = 4;
pub const RECRUIT_COST: u32 = 12;
/// 보급권 한계 비용 (도로 1칸 = 비용 1, 야지 평지 = 2, 숲/고지 = 3).
pub const SUPPLY_LIMIT: u32 = 28;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Terrain {
    /// 평지.
    Plains,
    /// 숲/험지. 야지 이동은 느리지만 은밀하며 전투 엄폐가 많다.
    Forest,
    /// 고지. 시야와 방어에 유리하다.
    Hill,
    /// 산맥. 통과 불가. 자연스러운 협곡과 길목을 만든다.
    Mountain,
    /// 협곡/방사능 해역. 통과 불가. 대륙 윤곽을 만든다.
    Chasm,
}

impl Terrain {
    pub fn passable(self) -> bool {
        !matches!(self, Terrain::Mountain | Terrain::Chasm)
    }

    pub fn label(self) -> &'static str {
        match self {
            Terrain::Plains => "평지",
            Terrain::Forest => "숲",
            Terrain::Hill => "고지",
            Terrain::Mountain => "산맥",
            Terrain::Chasm => "불모 해역",
        }
    }

    pub fn code(self) -> u32 {
        match self {
            Terrain::Plains => 0,
            Terrain::Forest => 1,
            Terrain::Hill => 2,
            Terrain::Mountain => 3,
            Terrain::Chasm => 4,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SiteKind {
    /// 그 진영의 본진.
    Hq(Side),
    /// 아군 전진 기지 (보급 거점).
    Fob,
    /// 은신처 (본진 이전 후보).
    Hideout,
    /// 길목/교차로 거점.
    Choke,
    /// 생체질 자원지.
    Resource,
    /// 관측 고지.
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

    pub fn code(self) -> u32 {
        match self {
            SiteKind::Hq(Side::Brood) => 1,
            SiteKind::Hq(Side::Empire) => 2,
            SiteKind::Fob => 3,
            SiteKind::Hideout => 4,
            SiteKind::Choke => 5,
            SiteKind::Resource => 6,
            SiteKind::Ridge => 7,
            SiteKind::Outpost => 8,
            SiteKind::Relay => 9,
            SiteKind::Landing => 10,
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
    /// 남은 헥스 경로. 앞에서부터 한 헥스씩 이동한다.
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

/// 플레이어가 고르는 명령. 찍은 헥스로 가서 무엇을 할지.
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
    /// 다음 헥스까지 쌓인 틱.
    pub progress: u32,
    pub alive: bool,
}

impl Force {
    /// 기본 1단위 이동 비용당 틱 (특수부대는 기동성이 높고 야지에서도 덜 느려진다).
    pub fn base_ticks(&self) -> u32 {
        let base = if self.role == ForceRole::Special { 4 } else { 6 };
        base + self.size / 4
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

/// 특수부대 대원 한 명. 판 전체를 살아남으며 개조·체력·호출부호·전공(계급)이 이어진다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Trooper {
    pub gene: Gene,
    pub hp: i32,
    pub max_hp: i32,
    /// 살아남은 전투 수.
    pub battles: u32,
    /// 누적 적 처치 수.
    pub kills: u32,
    /// 결정론 호출부호 ID (`V-01`, `K-02` 등).
    pub callsign_id: u16,
}

impl Trooper {
    pub fn new(gene: Gene) -> Trooper {
        Self::with_callsign(gene, 0)
    }

    pub fn with_callsign(gene: Gene, callsign_id: u16) -> Trooper {
        let max_hp = Class::Proto.def().hp;
        Trooper { gene, hp: max_hp, max_hp, battles: 0, kills: 0, callsign_id }
    }

    pub fn rank(self) -> u8 {
        rank_from_service(self.battles, self.kills)
    }

    pub fn rank_label(self) -> &'static str {
        rank_label(self.rank())
    }

    pub fn callsign(self) -> String {
        format_callsign(self.callsign_id)
    }

    pub fn aim_bonus(self) -> i32 {
        rank_aim_bonus(self.rank())
    }

    pub fn sync_max_hp(&mut self) {
        let target_max = Class::Proto.def().hp + rank_hp_bonus(self.rank());
        if target_max > self.max_hp {
            let delta = target_max - self.max_hp;
            self.max_hp = target_max;
            self.hp = (self.hp + delta).min(self.max_hp);
        }
    }

    pub fn glyph(self) -> char {
        match self.gene {
            Gene::Sniper => 'ψ',
            Gene::Burst => 'θ',
            Gene::Burrow => 'λ',
            Gene::Plain => 'ν',
        }
    }

    pub fn name(self) -> &'static str {
        match self.gene {
            Gene::Sniper => "저격",
            Gene::Burst => "화력",
            Gene::Burrow => "잠복",
            Gene::Plain => "원형",
        }
    }
}

/// 직전 전술 전투의 결과 브리핑 (월드 복귀 시 1장 요약 모달 표시용).
#[derive(Clone, Debug)]
pub struct BattleBriefing {
    pub title: String,
    pub objective: BattleObjective,
    pub won: bool,
    pub survivors: usize,
    pub kia: usize,
    pub empire_losses: u32,
    pub biomass_gained: u32,
    pub captured_site: Option<String>,
    pub promotions: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct World {
    pub seed: u64,
    pub terrain: Vec<Terrain>,
    pub road: Vec<bool>,
    /// 각 헥스에 놓인 거점 번호.
    pub site_at: Vec<Option<usize>>,
    /// Civ식 영토 소유 (거점 반경 기반).
    pub territory: Vec<Option<Side>>,
    /// 아군 보급이 닿는 헥스 (도로를 타면 보급이 훨씬 멀리 간다).
    pub brood_supply: Vec<bool>,
    pub sites: Vec<Site>,
    pub forces: Vec<Force>,
    /// 특수부대 대원 명부 (`forces[0]`과 인원 동기화).
    pub squad: Vec<Trooper>,
    pub tick: u64,
    /// 특수부대가 선택되어 있는가. 비선택 시 클릭은 지도 조사에 쓴다.
    pub selected: Option<usize>,
    /// 특수부대를 보내려고 찍어 둔 헥스.
    pub target: Option<Pos>,
    /// 지휘망 제안 미리보기 번호.
    pub preview_proposal: Option<usize>,
    /// 특수부대가 마주친 충돌 `(특수부대, 적 부대)`. 생기면 시간이 멈춘다.
    pub clash: Option<(usize, usize)>,
    /// 전구 승패 (제국 본진 점령 또는 아군 본진/특수부대 전멸).
    pub victory: Option<Side>,
    /// 자동 진행이 멈춘 이유.
    pub stop_reason: StopReason,
    /// 지휘망 작전 제안: `[0]` 주 권고, `[1]` 대안1, `[2]` 대안2.
    pub proposals: Vec<Proposal>,
    /// 최근 전선 사건 (최신순).
    pub events: Vec<WorldEvent>,
    /// 자원 및 거시 지표.
    pub biomass: u32,
    pub research_pct: u32,
    /// 캠페인 결산 및 직전 전투 브리핑 지표.
    pub battles_fought: u32,
    pub battles_won: u32,
    pub total_kills: u32,
    pub next_callsign: u16,
    pub last_briefing: Option<BattleBriefing>,
    rng: Rng,
}

pub fn idx(p: Pos) -> usize {
    (p.1 * WW + p.0) as usize
}

pub fn in_world(p: Pos) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < WW && p.1 < WH
}

/// odd-q 육각 이웃 6방향 (시계 방향: NE, SE, S, SW, NW, N — flat-top 변 0..6과 일치).
/// 변 인덱스 `d`:
/// - 0: 우상 (NE), 1: 우하 (SE), 2: 하 (S), 3: 좌하 (SW), 4: 좌상 (NW), 5: 상 (N)
pub fn hex_neighbors(p: Pos) -> [Pos; 6] {
    let (q, r) = p;
    if q & 1 == 0 {
        [(q + 1, r - 1), (q + 1, r), (q, r + 1), (q - 1, r), (q - 1, r - 1), (q, r - 1)]
    } else {
        [(q + 1, r), (q + 1, r + 1), (q, r + 1), (q - 1, r + 1), (q - 1, r), (q, r - 1)]
    }
}

/// odd-q 육각 격자의 정확한 육각 거리.
pub fn hex_dist(a: Pos, b: Pos) -> i32 {
    let az = a.1 - ((a.0 - (a.0 & 1)) / 2);
    let bz = b.1 - ((b.0 - (b.0 & 1)) / 2);
    let dx = (a.0 - b.0).abs();
    let dz = (az - bz).abs();
    let dy = ((-a.0 - az) - (-b.0 - bz)).abs();
    (dx + dy + dz) / 2
}

pub fn sector_code(p: Pos) -> String {
    let col = (p.0 * SECTOR_COLS / WW).clamp(0, SECTOR_COLS - 1);
    let row = (p.1 * SECTOR_ROWS / WH).clamp(0, SECTOR_ROWS - 1);
    let ch = (b'A' + col as u8) as char;
    format!("{ch}{}", row + 1)
}

/// 결정론적 정수 해시 노이즈 (0..1000).
fn hash2(seed: u64, x: i32, y: i32) -> i32 {
    let mut h = seed
        ^ (x as u64).wrapping_mul(0x9e3779b97f4a7c15)
        ^ (y as u64).wrapping_mul(0xbf58476d1ce4e5b9);
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    h = (h ^ (h >> 27)).wrapping_mul(0x94d049bb133111eb);
    ((h ^ (h >> 31)) % 1000) as i32
}

fn value_noise(seed: u64, x: i32, y: i32, scale: i32) -> i32 {
    let gx = x.div_euclid(scale);
    let gy = y.div_euclid(scale);
    let fx = x.rem_euclid(scale);
    let fy = y.rem_euclid(scale);
    let v00 = hash2(seed, gx, gy);
    let v10 = hash2(seed, gx + 1, gy);
    let v01 = hash2(seed, gx, gy + 1);
    let v11 = hash2(seed, gx + 1, gy + 1);
    let top = v00 * (scale - fx) + v10 * fx;
    let bot = v01 * (scale - fx) + v11 * fx;
    (top * (scale - fy) + bot * fy) / (scale * scale)
}

fn fbm(seed: u64, x: i32, y: i32) -> i32 {
    (value_noise(seed, x, y, 12) * 55
        + value_noise(seed ^ 0x1234, x, y, 6) * 30
        + value_noise(seed ^ 0x5678, x, y, 3) * 15)
        / 100
}

/// 지형 위에서 두 거점 사이에 도로를 깐다 (평지 우선, 산맥/해역 우회, 기존 도로 합류 선호).
fn carve_hex_road(terrain: &mut [Terrain], road: &mut [bool], from: Pos, to: Pos) {
    let mut dist = vec![u32::MAX; HEX_COUNT];
    let mut prev = vec![usize::MAX; HEX_COUNT];
    let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
    let start = idx(from);
    let goal = idx(to);
    dist[start] = 0;
    heap.push(Reverse((0, start)));

    while let Some(Reverse((d, u))) = heap.pop() {
        if d > dist[u] {
            continue;
        }
        if u == goal {
            break;
        }
        let up = ((u as i32) % WW, (u as i32) / WW);
        for np in hex_neighbors(up) {
            if !in_world(np) {
                continue;
            }
            let v = idx(np);
            let cost = if v == goal {
                1
            } else if road[v] {
                2
            } else {
                match terrain[v] {
                    Terrain::Plains => 4,
                    Terrain::Forest => 7,
                    Terrain::Hill => 9,
                    Terrain::Mountain => 55, // 꼭 필요할 때만 협곡 길목으로 뚫음
                    Terrain::Chasm => 120,
                }
            };
            let nd = d + cost;
            if nd < dist[v] {
                dist[v] = nd;
                prev[v] = u;
                heap.push(Reverse((nd, v)));
            }
        }
    }

    if prev[goal] == usize::MAX {
        return;
    }
    let mut cur = goal;
    while cur != start {
        if !terrain[cur].passable() {
            terrain[cur] = Terrain::Hill;
        }
        road[cur] = true;
        cur = prev[cur];
    }
    road[start] = true;
}

impl World {
    pub fn new(seed: u64) -> World {
        let mut rng = Rng::new(seed ^ 0x776f726c64);
        let mut terrain = vec![Terrain::Plains; HEX_COUNT];
        let mut road = vec![false; HEX_COUNT];

        // 1. 유기적 대륙 지형 생성 (해역/불모지, 산맥, 숲, 고지, 평지)
        for r in 0..WH {
            for q in 0..WW {
                // 외곽 2~4칸으로 갈수록 해역/불모지 확률 증가 (자연스러운 대륙 윤곽)
                let edge_x = q.min(WW - 1 - q);
                let edge_y = r.min(WH - 1 - r);
                let edge_pen = if edge_y < 3 {
                    (3 - edge_y) * 140
                } else if edge_x < 2 {
                    (2 - edge_x) * 120
                } else {
                    0
                };
                let elev = fbm(seed ^ 0xa11ce, q, r) - edge_pen;
                let moist = fbm(seed ^ 0xb0b0, q + 17, r + 31);
                let ridge = (fbm(seed ^ 0xcafe, q * 2, r) - 500).abs();

                let t = if elev < 210 {
                    Terrain::Chasm
                } else if elev > 690 || (ridge < 42 && elev > 420 && q > 6 && q < WW - 6) {
                    Terrain::Mountain
                } else if elev > 575 {
                    Terrain::Hill
                } else if moist > 530 - (WW - q) * 2 {
                    // 서부/중앙에 숲이 더 풍부해 게릴라 은신에 유리
                    Terrain::Forest
                } else {
                    Terrain::Plains
                };
                terrain[idx((q, r))] = t;
            }
        }

        // 2. 10×6 매크로 구역에 거점 48~54개 배치 (서→중→동 리듬)
        let mut sites: Vec<Site> = Vec::new();
        let mut site_at = vec![None; HEX_COUNT];
        let home_row = 2 + rng.below(2) as i32;
        let enemy_row = 2 + rng.below(2) as i32;
        let fob_row = (home_row + rng.below(3) as i32 - 1).clamp(1, SECTOR_ROWS - 2);

        let cell_w = WW / SECTOR_COLS; // 8
        let cell_h = WH / SECTOR_ROWS; // 8

        for sy in 0..SECTOR_ROWS {
            for sx in 0..SECTOR_COLS {
                let forced = (sx == 0 && sy == home_row)
                    || (sx == SECTOR_COLS - 1 && sy == enemy_row)
                    || (sx == 2 && sy == fob_row);
                if !forced && rng.below(100) < 16 {
                    continue;
                }
                let base_q = sx * cell_w + 2 + rng.below((cell_w - 3).max(1) as u32) as i32;
                let base_r = sy * cell_h + 2 + rng.below((cell_h - 3).max(1) as u32) as i32;
                let mut pos = (base_q.clamp(2, WW - 3), base_r.clamp(3, WH - 4));

                // 해역/산맥에 걸리면 근처 육지로 살짝 옮기고, 없으면 평지/고지로 정리.
                if !terrain[idx(pos)].passable() {
                    if let Some(near) = hex_neighbors(pos)
                        .into_iter()
                        .find(|&n| in_world(n) && terrain[idx(n)].passable())
                    {
                        pos = near;
                    } else if forced {
                        terrain[idx(pos)] = Terrain::Plains;
                    } else {
                        continue;
                    }
                }
                if site_at[idx(pos)].is_some() {
                    continue;
                }

                let (kind, owner) = if sx == 0 && sy == home_row {
                    (SiteKind::Hq(Side::Brood), Some(Side::Brood))
                } else if sx == SECTOR_COLS - 1 && sy == enemy_row {
                    (SiteKind::Hq(Side::Empire), Some(Side::Empire))
                } else if sx == 2 && sy == fob_row {
                    (SiteKind::Fob, Some(Side::Brood))
                } else {
                    pick_site_kind(sx, terrain[idx(pos)], &mut rng)
                };
                if kind == SiteKind::Ridge {
                    terrain[idx(pos)] = Terrain::Hill;
                } else if kind == SiteKind::Hideout {
                    terrain[idx(pos)] = Terrain::Forest;
                }

                let id = sites.len();
                let code = format!("{}{}", (b'A' + sx as u8) as char, sy + 1);
                sites.push(Site { pos, kind, owner, code, col: sx, row: sy });
                site_at[idx(pos)] = Some(id);
            }
        }

        // 거점이 최소 44개는 되도록 보강
        for sy in 1..(SECTOR_ROWS - 1) {
            for sx in 1..(SECTOR_COLS - 1) {
                if sites.len() >= 48 {
                    break;
                }
                let pos = (sx * cell_w + 4, sy * cell_h + 4);
                if site_at[idx(pos)].is_some() {
                    continue;
                }
                if !terrain[idx(pos)].passable() {
                    terrain[idx(pos)] = Terrain::Plains;
                }
                let (kind, owner) = pick_site_kind(sx, terrain[idx(pos)], &mut rng);
                let id = sites.len();
                let code = format!("{}{}", (b'A' + sx as u8) as char, sy + 1);
                sites.push(Site { pos, kind, owner, code, col: sx, row: sy });
                site_at[idx(pos)] = Some(id);
            }
        }

        ensure_site_kind(&mut sites, SiteKind::Relay, Some(Side::Empire), 5, 8, 3);
        ensure_site_kind(&mut sites, SiteKind::Landing, Some(Side::Empire), 8, 9, 2);
        ensure_site_kind(&mut sites, SiteKind::Resource, None, 3, 6, 5);

        // 3. 거점들을 잇는 제국/전략 도로망 깔기 (MST + 우회로 35%)
        let mut candidates: Vec<(usize, usize, i32)> = Vec::new();
        for i in 0..sites.len() {
            for j in (i + 1)..sites.len() {
                let d = hex_dist(sites[i].pos, sites[j].pos);
                if d <= 16 {
                    candidates.push((i, j, d));
                }
            }
        }
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
        for (a, b, d) in candidates {
            let (ra, rb) = (root(&mut group, a), root(&mut group, b));
            if ra != rb {
                group[ra] = rb;
                edges.push((a, b));
            } else if d <= 12 && rng.below(100) < 28 {
                spare.push((a, b));
            }
        }
        for i in 1..sites.len() {
            let (r0, ri) = (root(&mut group, 0), root(&mut group, i));
            if r0 != ri {
                if let Some(best) = (0..sites.len())
                    .filter(|&j| root(&mut group, j) == r0)
                    .min_by_key(|&j| hex_dist(sites[i].pos, sites[j].pos))
                {
                    let rb = root(&mut group, best);
                    group[ri] = rb;
                    edges.push((i, best));
                }
            }
        }
        edges.extend(spare);

        for (a, b) in edges {
            carve_hex_road(&mut terrain, &mut road, sites[a].pos, sites[b].pos);
        }

        // 4. 초기 부대 배치
        let mut forces = Vec::new();
        let brood_hq = sites.iter().position(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap();
        let empire_hq = sites.iter().position(|s| s.kind == SiteKind::Hq(Side::Empire)).unwrap();

        let base_cs = (seed % 80) as u16;
        let squad = vec![
            Trooper::with_callsign(Gene::Sniper, base_cs),
            Trooper::with_callsign(Gene::Burst, base_cs + 1),
            Trooper::with_callsign(Gene::Burst, base_cs + 2),
            Trooper::with_callsign(Gene::Burrow, base_cs + 3),
            Trooper::with_callsign(Gene::Burrow, base_cs + 4),
            Trooper::with_callsign(Gene::Plain, base_cs + 5),
        ];
        let next_callsign = base_cs + 6;

        // 0번: 플레이어 정예 특수부대
        forces.push(Force {
            side: Side::Brood,
            role: ForceRole::Special,
            pos: sites[brood_hq].pos,
            size: squad.len() as u32,
            order: Order::Hold,
            duty: Duty::None,
            progress: 0,
            alive: true,
        });

        // 아군 AI 일반군
        forces.push(make_force(Side::Brood, ForceRole::BroodAi, sites[brood_hq].pos, 8, Duty::Garrison));
        let mut brood_spawned = 0;
        for s in &sites {
            if s.kind == SiteKind::Fob {
                forces.push(make_force(Side::Brood, ForceRole::BroodAi, s.pos, 8, Duty::Garrison));
                brood_spawned += 1;
            } else if s.owner == Some(Side::Brood) && s.kind != SiteKind::Hq(Side::Brood) && brood_spawned < 6 {
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
                    if patrols < 4 {
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
            terrain,
            road,
            site_at,
            territory: vec![None; HEX_COUNT],
            brood_supply: vec![false; HEX_COUNT],
            sites,
            forces,
            squad,
            tick: 0,
            selected: None,
            target: None,
            preview_proposal: None,
            clash: None,
            victory: None,
            stop_reason: StopReason::None,
            proposals: Vec::new(),
            events: Vec::new(),
            biomass: 30,
            research_pct: 5,
            battles_fought: 0,
            battles_won: 0,
            total_kills: 0,
            next_callsign,
            last_briefing: None,
            rng,
        };
        world.recompute_territory();
        world.recompute_supply();
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

    pub fn terrain_at(&self, p: Pos) -> Terrain {
        if in_world(p) { self.terrain[idx(p)] } else { Terrain::Chasm }
    }

    pub fn has_road(&self, p: Pos) -> bool {
        in_world(p) && self.road[idx(p)]
    }

    pub fn site_index_at(&self, p: Pos) -> Option<usize> {
        if in_world(p) { self.site_at[idx(p)] } else { None }
    }

    pub fn walkable(&self, p: Pos) -> bool {
        in_world(p) && self.terrain[idx(p)].passable()
    }

    pub fn forces_at(&self, p: Pos) -> impl Iterator<Item = usize> + '_ {
        (0..self.forces.len()).filter(move |&i| self.forces[i].alive && self.forces[i].pos == p)
    }

    /// 부대 `role`이 `p` 헥스로 들어가는 데 드는 이동 틱.
    /// 도로가 압도적으로 빠르므로 제국 보급대·정규군은 자연스럽게 도로를 탄다.
    pub fn hex_step_ticks(&self, role: ForceRole, size: u32, p: Pos) -> u32 {
        let base = if role == ForceRole::Special { 4 } else { 5 } + size / 4;
        if self.has_road(p) {
            return base;
        }
        match self.terrain_at(p) {
            Terrain::Plains => {
                if role == ForceRole::Special { (base * 3) / 2 } else { base * 2 }
            }
            Terrain::Forest | Terrain::Hill => {
                if role == ForceRole::Special { base * 2 } else { base * 4 }
            }
            Terrain::Mountain | Terrain::Chasm => u32::MAX / 4,
        }
    }

    /// Civ식 영토 소유를 거점 기준으로 재계산한다 (거점 반경 3헥스 이내 가장 가까운 점령 거점).
    pub fn recompute_territory(&mut self) {
        self.territory.fill(None);
        let mut best_d = vec![u8::MAX; HEX_COUNT];
        for s in &self.sites {
            let Some(owner) = s.owner else { continue };
            let radius = match s.kind {
                SiteKind::Hq(_) => 4,
                SiteKind::Outpost | SiteKind::Fob | SiteKind::Landing => 3,
                _ => 2,
            };
            let min_q = (s.pos.0 - radius).max(0);
            let max_q = (s.pos.0 + radius).min(WW - 1);
            let min_r = (s.pos.1 - radius).max(0);
            let max_r = (s.pos.1 + radius).min(WH - 1);
            for r in min_r..=max_r {
                for q in min_q..=max_q {
                    let p = (q, r);
                    let i = idx(p);
                    if !self.terrain[i].passable() {
                        continue;
                    }
                    let d = hex_dist(s.pos, p) as u8;
                    if d <= radius as u8 && d < best_d[i] {
                        best_d[i] = d;
                        self.territory[i] = Some(owner);
                    }
                }
            }
        }
    }

    /// 아군 보급권을 계산한다. 도로를 타면 비용 1, 평지 2, 숲/고지 3으로 도로에서 보급이 훨씬 멀리 닿는다.
    pub fn recompute_supply(&mut self) {
        self.brood_supply.fill(false);
        let mut dist = vec![u32::MAX; HEX_COUNT];
        let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
        for s in &self.sites {
            if s.owner == Some(Side::Brood) && matches!(s.kind, SiteKind::Hq(Side::Brood) | SiteKind::Fob) {
                let i = idx(s.pos);
                dist[i] = 0;
                heap.push(Reverse((0, i)));
            }
        }
        // 적이 서 있는 헥스는 보급이 통과하지 못한다.
        let mut enemy_block = vec![false; HEX_COUNT];
        for f in &self.forces {
            if f.alive && f.side == Side::Empire {
                enemy_block[idx(f.pos)] = true;
            }
        }
        while let Some(Reverse((d, u))) = heap.pop() {
            if d > dist[u] || d > SUPPLY_LIMIT {
                continue;
            }
            self.brood_supply[u] = true;
            let up = ((u as i32) % WW, (u as i32) / WW);
            for np in hex_neighbors(up) {
                if !self.walkable(np) {
                    continue;
                }
                let v = idx(np);
                if enemy_block[v] {
                    continue;
                }
                let step = if self.road[v] {
                    1
                } else {
                    match self.terrain[v] {
                        Terrain::Plains => 2,
                        _ => 3,
                    }
                };
                let nd = d + step;
                if nd <= SUPPLY_LIMIT && nd < dist[v] {
                    dist[v] = nd;
                    heap.push(Reverse((nd, v)));
                }
            }
        }
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

    pub fn special_in_supply(&self) -> bool {
        let sp = self.special();
        sp.alive && in_world(sp.pos) && self.brood_supply[idx(sp.pos)]
    }

    /// 부대 역할·크기를 반영한 최소 시간(틱) 육각 다익스트라 경로 탐색.
    /// 도로 비용이 낮기 때문에 정규군·보급대는 자연스럽게 도로를 탄다.
    pub fn route_for(&self, role: ForceRole, size: u32, from: Pos, to: Pos) -> Option<(Vec<Pos>, u32)> {
        if !self.walkable(from) || !self.walkable(to) {
            return None;
        }
        if from == to {
            return Some((Vec::new(), 0));
        }
        let mut dist = vec![u32::MAX; HEX_COUNT];
        let mut prev = vec![usize::MAX; HEX_COUNT];
        let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
        let start = idx(from);
        let goal = idx(to);
        dist[start] = 0;
        heap.push(Reverse((0, start)));

        while let Some(Reverse((d, u))) = heap.pop() {
            if d > dist[u] {
                continue;
            }
            if u == goal {
                let mut path = Vec::new();
                let mut cur = goal;
                while cur != start {
                    path.push(((cur as i32) % WW, (cur as i32) / WW));
                    cur = prev[cur];
                }
                path.reverse();
                return Some((path, d));
            }
            let up = ((u as i32) % WW, (u as i32) / WW);
            for np in hex_neighbors(up) {
                if !self.walkable(np) {
                    continue;
                }
                let v = idx(np);
                let step = self.hex_step_ticks(role, size, np);
                let nd = d.saturating_add(step);
                if nd < dist[v] {
                    dist[v] = nd;
                    prev[v] = u;
                    heap.push(Reverse((nd, v)));
                }
            }
        }
        None
    }

    pub fn route(&self, from: Pos, to: Pos) -> Option<Vec<Pos>> {
        let sp = self.special();
        self.route_for(ForceRole::Special, sp.size, from, to).map(|(p, _)| p)
    }

    pub fn path_ticks(&self, role: ForceRole, size: u32, path: &[Pos]) -> u32 {
        path.iter().map(|&p| self.hex_step_ticks(role, size, p)).sum()
    }

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

    /// 비선택 상태 클릭은 조사만 하고, 특수부대를 클릭한 뒤 목적지 헥스를 찍으면 명령 메뉴가 열린다.
    /// 통행 불가 헥스(산맥/해역)를 찍으면 선택을 풀지 않고 false를 돌려 UI가 이동 불가 표시를 띄우게 한다.
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
        if self.forces[sp].pos == p {
            self.selected = None;
            self.target = None;
            return true;
        }
        if !self.walkable(p) {
            return false;
        }
        if self.route(self.forces[sp].pos, p).is_some_and(|path| !path.is_empty()) {
            let changed = self.target != Some(p);
            self.target = Some(p);
            return changed;
        }
        false
    }

    pub fn can_garrison(&self) -> bool {
        self.target.is_some_and(|t| self.site_index_at(t).is_some())
    }

    pub fn command(&mut self, command: Command) -> bool {
        let (Some(s), Some(target)) = (self.selected, self.target) else { return false };
        if command == Command::Garrison && !self.can_garrison() {
            return false;
        }
        self.issue_special_order(s, target, command)
    }

    pub fn accept_proposal(&mut self, i: usize) -> bool {
        let Some(prop) = self.proposals.get(i).cloned() else { return false };
        let s = self.special_index();
        if !self.forces[s].alive {
            return false;
        }
        let cmd = if prop.command == Command::Garrison && self.site_index_at(prop.target).is_none() {
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
        self.forces[s].order = if path.is_empty() { Order::Hold } else { Order::Move(path) };
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

    fn arrive(&mut self, i: usize) {
        self.forces[i].order = Order::Hold;
        if let Duty::Scout(a, b) = self.forces[i].duty {
            let next = if self.forces[i].pos == b { a } else { b };
            let role = self.forces[i].role;
            let size = self.forces[i].size;
            if let Some((path, _)) = self.route_for(role, size, self.forces[i].pos, next).filter(|(p, _)| !p.is_empty()) {
                self.forces[i].order = Order::Move(path);
            }
            return;
        }
        let pos = self.forces[i].pos;
        let side = self.forces[i].side;
        let has_foe = self.forces.iter().any(|f| f.alive && f.side != side && f.pos == pos);
        if !has_foe {
            if let Some(si) = self.site_index_at(pos) {
                if self.sites[si].owner != Some(side) {
                    self.sites[si].owner = Some(side);
                    let code = self.sites[si].code.clone();
                    let label = self.sites[si].kind.label();
                    let who = if side == Side::Brood { "아군 확보" } else { "제국 점령" };
                    let alert = side == Side::Empire || self.forces[i].role == ForceRole::Special;
                    self.recompute_territory();
                    self.recompute_supply();
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

    fn resolve_ai_clash(&mut self, a: usize, b: usize) {
        let pos = self.forces[b].pos;
        let a_g = if self.forces[a].duty == Duty::Garrison { 2 } else { 0 };
        let b_g = if self.forces[b].duty == Duty::Garrison { 2 } else { 0 };
        let a_pow = self.forces[a].size + a_g + self.rng.below(3);
        let b_pow = self.forces[b].size + b_g + self.rng.below(3);

        let (winner, loser) = if a_pow >= b_pow { (a, b) } else { (b, a) };
        let loss = (self.forces[loser].size / 2).max(1);
        let win_loss = (loss / 2).min(self.forces[winner].size.saturating_sub(1));
        self.forces[winner].size = self.forces[winner].size.saturating_sub(win_loss).max(1);
        self.forces[loser].size = self.forces[loser].size.saturating_sub(loss);

        let loc = match self.site_index_at(pos) {
            Some(si) => self.sites[si].code.clone(),
            None => sector_code(pos),
        };
        if self.forces[loser].size == 0 {
            self.forces[loser].alive = false;
            self.forces[loser].order = Order::Hold;
            let tag = if self.forces[winner].side == Side::Brood { "아군 승" } else { "제국 승" };
            self.push_event(pos, format!("{loc} 교전 ({tag})"), self.forces[winner].side == Side::Empire);
        } else {
            self.forces[loser].order = Order::Hold;
            self.push_event(pos, format!("{loc} 소규모 교전"), false);
        }
        self.forces[a].order = Order::Hold;
        self.recompute_supply();
    }

    fn plan_ai_turn(&mut self) {
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

        // 제국 보급대: 도로 비용이 낮으므로 자연스럽게 도로망을 따라 전초/중계탑으로 이동한다.
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
                if let Some((path, _)) = self.route_for(ForceRole::EmpireConvoy, 4, src, dst).filter(|(p, _)| !p.is_empty()) {
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
                    let code = self.site_index_at(dst).map_or_else(|| sector_code(dst), |si| self.sites[si].code.clone());
                    self.push_event(src, format!("{code} 방면 제국 보급대 출발"), false);
                }
            }
        }

        // 제국 순찰대 이동
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
                let mut near: Vec<Pos> = empire_sites.iter().copied().filter(|&p| p != cur && hex_dist(p, cur) <= 24).collect();
                if near.is_empty() {
                    near = empire_sites.clone();
                }
                let pick = near[self.rng.below(near.len() as u32) as usize];
                let size = self.forces[i].size;
                if let Some((path, _)) = self.route_for(ForceRole::EmpirePatrol, size, cur, pick).filter(|(p, _)| !p.is_empty()) {
                    self.forces[i].order = Order::Move(path);
                }
            }
        }

        // 자율 아군 AI 일반군 이동
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
            let at_hq = self.site_index_at(self.forces[i].pos).is_some_and(|si| self.sites[si].kind == SiteKind::Hq(Side::Brood));
            if at_hq || movers >= 3 {
                continue;
            }
            let cur = self.forces[i].pos;
            let size = self.forces[i].size;
            if let Some(&best) = targets.iter().min_by_key(|&&p| hex_dist(cur, p)) {
                if let Some((path, _)) = self.route_for(ForceRole::BroodAi, size, cur, best).filter(|(p, _)| !p.is_empty()) {
                    self.forces[i].order = Order::Move(path);
                    self.forces[i].duty = Duty::None;
                    movers += 1;
                }
            }
        }
    }

    /// 지휘망(AI)이 3개 작전 축에서 주 권고 1안 + 대안 2안을 계산한다.
    pub fn compute_proposals(&mut self) {
        let sp = self.special();
        if !sp.alive {
            self.proposals.clear();
            return;
        }
        let from = sp.pos;
        let size = sp.size;
        let mut scored: Vec<(i32, Proposal)> = Vec::new();

        // 축 1: 공세/협공 지원 (제국 보급대 매복 차단 또는 전초 타격)
        let convoy_target = self
            .forces
            .iter()
            .filter(|f| f.alive && f.role == ForceRole::EmpireConvoy)
            .min_by_key(|f| hex_dist(from, f.pos))
            .map(|f| match &f.order {
                Order::Move(p) if p.len() > 2 => p[p.len() / 2],
                _ => f.pos,
            });
        if let Some(t) = convoy_target {
            if let Some((_, eta)) = self.route_for(ForceRole::Special, size, from, t) {
                let code = sector_code(t);
                scored.push((
                    100 - (eta as i32 / 8),
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
            .min_by_key(|(_, s)| hex_dist(from, s.pos))
        {
            if let Some((_, eta)) = self.route_for(ForceRole::Special, size, from, s.pos) {
                scored.push((
                    90 - (eta as i32 / 8),
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

        // 축 2: 방어/보존 (위태로운 자원지·전진기지 주둔)
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
                    .map(|f| hex_dist(f.pos, s.pos))
                    .min()
                    .unwrap_or(99);
                foe_d * 2 + hex_dist(from, s.pos) / 2
            });
        if let Some((si, s)) = threatened_site {
            if let Some((_, eta)) = self.route_for(ForceRole::Special, size, from, s.pos) {
                scored.push((
                    95 - (eta as i32 / 8),
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

        // 축 3: 교란/첩보 (중계탑 타격 또는 착륙장 기습 / 고지 정찰)
        let disrupt_site = self
            .sites
            .iter()
            .enumerate()
            .filter(|(_, s)| s.owner == Some(Side::Empire) && matches!(s.kind, SiteKind::Relay | SiteKind::Landing))
            .min_by_key(|(_, s)| hex_dist(from, s.pos));
        if let Some((si, s)) = disrupt_site {
            if let Some((_, eta)) = self.route_for(ForceRole::Special, size, from, s.pos) {
                let (title, reason) = if s.kind == SiteKind::Relay {
                    (format!("{} 중계탑 타격", s.code), "구역 제국 보고망 차단 · 증거 은폐".to_string())
                } else {
                    (format!("{} 착륙장 기습", s.code), "제국 증원 유입 지연".to_string())
                };
                scored.push((
                    92 - (eta as i32 / 8),
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
            .min_by_key(|(_, s)| hex_dist(from, s.pos))
        {
            if let Some((_, eta)) = self.route_for(ForceRole::Special, size, from, s.pos) {
                scored.push((
                    80 - (eta as i32 / 8),
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

    pub fn tick(&mut self) {
        if self.clash.is_some() || self.victory.is_some() {
            return;
        }
        self.stop_reason = StopReason::None;
        self.tick += 1;

        for i in 0..self.forces.len() {
            if !self.forces[i].alive {
                continue;
            }
            let next = match &self.forces[i].order {
                Order::Move(path) => match path.first().copied() {
                    Some(p) => p,
                    None => {
                        self.arrive(i);
                        continue;
                    }
                },
                Order::Hold => continue,
            };
            let need = self.hex_step_ticks(self.forces[i].role, self.forces[i].size, next);
            self.forces[i].progress += 1;
            if self.forces[i].progress < need {
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
                    let loc = self.site_index_at(next).map_or_else(|| sector_code(next), |si| self.sites[si].code.clone());
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

        if self.tick % TICKS_PER_DAY == 0 {
            self.recompute_supply();
            self.plan_ai_turn();
            self.compute_proposals();
        }
    }

    pub fn squad_counts(&self) -> [usize; 4] {
        let mut c = [0usize; 4];
        for t in &self.squad {
            match t.gene {
                Gene::Sniper => c[0] += 1,
                Gene::Burst => c[1] += 1,
                Gene::Burrow => c[2] += 1,
                Gene::Plain => c[3] += 1,
            }
        }
        c
    }

    pub fn heal_needed(&self) -> (u32, u32) {
        let missing: u32 = self.squad.iter().map(|t| (t.max_hp - t.hp).max(0) as u32).sum();
        (missing, missing * HEAL_COST_PER_HP)
    }

    pub fn heal_squad(&mut self) -> bool {
        if self.clash.is_some() || !self.special_in_supply() || !self.special().alive {
            return false;
        }
        let mut healed = false;
        for t in &mut self.squad {
            while t.hp < t.max_hp && self.biomass >= HEAL_COST_PER_HP {
                t.hp += 1;
                self.biomass -= HEAL_COST_PER_HP;
                healed = true;
            }
        }
        healed
    }

    pub fn regene_trooper(&mut self, idx: usize, gene: Gene) -> bool {
        if self.clash.is_some() || !self.special_in_supply() || !self.special().alive {
            return false;
        }
        let Some(t) = self.squad.get_mut(idx) else { return false };
        if t.gene == gene || self.biomass < REGENE_COST {
            return false;
        }
        t.gene = gene;
        self.biomass -= REGENE_COST;
        true
    }

    pub fn recruit_trooper(&mut self) -> bool {
        if self.clash.is_some() || !self.special_in_supply() || !self.special().alive {
            return false;
        }
        if self.squad.len() >= MAX_SQUAD || self.biomass < RECRUIT_COST {
            return false;
        }
        self.biomass -= RECRUIT_COST;
        let cs = self.next_callsign;
        self.next_callsign = self.next_callsign.wrapping_add(1);
        self.squad.push(Trooper::with_callsign(Gene::Plain, cs));
        self.forces[0].size = self.squad.len() as u32;
        true
    }

    /// 현재 충돌(`clash`)을 실제 전술 전투 설정으로 변환한다 (헥스 지형·매복·주둔·중계·합동전·전투 목표·베테랑 계급 반영).
    pub fn battle_config(&self) -> Option<BattleConfig> {
        let (sp_idx, foe_idx) = self.clash?;
        let sp = &self.forces[sp_idx];
        let foe = &self.forces[foe_idx];
        if self.squad.is_empty() || !foe.alive {
            return None;
        }

        let sp_terrain = self.terrain_at(sp.pos);
        let ambush = sp.duty == Duty::Ambush || sp_terrain == Terrain::Forest;
        let garrison = (sp.duty == Duty::Garrison && self.site_index_at(sp.pos).is_some()) || sp_terrain == Terrain::Hill;
        let site_kind = self.site_index_at(foe.pos).map(|si| self.sites[si].kind);
        let objective = if site_kind == Some(SiteKind::Relay) {
            BattleObjective::DestroyRelay
        } else if foe.role == ForceRole::EmpireConvoy {
            BattleObjective::AmbushConvoy
        } else {
            BattleObjective::Eliminate
        };
        let relay_cut = objective != BattleObjective::DestroyRelay
            && !self.sites.iter().any(|s| {
                s.kind == SiteKind::Relay && s.owner == Some(Side::Empire) && hex_dist(s.pos, foe.pos) <= 14
            });
        let allied_total: u32 = self
            .forces
            .iter()
            .filter(|f| {
                f.alive
                    && f.role == ForceRole::BroodAi
                    && (hex_dist(f.pos, sp.pos) <= 2 || hex_dist(f.pos, foe.pos) <= 2)
            })
            .map(|f| f.size)
            .sum();
        let allied_ai = if allied_total > 0 { ((allied_total + 1) / 3).clamp(1, 3) as usize } else { 0 };

        let mut empire = Vec::new();
        let target_n = foe.size.clamp(3, 8) as usize;
        let bseed = self.seed ^ self.tick.wrapping_mul(0x9e3779b97f4a7c15) ^ (foe_idx as u64);
        let counter = [Class::Sensor, Class::Smoker, Class::Shield][(bseed % 3) as usize];
        match foe.role {
            ForceRole::EmpireConvoy => {
                empire.push(Class::Shield);
                while empire.len() < target_n {
                    empire.push(Class::Trooper);
                }
            }
            ForceRole::EmpirePatrol => {
                empire.push(Class::Sensor);
                if !relay_cut && target_n >= 4 {
                    empire.push(Class::Relay);
                }
                while empire.len() < target_n {
                    empire.push(Class::Trooper);
                }
            }
            _ => {
                if objective == BattleObjective::DestroyRelay || !relay_cut {
                    empire.push(Class::Relay);
                }
                if objective == BattleObjective::DestroyRelay && target_n >= 5 {
                    empire.push(Class::Relay);
                }
                if target_n >= 4 {
                    empire.push(counter);
                }
                if target_n >= 7 {
                    empire.push(Class::Shield);
                }
                while empire.len() < target_n {
                    empire.push(Class::Trooper);
                }
            }
        }

        let title = match self.site_index_at(foe.pos) {
            Some(si) => format!("{} {} 전투", self.sites[si].code, self.sites[si].kind.label()),
            None => format!("{} {} 교전", sector_code(foe.pos), self.terrain_at(foe.pos).label()),
        };
        let mut tags = Vec::new();
        if objective != BattleObjective::Eliminate {
            tags.push(format!("목표: {}", objective.label()));
        }
        if sp.duty == Duty::Ambush {
            tags.push("매복 기습".to_string());
        } else if sp_terrain == Terrain::Forest {
            tags.push("숲 기습".to_string());
        }
        if sp.duty == Duty::Garrison && self.site_index_at(sp.pos).is_some() {
            tags.push("주둔(+엄폐)".to_string());
        } else if sp_terrain == Terrain::Hill {
            tags.push("고지 엄폐".to_string());
        }
        if relay_cut { tags.push("중계 차단".to_string()); }
        if allied_ai > 0 { tags.push(format!("아군 일반군 +{allied_ai}")); }

        let special = self.squad.iter().enumerate().map(|(slot, t)| (slot, t.gene, t.hp)).collect();
        let member_meta = self.squad.iter().map(|t| (t.rank(), t.callsign_id, t.max_hp)).collect();
        let terrain_biome = match self.terrain_at(foe.pos) {
            Terrain::Forest => BattleBiome::Forest,
            Terrain::Hill => BattleBiome::Hill,
            _ if self.has_road(foe.pos) => BattleBiome::Road,
            _ => BattleBiome::Skirmish,
        };
        let biome = match self.site_index_at(foe.pos) {
            Some(si) if matches!(self.sites[si].kind, SiteKind::Outpost | SiteKind::Relay | SiteKind::Landing | SiteKind::Hq(_)) => {
                BattleBiome::Outpost
            }
            _ => terrain_biome,
        };

        Some(BattleConfig {
            seed: bseed,
            special,
            member_meta,
            allied_ai,
            empire,
            ambush,
            garrison,
            relay_cut,
            biome,
            objective,
            title,
            tags,
        })
    }

    pub fn resolve_battle(&mut self, won: bool, allied_losses: u32, empire_losses: u32, packed_hp: u32) -> bool {
        self.resolve_battle_with_kills(won, allied_losses, empire_losses, packed_hp, 0)
    }

    pub fn resolve_battle_with_kills(
        &mut self,
        won: bool,
        allied_losses: u32,
        empire_losses: u32,
        packed_hp: u32,
        packed_kills: u32,
    ) -> bool {
        let Some((sp_idx, foe_idx)) = self.clash.take() else { return false };
        let foe_pos = self.forces[foe_idx].pos;
        let foe_role = self.forces[foe_idx].role;
        let sp_pos = self.forces[sp_idx].pos;
        let site_kind = self.site_index_at(foe_pos).map(|si| self.sites[si].kind);
        let objective = if site_kind == Some(SiteKind::Relay) {
            BattleObjective::DestroyRelay
        } else if foe_role == ForceRole::EmpireConvoy {
            BattleObjective::AmbushConvoy
        } else {
            BattleObjective::Eliminate
        };

        let before = self.squad.len();
        let mut survivors = Vec::new();
        let mut promotions = Vec::new();
        for (i, mut t) in self.squad.drain(..).enumerate() {
            let hp = ((packed_hp >> (i * 4)) & 0xf) as i32;
            let k = (packed_kills >> (i * 4)) & 0xf;
            if hp > 0 {
                let prev_rank = t.rank();
                t.hp = hp.min(t.max_hp);
                t.battles += 1;
                t.kills += k;
                let new_rank = t.rank();
                t.sync_max_hp();
                if new_rank > prev_rank {
                    let hp_note = if rank_hp_bonus(new_rank) > rank_hp_bonus(prev_rank) {
                        ", 최대체력 +1"
                    } else {
                        ""
                    };
                    promotions.push(format!(
                        "{} {} → {} 진급 (조준 +{}{hp_note})",
                        t.callsign(),
                        t.name(),
                        t.rank_label(),
                        t.aim_bonus()
                    ));
                }
                survivors.push(t);
            }
        }
        let kia = before.saturating_sub(survivors.len());
        self.squad = survivors;
        self.forces[sp_idx].size = self.squad.len() as u32;
        self.forces[sp_idx].alive = !self.squad.is_empty();
        self.forces[sp_idx].order = Order::Hold;

        self.battles_fought += 1;
        if won {
            self.battles_won += 1;
        }
        self.total_kills += empire_losses;

        if allied_losses > 0 {
            if let Some(ally) = self.forces.iter_mut().find(|f| {
                f.alive
                    && f.role == ForceRole::BroodAi
                    && (hex_dist(f.pos, sp_pos) <= 2 || hex_dist(f.pos, foe_pos) <= 2)
            }) {
                ally.size = ally.size.saturating_sub(allied_losses);
                if ally.size == 0 {
                    ally.alive = false;
                }
            }
        }

        let loc = match self.site_index_at(foe_pos) {
            Some(si) => format!("{} {}", self.sites[si].code, self.sites[si].kind.label()),
            None => sector_code(foe_pos),
        };
        let mut captured_site = None;
        let mut biomass_gained = 0;

        if won {
            let rem = self.forces[foe_idx].size.saturating_sub(empire_losses.max(8));
            if rem == 0 {
                self.forces[foe_idx].size = 0;
                self.forces[foe_idx].alive = false;
                self.forces[foe_idx].order = Order::Hold;
                if !self.forces.iter().any(|f| f.alive && f.side == Side::Empire && f.pos == foe_pos) {
                    self.forces[sp_idx].pos = foe_pos;
                    if let Some(si) = self.site_index_at(foe_pos) {
                        let was_empire_hq = self.sites[si].kind == SiteKind::Hq(Side::Empire);
                        self.sites[si].owner = Some(Side::Brood);
                        captured_site = Some(format!("{} {} 점령", self.sites[si].code, self.sites[si].kind.label()));
                        if was_empire_hq {
                            self.victory = Some(Side::Brood);
                        }
                    }
                }
            } else {
                self.forces[foe_idx].size = rem;
            }
            let reward = match objective {
                BattleObjective::AmbushConvoy => 22,
                BattleObjective::DestroyRelay => 16,
                BattleObjective::Eliminate => 12,
            };
            biomass_gained = reward;
            self.biomass += reward;
            let kia_note = if kia > 0 { format!(" · 전사 {kia}") } else { String::new() };
            self.push_event(foe_pos, format!("{loc} 특수부대 승리 (+생체질 {reward}{kia_note})"), false);
        } else {
            self.forces[foe_idx].size = self.forces[foe_idx].size.saturating_sub(empire_losses).max(1);
            self.forces[sp_idx].duty = Duty::None;
            if self.squad.is_empty() {
                self.victory = Some(Side::Empire);
                self.push_event(sp_pos, format!("{loc} 특수부대 전멸"), true);
            } else {
                let kia_note = if kia > 0 { format!(" (전사 {kia})") } else { String::new() };
                self.push_event(sp_pos, format!("{loc} 특수부대 후퇴 생환{kia_note}"), true);
            }
        }

        self.last_briefing = Some(BattleBriefing {
            title: loc,
            objective,
            won,
            survivors: self.squad.len(),
            kia,
            empire_losses,
            biomass_gained,
            captured_site,
            promotions,
        });

        self.recompute_territory();
        self.recompute_supply();
        self.stop_reason = StopReason::None;
        self.compute_proposals();
        true
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
        mix(self.squad.len() as u64);
        for t in &self.squad {
            mix(t.hp as u64 | ((t.gene as u64) << 8) | ((t.battles as u64) << 16) | ((t.kills as u64) << 24));
        }
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

fn pick_site_kind(col: i32, t: Terrain, rng: &mut Rng) -> (SiteKind, Option<Side>) {
    let r = rng.below(100);
    if col <= 2 {
        if r < 45 {
            (SiteKind::Hideout, Some(Side::Brood))
        } else if r < 72 {
            (SiteKind::Choke, Some(Side::Brood))
        } else {
            (SiteKind::Resource, Some(Side::Brood))
        }
    } else if col <= 5 {
        if t == Terrain::Hill && r < 55 {
            (SiteKind::Ridge, None)
        } else if r < 34 {
            (SiteKind::Resource, None)
        } else if r < 60 {
            (SiteKind::Ridge, None)
        } else if r < 82 {
            (SiteKind::Choke, None)
        } else {
            (SiteKind::Relay, Some(Side::Empire))
        }
    } else if col <= 7 {
        if r < 45 {
            (SiteKind::Outpost, Some(Side::Empire))
        } else if r < 75 {
            (SiteKind::Relay, Some(Side::Empire))
        } else if r < 90 {
            (SiteKind::Choke, Some(Side::Empire))
        } else {
            (SiteKind::Resource, Some(Side::Empire))
        }
    } else if r < 42 {
        (SiteKind::Landing, Some(Side::Empire))
    } else if r < 84 {
        (SiteKind::Outpost, Some(Side::Empire))
    } else {
        (SiteKind::Choke, Some(Side::Empire))
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
    fn hex_theater_80x52_is_connected_and_has_civ_territory() {
        for seed in 0..8 {
            let w = World::new(seed);
            assert!(w.sites.len() >= 40 && w.sites.len() <= 64, "seed {seed}: sites={}", w.sites.len());
            for s in &w.sites[1..] {
                assert!(w.route(w.sites[0].pos, s.pos).is_some(), "seed {seed}: unreachable {:?}", s.pos);
            }
            assert!(w.territory.iter().any(|t| *t == Some(Side::Brood)));
            assert!(w.territory.iter().any(|t| *t == Some(Side::Empire)));
            assert!(w.special_in_supply());
            assert_eq!(w.proposals.len(), 3);
        }
    }

    #[test]
    fn roads_are_faster_than_offroad_and_extend_supply() {
        let w = World::new(3);
        let road_hex = (0..HEX_COUNT)
            .map(|i| ((i as i32) % WW, (i as i32) / WW))
            .find(|&p| w.has_road(p))
            .unwrap();
        let forest_hex = (0..HEX_COUNT)
            .map(|i| ((i as i32) % WW, (i as i32) / WW))
            .find(|&p| !w.has_road(p) && w.terrain_at(p) == Terrain::Forest)
            .unwrap();
        assert!(
            w.hex_step_ticks(ForceRole::EmpireConvoy, 4, road_hex)
                < w.hex_step_ticks(ForceRole::EmpireConvoy, 4, forest_hex)
        );
        assert!(
            w.hex_step_ticks(ForceRole::Special, 6, forest_hex)
                < w.hex_step_ticks(ForceRole::EmpireConvoy, 6, forest_hex)
        );
    }

    #[test]
    fn maps_differ_by_seed_and_repeat_for_the_same_seed() {
        assert_eq!(World::new(5).terrain, World::new(5).terrain);
        assert_ne!(World::new(5).terrain, World::new(6).terrain);
    }

    #[test]
    fn clicking_other_hexes_without_selecting_special_does_not_command() {
        let mut w = World::new(3);
        let sp_pos = w.special().pos;
        let other = w.sites.iter().find(|s| s.pos != sp_pos).unwrap().pos;
        assert!(!w.click(other));
        assert!(w.selected.is_none());
        assert!(w.click(sp_pos));
        assert_eq!(w.selected, Some(0));
        // 통행 불가(산맥) 헥스를 눌러도 선택은 풀리지 않고 false를 돌려 UI가 불가 표시를 띄울 수 있게 한다.
        if let Some(mtn) = (0..HEX_COUNT)
            .map(|i| ((i as i32) % WW, (i as i32) / WW))
            .find(|&p| w.terrain_at(p) == Terrain::Mountain)
        {
            assert!(!w.click(mtn));
            assert_eq!(w.selected, Some(0));
            assert!(w.target.is_none());
        }
        assert!(w.click(other));
        assert_eq!(w.target, Some(other));
        assert!(w.command(Command::Move));
        assert!(matches!(w.special().order, Order::Move(_)));
    }

    #[test]
    fn accept_proposal_and_tick_deterministically() {
        let run = || {
            let mut w = World::new(9);
            assert!(w.accept_proposal(0));
            for _ in 0..96 {
                w.tick();
            }
            w.fingerprint()
        };
        assert_eq!(run(), run());
    }
}
