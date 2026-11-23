//! 결정론적 전투 코어. 렌더링도, 시간도, 외부 입력도 모른다.
//! 상태를 바꾸는 입구는 `click`, `burrow`, `end_turn` 셋뿐이라서
//! (시드, 입력 목록)만 있으면 판 전체를 그대로 재현할 수 있다.
#![forbid(unsafe_code)]

pub mod ai;
pub mod rng;
pub mod world;

use rng::Rng;

pub const W: i32 = 28;
pub const H: i32 = 16;
pub const SIGHT: i32 = 14;
pub const AP_PER_TURN: u8 = 2;
pub const COVER_LOW: i32 = 20;
pub const COVER_WALL: i32 = 40;
/// 이 거리까지는 감점 없음. 그 뒤로 칸당 `FALLOFF_PER_TILE`.
pub const FALLOFF_START: i32 = 6;
pub const FALLOFF_PER_TILE: i32 = 3;
/// 화력 개조: 이 거리 안에서는 사격이 행동 1만 쓴다.
pub const BURST_RANGE: i32 = 4;
/// 저격 개조의 사거리.
pub const SNIPER_RANGE: i32 = 14;
/// 저격 개조가 안 움직이고 쏠 때 더해지는 조준.
pub const SNIPER_AIM: i32 = 15;
/// 탐지기가 숨은 유닛을 드러내는 거리. 시선은 필요 없다.
pub const SENSOR_RADIUS: i32 = 6;
/// 연막 너머는 이 거리까지만 보인다.
pub const SMOKE_SIGHT: i32 = 2;
/// 연막을 던질 수 있는 거리.
pub const SMOKE_RANGE: i32 = 10;
/// 연막이 남아 있는 라운드 수.
pub const SMOKE_ROUNDS: u8 = 3;
pub const SMOKE_CHARGES: u8 = 2;
/// 경계 사격 명중률 감점 (이동 표적 대응 사격).
pub const OVERWATCH_PENALTY: i32 = 15;

pub type Pos = (i32, i32);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tile {
    Floor,
    /// 낮은 엄폐물. 시야는 통과, 이동은 불가.
    Low,
    /// 벽. 시야와 이동 모두 차단.
    Wall,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    /// 플레이어.
    Brood,
    /// 인류 제국.
    Empire,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    /// 아군의 몸은 이것 하나다. 병과는 `Gene`으로 정한다.
    Proto,
    Trooper,
    Relay,
    /// 탐지기. 싸우지 못한다. 주변의 숨은 유닛을 드러낸다.
    Sensor,
    /// 방패병. 가장 가까이 보이는 적 쪽으로는 항상 엄폐를 받는다.
    Shield,
    /// 연막병. 연막을 던진다.
    Smoker,
}

/// 아군의 개조.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gene {
    Plain,
    /// 이번 턴에 안 움직였으면 거리 감점이 없고 조준이 오른다.
    Sniper,
    /// 가까운 거리에서는 사격이 행동 1만 쓴다.
    Burst,
    /// 땅에 숨는다. 숨어 있다가 쏘는 사격은 엄폐를 무시한다.
    Burrow,
}

pub struct ClassDef {
    pub glyph: char,
    pub name: &'static str,
    pub hp: i32,
    pub aim: i32,
    pub dmg: i32,
    pub mv: i32,
    /// 0이면 쏘지 못한다.
    pub range: i32,
}

impl Class {
    pub fn def(self) -> &'static ClassDef {
        match self {
            Class::Proto => &ClassDef { glyph: 'ν', name: "원형", hp: 5, aim: 70, dmg: 3, mv: 6, range: 10 },
            Class::Trooper => &ClassDef { glyph: 'h', name: "보병", hp: 5, aim: 60, dmg: 3, mv: 6, range: 10 },
            Class::Relay => &ClassDef { glyph: '&', name: "중계기", hp: 4, aim: 50, dmg: 2, mv: 5, range: 8 },
            Class::Sensor => &ClassDef { glyph: 's', name: "탐지기", hp: 3, aim: 0, dmg: 0, mv: 6, range: 0 },
            Class::Shield => &ClassDef { glyph: 'H', name: "방패병", hp: 6, aim: 55, dmg: 3, mv: 4, range: 8 },
            Class::Smoker => &ClassDef { glyph: 'm', name: "연막병", hp: 5, aim: 60, dmg: 3, mv: 6, range: 10 },
        }
    }
}

#[derive(Clone, Debug)]
pub struct Unit {
    pub side: Side,
    pub class: Class,
    pub gene: Gene,
    pub hp: i32,
    pub pos: Pos,
    pub ap: u8,
    /// 이번 턴에 움직였는가.
    pub moved: bool,
    /// 땅에 숨어 있는가.
    pub burrowed: bool,
    /// 경계 태세인가 (시야·사거리 안으로 이동하는 적에게 자동 대응 사격).
    pub overwatch: bool,
    /// 남은 연막 수.
    pub charges: u8,
    /// 합동전 아군 AI 일반군처럼 기계가 조종하는 아군 유닛인가.
    pub ai_controlled: bool,
    /// 전장 가장자리로 무사히 후퇴했는가.
    pub retreated: bool,
    /// 월드 특수부대 대원 번호 (특수부대원이 아니면 None).
    pub squad_slot: Option<usize>,
}

impl Unit {
    fn new(side: Side, class: Class, gene: Gene, pos: Pos) -> Unit {
        let charges = if class == Class::Smoker { SMOKE_CHARGES } else { 0 };
        Unit {
            side,
            class,
            gene,
            hp: class.def().hp,
            pos,
            ap: AP_PER_TURN,
            moved: false,
            burrowed: false,
            overwatch: false,
            charges,
            ai_controlled: false,
            retreated: false,
            squad_slot: None,
        }
    }

    pub fn alive(&self) -> bool {
        self.hp > 0 && !self.retreated
    }

    pub fn glyph(&self) -> char {
        if self.side == Side::Brood && self.ai_controlled {
            return 'a';
        }
        match self.gene {
            Gene::Sniper => 'ψ',
            Gene::Burst => 'θ',
            Gene::Burrow => 'λ',
            Gene::Plain => self.class.def().glyph,
        }
    }

    pub fn name(&self) -> &'static str {
        if self.side == Side::Brood && self.ai_controlled {
            return "아군 일반군";
        }
        match self.gene {
            Gene::Sniper => "저격",
            Gene::Burst => "화력",
            Gene::Burrow => "잠복",
            Gene::Plain => self.class.def().name,
        }
    }

    pub fn range(&self) -> i32 {
        if self.gene == Gene::Sniper {
            SNIPER_RANGE
        } else {
            self.class.def().range
        }
    }
}

/// 월드 충돌 지형에 따른 전장 구조 유형.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BattleBiome {
    Skirmish,
    Forest,
    Hill,
    Outpost,
    Road,
}

/// 월드 충돌에서 전술 전투로 넘기는 설정.
#[derive(Clone, Debug)]
pub struct BattleConfig {
    pub seed: u64,
    /// 특수부대 대원들: `(월드 슬롯 번호, 개조, 현재 체력)`.
    pub special: Vec<(usize, Gene, i32)>,
    /// 합동 참전 아군 AI 일반군 수.
    pub allied_ai: usize,
    /// 제국 편제.
    pub empire: Vec<Class>,
    /// 매복 기습: 제국이 엄폐 없이 노출 시작, 잠복 개조 대원은 숨은 채 시작.
    pub ambush: bool,
    /// 주둔 방어: 아군 앞줄에 낮은 엄폐 보장.
    pub garrison: bool,
    /// 중계탑 차단 구역: 제국 중계기 제외.
    pub relay_cut: bool,
    pub biome: BattleBiome,
    pub title: String,
    pub tags: Vec<String>,
}

/// 사격 한 번의 명중률과 그 내역. 화면에 보이는 숫자가 곧 굴리는 숫자다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Shot {
    pub chance: i32,
    pub aim: i32,
    pub cover: i32,
    pub falloff: i32,
}

/// 화면이 순서대로 보여줄 일들. 규칙에는 영향이 없고 지문에도 안 들어간다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// 한 칸 이동.
    Step { unit: usize, from: Pos, to: Pos },
    /// 사격 한 번. `log_lines`는 이 사격이 기록에 남긴 줄 수.
    Shot { shooter: usize, target: usize, hit: bool, dmg: i32, killed: bool, log_lines: usize },
    /// 땅에 숨었다.
    Burrow { unit: usize },
    /// 연막이 깔렸다. `center` 둘레 3×3.
    Smoke { unit: usize, center: Pos },
    /// 가장자리로 후퇴해 생환했다.
    Retreat { unit: usize },
    /// 경계 태세에 들어갔다.
    Overwatch { unit: usize },
    /// 이동 중 경계에 걸려 대응 사격이 발동한다 (바로 뒤 `Shot`이 이어진다).
    OverwatchTrigger { shooter: usize, target: usize },
}

#[derive(Clone, Debug)]
pub struct Game {
    pub seed: u64,
    pub tiles: Vec<Tile>,
    pub units: Vec<Unit>,
    pub round: u32,
    pub selected: Option<usize>,
    pub outcome: Option<Side>,
    pub log: Vec<String>,
    pub events: Vec<Event>,
    /// 칸마다 연막이 남아 있는 라운드 수.
    pub smoke: Vec<u8>,
    /// 상대편이 이 유닛을 마지막으로 본 자리. 유닛 번호로 찾는다. 본 적 없거나 놓쳤으면 None.
    pub memory: Vec<Option<Pos>>,
    /// 제국이 수를 고를 때 쓰는 가중치.
    pub doctrine: ai::Doctrine,
    /// 아군 쪽을 기계가 대신 둘 때의 가중치. 시험과 모의전에서만 쓴다.
    pub stand_in: ai::Doctrine,
    rng: Rng,
}

pub fn dist(a: Pos, b: Pos) -> i32 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

fn in_bounds(p: Pos) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < W && p.1 < H
}

fn idx(p: Pos) -> usize {
    (p.1 * W + p.0) as usize
}

impl Game {
    /// 기본 판. 아군은 갈래마다 하나씩과 원형 하나. 제국은 보병 넷, 중계기, 그리고 대응 유닛 하나.
    /// 대응 유닛은 시드가 정한다: 탐지기, 연막병, 방패병 중 하나.
    pub fn new(seed: u64) -> Game {
        let brood = [Gene::Sniper, Gene::Burst, Gene::Burrow, Gene::Plain];
        let counter = [Class::Sensor, Class::Smoker, Class::Shield][(seed % 3) as usize];
        let empire = [Class::Trooper, Class::Trooper, Class::Relay, Class::Trooper, counter, Class::Trooper];
        Game::with_units(seed, &brood, &empire)
    }

    /// 양쪽 인원을 정해서 시작한다. 한쪽에 최대 `H`명.
    pub fn with_units(seed: u64, brood: &[Gene], empire: &[Class]) -> Game {
        assert!(brood.len() <= H as usize && empire.len() <= H as usize);
        let mut rng = Rng::new(seed);
        let mut tiles = vec![Tile::Floor; (W * H) as usize];
        for y in 0..H {
            for x in 3..W - 3 {
                let r = rng.below(100);
                tiles[idx((x, y))] = if r < 7 {
                    Tile::Wall
                } else if r < 19 {
                    Tile::Low
                } else {
                    Tile::Floor
                };
            }
        }
        // 다섯 명까지는 세 칸씩 띄우고, 그보다 많으면 한 줄로 붙여 세운다.
        let row = |i: usize, n: usize, first: i32| {
            if n <= 5 {
                first + 3 * i as i32
            } else {
                (H - n as i32) / 2 + i as i32
            }
        };
        let mut units = Vec::new();
        for (i, g) in brood.iter().enumerate() {
            units.push(Unit::new(Side::Brood, Class::Proto, *g, (1, row(i, brood.len(), 3))));
        }
        for (i, c) in empire.iter().enumerate() {
            let x = if *c == Class::Relay { W - 1 } else { W - 2 };
            units.push(Unit::new(Side::Empire, *c, Gene::Plain, (x, row(i, empire.len(), 2))));
        }
        let memory = vec![None; units.len()];
        let mut g = Game {
            seed,
            tiles,
            units,
            round: 1,
            selected: None,
            outcome: None,
            log: Vec::new(),
            events: Vec::new(),
            smoke: vec![0; (W * H) as usize],
            memory,
            doctrine: ai::Doctrine::default(),
            stand_in: ai::Doctrine::CAUTIOUS,
            rng,
        };
        g.observe();
        g
    }

    /// 월드 충돌 설정으로 전술 전투를 만든다. 매복·주둔·중계 차단·합동 참전·지형 구조를 반영한다.
    pub fn from_battle(cfg: &BattleConfig) -> Game {
        let mut rng = Rng::new(cfg.seed);
        let mut tiles = vec![Tile::Floor; (W * H) as usize];
        generate_biome_tiles(&mut tiles, cfg.biome, &mut rng);

        // 매복 기습: 제국 쪽 앞줄 엄폐물을 걷어 노출 상태로 시작하게 한다.
        if cfg.ambush {
            for y in 0..H {
                for x in (W - 6)..(W - 1) {
                    tiles[idx((x, y))] = Tile::Floor;
                }
            }
        }
        // 주둔 방어: 아군 앞줄(x=2)에 엄폐물을 배치해 엄폐에서 시작하게 한다.
        if cfg.garrison {
            for y in (2..H - 2).step_by(2) {
                tiles[idx((2, y))] = Tile::Low;
            }
        }

        let row = |i: usize, n: usize, first: i32| {
            if n <= 5 {
                first + 3 * i as i32
            } else {
                ((H - n as i32) / 2 + i as i32).clamp(0, H - 1)
            }
        };

        let mut units = Vec::new();
        let sp_count = cfg.special.len().min(H as usize);
        for (i, &(slot, gene, hp)) in cfg.special.iter().take(sp_count).enumerate() {
            let y = row(i, sp_count, 3);
            let mut u = Unit::new(Side::Brood, Class::Proto, gene, (1, y));
            u.hp = hp.clamp(1, u.class.def().hp);
            u.squad_slot = Some(slot);
            if cfg.ambush && gene == Gene::Burrow {
                u.burrowed = true;
            }
            units.push(u);
        }

        // 합동 참전 아군 AI 일반군 (특수부대 앞/측면 배치, 엄폐 칸은 피한다).
        let ai_count = cfg.allied_ai.min(4);
        for i in 0..ai_count {
            let mut y = row(i, ai_count, 2);
            let x = if cfg.garrison { 3 } else { 2 };
            while tiles[idx((x, y))] != Tile::Floor && y + 1 < H {
                y += 1;
            }
            tiles[idx((x, y))] = Tile::Floor;
            let mut u = Unit::new(Side::Brood, Class::Proto, Gene::Plain, (x, y));
            u.ai_controlled = true;
            units.push(u);
        }

        let emp_list: Vec<Class> = cfg
            .empire
            .iter()
            .copied()
            .filter(|&c| !(cfg.relay_cut && c == Class::Relay))
            .take(H as usize)
            .collect();
        for (i, c) in emp_list.iter().enumerate() {
            let x = if cfg.ambush {
                if *c == Class::Relay { W - 3 } else { W - 4 }
            } else if *c == Class::Relay {
                W - 1
            } else {
                W - 2
            };
            let y = row(i, emp_list.len(), 2);
            tiles[idx((x, y))] = Tile::Floor;
            units.push(Unit::new(Side::Empire, *c, Gene::Plain, (x, y)));
        }

        let memory = vec![None; units.len()];
        let mut g = Game {
            seed: cfg.seed,
            tiles,
            units,
            round: 1,
            selected: None,
            outcome: None,
            log: Vec::new(),
            events: Vec::new(),
            smoke: vec![0; (W * H) as usize],
            memory,
            doctrine: ai::Doctrine::default(),
            stand_in: ai::Doctrine::CAUTIOUS,
            rng,
        };
        g.observe();
        g
    }

    /// 방패병 `unit`의 방패가 현재 향하고 있는 방향 벡터 `(dx, dy)` (보이는 적이 없으면 None).
    pub fn shield_facing(&self, unit: usize) -> Option<(i32, i32)> {
        let u = &self.units[unit];
        if !u.alive() || u.class != Class::Shield {
            return None;
        }
        let nearest = (0..self.units.len())
            .filter(|&i| self.units[i].side == Side::Brood && self.visible_to(Side::Empire, i))
            .min_by_key(|&i| (dist(u.pos, self.units[i].pos), i))?;
        let t = self.units[nearest].pos;
        Some((t.0 - u.pos.0, t.1 - u.pos.1))
    }

    pub fn tile(&self, p: Pos) -> Tile {
        if in_bounds(p) {
            self.tiles[idx(p)]
        } else {
            Tile::Wall
        }
    }

    pub fn smoke_at(&self, p: Pos) -> bool {
        in_bounds(p) && self.smoke[idx(p)] > 0
    }

    pub fn unit_at(&self, p: Pos) -> Option<usize> {
        self.units.iter().position(|u| u.alive() && u.pos == p)
    }

    /// 중계기가 하나라도 살아 있으면 제국 분대는 시야와 기억을 합쳐 한 머리로 둔다. 수치 보정은 없다.
    pub fn network_up(&self) -> bool {
        self.units.iter().any(|u| u.alive() && u.class == Class::Relay)
    }

    /// 시선. 끝점 순서를 고정해서 a→b와 b→a가 항상 같다.
    /// 벽은 막는다. 연막은 `SMOKE_SIGHT`보다 먼 시선을 막는다 (양 끝 칸 포함).
    pub fn los(&self, a: Pos, b: Pos) -> bool {
        let (a, b) = if a <= b { (a, b) } else { (b, a) };
        let far = dist(a, b) > SMOKE_SIGHT;
        let (mut x, mut y) = a;
        let dx = (b.0 - x).abs();
        let dy = -(b.1 - y).abs();
        let sx = if x < b.0 { 1 } else { -1 };
        let sy = if y < b.1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            if far && self.smoke_at((x, y)) {
                return false;
            }
            if (x, y) == b {
                return true;
            }
            if (x, y) != a && self.tile((x, y)) == Tile::Wall {
                return false;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
    }

    /// `from`에서 쏠 때 `target` 칸이 받는 지형 엄폐. 사수 쪽 면에 붙은 엄폐물만 센다.
    pub fn cover(&self, from: Pos, target: Pos) -> i32 {
        let dx = from.0 - target.0;
        let dy = from.1 - target.1;
        let mut best = 0;
        let mut check = |p: Pos| {
            let c = match self.tile(p) {
                Tile::Wall => COVER_WALL,
                Tile::Low => COVER_LOW,
                Tile::Floor => 0,
            };
            best = best.max(c);
        };
        if dx != 0 && dx.abs() * 2 >= dy.abs() {
            check((target.0 + dx.signum(), target.1));
        }
        if dy != 0 && dy.abs() * 2 >= dx.abs() {
            check((target.0, target.1 + dy.signum()));
        }
        best
    }

    /// 방패병 `unit`이 `at`에 서 있을 때 `from`에서 오는 사격에 받는 엄폐.
    /// 방패는 제국에게 보이는 가장 가까운 적을 향한다. 그 방향 좌우 45도 안에서 오는 사격만 막는다.
    /// 보이는 적이 없으면 방패는 어디도 향하지 않는다.
    pub fn shield_cover(&self, unit: usize, at: Pos, from: Pos) -> i32 {
        if self.units[unit].class != Class::Shield {
            return 0;
        }
        let nearest = (0..self.units.len())
            .filter(|&i| self.units[i].side == Side::Brood && self.visible_to(Side::Empire, i))
            .min_by_key(|&i| (dist(at, self.units[i].pos), i));
        let Some(n) = nearest else { return 0 };
        let f = (self.units[n].pos.0 - at.0, self.units[n].pos.1 - at.1);
        let v = (from.0 - at.0, from.1 - at.1);
        let dot = v.0 * f.0 + v.1 * f.1;
        let cross = (v.0 * f.1 - v.1 * f.0).abs();
        if dot > 0 && cross <= dot {
            COVER_WALL
        } else {
            0
        }
    }

    /// 명중률 계산의 한 곳. `shooter`가 `from`에서 `target` 칸을 쏜다고 칠 때.
    /// - `target_unit`: 그 칸에 설 유닛. 방패를 따지는 데 쓴다.
    /// - `settled`: 그 턴에 움직이지 않고 쏘는가 (저격).
    /// - `ambush`: 숨어 있다가 쏘는가 (잠복). 엄폐를 무시한다.
    pub fn shot_calc(&self, shooter: usize, from: Pos, target: Pos, target_unit: Option<usize>, settled: bool, ambush: bool) -> Option<Shot> {
        let u = &self.units[shooter];
        let d = dist(from, target);
        if d == 0 || d > u.range() || !self.los(from, target) {
            return None;
        }
        let steady = u.gene == Gene::Sniper && settled;
        let aim = u.class.def().aim + if steady { SNIPER_AIM } else { 0 };
        let cover = if ambush {
            0
        } else {
            self.cover(from, target).max(target_unit.map_or(0, |t| self.shield_cover(t, target, from)))
        };
        let falloff = if steady { 0 } else { (d - FALLOFF_START).max(0) * FALLOFF_PER_TILE };
        let chance = (aim - cover - falloff).clamp(0, 100);
        Some(Shot { chance, aim, cover, falloff })
    }

    /// `shooter`가 `from` 칸에 있다고 치고 `target` 칸을 쏠 때의 명중률.
    /// 제자리면 지금 상태(안 움직였는가, 숨어 있는가)를 그대로 쓰고, 다른 칸이면 움직인 것으로 친다.
    pub fn shot_from(&self, shooter: usize, from: Pos, target: Pos) -> Option<Shot> {
        let u = &self.units[shooter];
        let here = from == u.pos;
        self.shot_calc(shooter, from, target, self.unit_at(target), here && !u.moved, here && u.burrowed)
    }

    pub fn shot(&self, shooter: usize, target: usize) -> Option<Shot> {
        let (s, t) = (&self.units[shooter], &self.units[target]);
        if !s.alive() || !t.alive() || s.side == t.side || (t.burrowed && !self.revealed(target)) {
            return None;
        }
        self.shot_from(shooter, s.pos, t.pos)
    }

    /// `side` 진영의 누군가가 `p` 칸을 보고 있는가.
    pub fn seen_by(&self, side: Side, p: Pos) -> bool {
        self.units
            .iter()
            .any(|u| u.alive() && u.side == side && dist(u.pos, p) <= SIGHT && self.los(u.pos, p))
    }

    /// 숨은 유닛 `i`가 적 탐지기에 걸려 있는가.
    pub fn revealed(&self, i: usize) -> bool {
        let u = &self.units[i];
        self.units
            .iter()
            .any(|s| s.alive() && s.side != u.side && s.class == Class::Sensor && dist(s.pos, u.pos) <= SENSOR_RADIUS)
    }

    /// `side`가 유닛 `i`를 보고 있는가. 숨은 유닛은 탐지기에 걸려야 보인다.
    pub fn visible_to(&self, side: Side, i: usize) -> bool {
        let u = &self.units[i];
        u.alive() && (!u.burrowed || self.revealed(i)) && self.seen_by(side, u.pos)
    }

    /// `start`에서 `mv`칸 안에 갈 수 있는 칸들. 막힌 칸은 `blocked`가 정한다. 계획용.
    pub(crate) fn flood_from(&self, start: Pos, mv: i32, blocked: impl Fn(Pos) -> bool) -> Vec<Pos> {
        let mut cost = vec![-1i32; (W * H) as usize];
        let mut queue = vec![start];
        cost[idx(start)] = 0;
        let mut head = 0;
        while head < queue.len() {
            let p = queue[head];
            head += 1;
            let c = cost[idx(p)];
            if c == mv {
                continue;
            }
            for d in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let n = (p.0 + d.0, p.1 + d.1);
                if !in_bounds(n) || self.tile(n) != Tile::Floor {
                    continue;
                }
                if cost[idx(n)] >= 0 || blocked(n) {
                    continue;
                }
                cost[idx(n)] = c + 1;
                queue.push(n);
            }
        }
        queue.remove(0);
        queue
    }

    /// 행동 1회로 갈 수 있는 칸들과, 각 칸에 오기 직전 칸.
    fn flood(&self, uid: usize) -> (Vec<Pos>, Vec<i32>) {
        let u = &self.units[uid];
        let mut cost = vec![-1i32; (W * H) as usize];
        let mut prev = vec![-1i32; (W * H) as usize];
        let mut queue = vec![u.pos];
        cost[idx(u.pos)] = 0;
        let mut out = Vec::new();
        let mut head = 0;
        while head < queue.len() {
            let p = queue[head];
            head += 1;
            let pi = p.1 * W + p.0;
            let c = cost[pi as usize];
            if c == u.class.def().mv {
                continue;
            }
            for d in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let n = (p.0 + d.0, p.1 + d.1);
                if !in_bounds(n) || self.tile(n) != Tile::Floor {
                    continue;
                }
                let i = idx(n);
                if cost[i] >= 0 || self.unit_at(n).is_some() {
                    continue;
                }
                cost[i] = c + 1;
                prev[i] = pi;
                queue.push(n);
                out.push(n);
            }
        }
        (out, prev)
    }

    /// 행동 1회로 갈 수 있는 칸들.
    pub fn reachable(&self, uid: usize) -> Vec<Pos> {
        self.flood(uid).0
    }

    /// `to`까지 가는 길. 출발 칸은 빼고 도착 칸은 넣는다. 못 가면 None.
    pub fn path_to(&self, uid: usize, to: Pos) -> Option<Vec<Pos>> {
        if !in_bounds(to) {
            return None;
        }
        let (_, prev) = self.flood(uid);
        let mut i = to.1 * W + to.0;
        if prev[i as usize] < 0 {
            return None;
        }
        let mut path = Vec::new();
        while prev[i as usize] >= 0 {
            path.push((i % W, i / W));
            i = prev[i as usize];
        }
        path.reverse();
        Some(path)
    }

    /// 행동 1을 써서 `to`로 옮긴다. 갈 수 없으면 false. 숨어 있었으면 나온다.
    /// 한 칸 옮길 때마다 상대의 경계 사격에 걸릴 수 있으며, 맞고 죽으면 그 자리에서 멈춘다.
    pub(crate) fn move_unit(&mut self, uid: usize, to: Pos) -> bool {
        let Some(path) = self.path_to(uid, to) else { return false };
        let mut from = self.units[uid].pos;
        self.units[uid].burrowed = false;
        self.units[uid].overwatch = false;
        self.units[uid].moved = true;
        for p in path {
            self.events.push(Event::Step { unit: uid, from, to: p });
            from = p;
            // 지나가는 길에 들킨 것도 기억에 남는다.
            self.units[uid].pos = p;
            self.observe();
            self.trigger_overwatch(uid);
            if !self.units[uid].alive() || self.outcome.is_some() {
                break;
            }
        }
        if self.units[uid].alive() {
            self.units[uid].ap = self.units[uid].ap.saturating_sub(1);
        } else {
            self.units[uid].ap = 0;
        }
        true
    }

    /// 경계 사격의 명중률 (`OVERWATCH_PENALTY` 감점 적용).
    pub fn overwatch_shot(&self, shooter: usize, target: usize) -> Option<Shot> {
        let mut shot = self.shot(shooter, target)?;
        shot.chance = (shot.chance - OVERWATCH_PENALTY).clamp(0, 100);
        Some(shot)
    }

    /// `mover`가 방금 한 칸 움직였을 때 시야·사거리 안에 들어온 상대 경계 유닛들의 대응 사격을 처리한다.
    fn trigger_overwatch(&mut self, mover: usize) {
        let mover_side = self.units[mover].side;
        for w in 0..self.units.len() {
            if !self.units[mover].alive() || self.outcome.is_some() {
                break;
            }
            if !self.units[w].alive() || self.units[w].side == mover_side || !self.units[w].overwatch {
                continue;
            }
            let Some(shot) = self.overwatch_shot(w, mover) else { continue };
            self.units[w].overwatch = false;
            self.events.push(Event::OverwatchTrigger { shooter: w, target: mover });
            let roll = self.rng.below(100) as i32;
            let hit = roll < shot.chance;
            let log_before = self.log.len();
            let (sn, tn) = (self.units[w].name(), self.units[mover].name());
            let dmg = if hit { self.units[w].class.def().dmg } else { 0 };
            if hit {
                self.units[mover].hp -= dmg;
                if self.units[mover].alive() {
                    self.log.push(format!("[경계] {sn} → {tn}  {}%  적중, 피해 {dmg}", shot.chance));
                } else {
                    self.log.push(format!("[경계] {sn} → {tn}  {}%  적중, 사망", shot.chance));
                    if self.units[mover].class == Class::Relay && !self.network_up() {
                        self.log.push("중계 두절. 제국 분대가 각자 판단으로 전환.".to_string());
                    }
                    if self.selected == Some(mover) {
                        self.selected = None;
                    }
                }
            } else {
                self.log.push(format!("[경계] {sn} → {tn}  {}%  빗나감", shot.chance));
            }
            self.events.push(Event::Shot {
                shooter: w,
                target: mover,
                hit,
                dmg,
                killed: !self.units[mover].alive(),
                log_lines: self.log.len() - log_before,
            });
            self.observe();
            self.check_outcome();
        }
    }

    /// 남은 행동을 모두 써서 경계 태세에 들어간다.
    pub(crate) fn set_overwatch(&mut self, uid: usize) -> bool {
        let u = &mut self.units[uid];
        if !u.alive() || u.ap == 0 || u.overwatch || u.burrowed || u.range() == 0 {
            return false;
        }
        u.overwatch = true;
        u.ap = 0;
        let name = u.name();
        self.log.push(format!("{name} 경계 태세"));
        self.events.push(Event::Overwatch { unit: uid });
        true
    }

    /// 행동 1을 써서 땅에 숨는다.
    pub(crate) fn dig_in(&mut self, uid: usize) -> bool {
        let u = &mut self.units[uid];
        if u.gene != Gene::Burrow || u.burrowed || u.ap == 0 || !u.alive() {
            return false;
        }
        u.burrowed = true;
        u.overwatch = false;
        u.ap -= 1;
        self.events.push(Event::Burrow { unit: uid });
        self.observe();
        true
    }

    /// 행동 1을 써서 `center` 둘레 3×3에 연막을 깐다.
    pub(crate) fn throw_smoke(&mut self, uid: usize, center: Pos) -> bool {
        let u = &self.units[uid];
        if u.charges == 0 || u.ap == 0 || !in_bounds(center) || dist(u.pos, center) > SMOKE_RANGE || !self.los(u.pos, center) {
            return false;
        }
        for y in center.1 - 1..=center.1 + 1 {
            for x in center.0 - 1..=center.0 + 1 {
                if in_bounds((x, y)) && self.tile((x, y)) != Tile::Wall {
                    self.smoke[idx((x, y))] = SMOKE_ROUNDS;
                }
            }
        }
        self.units[uid].charges -= 1;
        self.units[uid].overwatch = false;
        self.units[uid].ap -= 1;
        self.events.push(Event::Smoke { unit: uid, center });
        self.observe();
        true
    }

    /// 양쪽의 기억을 지금 보이는 것으로 고친다. 보이면 그 자리. 기억한 자리를 봤는데 거기 없으면 놓친 것.
    /// 숨은 유닛은 안 보이지만, 그 자리를 떠나지 않은 한 기억은 남는다.
    pub(crate) fn observe(&mut self) {
        for i in 0..self.units.len() {
            let watcher = if self.units[i].side == Side::Brood { Side::Empire } else { Side::Brood };
            let pos = self.units[i].pos;
            if !self.units[i].alive() {
                self.memory[i] = None;
            } else if self.visible_to(watcher, i) {
                self.memory[i] = Some(pos);
            } else if self.memory[i].is_some_and(|m| m != pos && self.seen_by(watcher, m)) {
                self.memory[i] = None;
            }
        }
    }

    /// 사선이 지나는 칸들. 양 끝은 뺀다. 화면용.
    pub fn line(a: Pos, b: Pos) -> Vec<Pos> {
        let (mut x, mut y) = a;
        let dx = (b.0 - x).abs();
        let dy = -(b.1 - y).abs();
        let sx = if x < b.0 { 1 } else { -1 };
        let sy = if y < b.1 { 1 } else { -1 };
        let mut err = dx + dy;
        let mut out = Vec::new();
        while (x, y) != b {
            if (x, y) != a {
                out.push((x, y));
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
        out
    }

    /// 플레이어 입력: 칸 하나를 누른다. 상태가 바뀌었으면 true.
    pub fn click(&mut self, p: Pos) -> bool {
        if self.outcome.is_some() || !in_bounds(p) {
            return false;
        }
        if let Some(t) = self.unit_at(p) {
            if self.units[t].side == Side::Brood {
                if self.units[t].ai_controlled {
                    return false;
                }
                self.selected = Some(t);
                return true;
            }
            if let Some(s) = self.selected {
                if self.units[s].ap > 0 && self.shot(s, t).is_some() {
                    self.fire(s, t);
                    return true;
                }
            }
            return false;
        }
        if let Some(s) = self.selected {
            if self.units[s].ap > 0 && self.move_unit(s, p) {
                return true;
            }
            // 갈 수 없는 빈 칸을 누르면 선택을 푼다.
            self.selected = None;
            return true;
        }
        false
    }

    /// 플레이어 입력: 선택한 유닛을 땅에 숨긴다.
    pub fn burrow(&mut self) -> bool {
        match self.selected {
            Some(s) if self.outcome.is_none() => self.dig_in(s),
            _ => false,
        }
    }

    /// 선택한 유닛이 지금 숨을 수 있는가.
    pub fn can_burrow(&self) -> bool {
        self.selected.is_some_and(|s| {
            let u = &self.units[s];
            self.outcome.is_none() && u.gene == Gene::Burrow && !u.burrowed && u.ap > 0
        })
    }

    /// 선택한 유닛이 지금 경계 태세에 들어갈 수 있는가.
    pub fn can_overwatch(&self) -> bool {
        self.selected.is_some_and(|s| {
            let u = &self.units[s];
            self.outcome.is_none()
                && u.side == Side::Brood
                && !u.ai_controlled
                && u.alive()
                && u.ap > 0
                && !u.overwatch
                && !u.burrowed
                && u.range() > 0
        })
    }

    /// 플레이어 입력: 선택한 유닛을 경계 태세로 전환한다 (남은 행동 전부 소비).
    pub fn overwatch(&mut self) -> bool {
        if !self.can_overwatch() {
            return false;
        }
        let s = self.selected.unwrap();
        self.set_overwatch(s)
    }

    /// 선택한 플레이어 유닛이 아군 쪽 가장자리(`x == 0`)에서 후퇴할 수 있는가.
    pub fn can_retreat(&self) -> bool {
        self.selected.is_some_and(|s| {
            let u = &self.units[s];
            self.outcome.is_none()
                && u.side == Side::Brood
                && !u.ai_controlled
                && u.alive()
                && u.ap > 0
                && u.pos.0 == 0
        })
    }

    /// 플레이어 입력: 선택한 유닛을 전장 밖으로 후퇴시켜 생환시킨다.
    pub fn retreat(&mut self) -> bool {
        if !self.can_retreat() {
            return false;
        }
        let s = self.selected.unwrap();
        self.units[s].retreated = true;
        self.units[s].overwatch = false;
        self.units[s].ap = 0;
        self.selected = None;
        let name = self.units[s].name();
        self.log.push(format!("{name} 후퇴 생환"));
        self.events.push(Event::Retreat { unit: s });
        self.observe();
        self.check_outcome();
        true
    }

    /// 플레이어 턴을 끝낸다. 합동 아군 AI → 제국 AI 순서로 움직이고 다음 라운드가 시작된다.
    pub fn end_turn(&mut self) {
        if self.outcome.is_some() {
            return;
        }
        self.selected = None;
        if self.units.iter().any(|u| u.side == Side::Brood && u.ai_controlled && u.alive()) {
            ai::run_allied_ai(self);
            if self.outcome.is_some() {
                return;
            }
        }
        ai::run(self, Side::Empire);
        if self.outcome.is_some() {
            return;
        }
        self.next_round();
    }

    /// 라운드를 넘긴다. 행동이 돌아오고 연막이 한 라운드만큼 걷힌다.
    /// 아군의 경계 태세는 새 턴이 시작되며 해제되고, 제국의 경계는 이번 플레이어 턴 동안 유지된다.
    pub fn next_round(&mut self) {
        for u in &mut self.units {
            if u.alive() {
                u.ap = AP_PER_TURN;
                u.moved = false;
                if u.side == Side::Brood {
                    u.overwatch = false;
                }
            }
        }
        for s in &mut self.smoke {
            *s = s.saturating_sub(1);
        }
        self.round += 1;
        self.observe();
    }

    fn check_outcome(&mut self) {
        if !self.units.iter().any(|u| u.alive() && u.side == Side::Empire) {
            self.outcome = Some(Side::Brood);
            return;
        }
        let has_player_units = self.units.iter().any(|u| u.side == Side::Brood && !u.ai_controlled);
        let player_left = self.units.iter().any(|u| u.alive() && u.side == Side::Brood && !u.ai_controlled);
        let brood_left = self.units.iter().any(|u| u.alive() && u.side == Side::Brood);
        if !brood_left || (has_player_units && !player_left) {
            self.outcome = Some(Side::Empire);
        }
    }

    /// 사격. 보통은 그 유닛의 턴을 끝낸다. 화력 개조는 가까운 표적에 행동 1만 쓴다.
    /// 숨어 있었으면 나온다.
    pub(crate) fn fire(&mut self, s: usize, t: usize) {
        let Some(shot) = self.shot(s, t) else { return };
        let roll = self.rng.below(100) as i32;
        let hit = roll < shot.chance;
        let close = dist(self.units[s].pos, self.units[t].pos) <= BURST_RANGE;
        if self.units[s].gene == Gene::Burst && close {
            self.units[s].ap -= 1;
        } else {
            self.units[s].ap = 0;
        }
        self.units[s].burrowed = false;
        self.units[s].overwatch = false;
        let log_before = self.log.len();
        let (sn, tn) = (self.units[s].name(), self.units[t].name());
        if hit {
            let dmg = self.units[s].class.def().dmg;
            self.units[t].hp -= dmg;
            if self.units[t].alive() {
                self.log.push(format!("{sn} → {tn}  {}%  적중, 피해 {dmg}", shot.chance));
            } else {
                self.log.push(format!("{sn} → {tn}  {}%  적중, 사망", shot.chance));
                if self.units[t].class == Class::Relay && !self.network_up() {
                    self.log.push("중계 두절. 제국 분대가 각자 판단으로 전환.".to_string());
                }
                if self.selected == Some(t) {
                    self.selected = None;
                }
            }
        } else {
            self.log.push(format!("{sn} → {tn}  {}%  빗나감", shot.chance));
        }
        self.events.push(Event::Shot {
            shooter: s,
            target: t,
            hit,
            dmg: if hit { self.units[s].class.def().dmg } else { 0 },
            killed: !self.units[t].alive(),
            log_lines: self.log.len() - log_before,
        });
        self.observe();
        self.check_outcome();
    }

    /// 테스트와 세이브 검증용 상태 지문.
    pub fn fingerprint(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        };
        mix(self.rng.state());
        mix(self.round as u64);
        for u in &self.units {
            mix(u.hp as u64);
            mix(u.pos.0 as u64);
            mix(u.pos.1 as u64);
            mix(u.ap as u64);
            mix(u.moved as u64 | (u.burrowed as u64) << 1 | (u.charges as u64) << 2 | (u.overwatch as u64) << 6);
        }
        for m in &self.memory {
            mix(m.map_or(u64::MAX, |p| (p.1 * W + p.0) as u64));
        }
        for s in &self.smoke {
            mix(*s as u64);
        }
        h
    }
}

/// 지형 유형별 구조화된 엄폐물 배치 (`x < 3`, `x >= W - 3` 스폰 구역은 비워 둔다).
fn generate_biome_tiles(tiles: &mut [Tile], biome: BattleBiome, rng: &mut Rng) {
    let put = |tiles: &mut [Tile], x: i32, y: i32, t: Tile| {
        if x >= 3 && x < W - 3 && y >= 0 && y < H {
            tiles[idx((x, y))] = t;
        }
    };
    let seg = |tiles: &mut [Tile], x: i32, y: i32, dx: i32, dy: i32, len: i32, t: Tile| {
        for k in 0..len {
            put(tiles, x + dx * k, y + dy * k, t);
        }
    };

    match biome {
        BattleBiome::Outpost => {
            // 벙커형 L자 벽 구조 + 기지 바리케이드, 중앙 복도는 교전 사선 유지
            let cols = [6, 11, 16, 21];
            for &bx in &cols {
                let x = bx + rng.below(2) as i32 - 1;
                let top_y = 2 + rng.below(3) as i32;
                let bot_y = H - 3 - rng.below(3) as i32;
                let dir_x = if bx < W / 2 { 1 } else { -1 };
                seg(tiles, x, top_y, 0, 1, 3, Tile::Wall);
                seg(tiles, x, top_y, dir_x, 0, 2, Tile::Wall);
                seg(tiles, x, bot_y, 0, -1, 3, Tile::Wall);
                seg(tiles, x, bot_y, dir_x, 0, 2, Tile::Wall);
            }
            for _ in 0..9 {
                let x = 5 + rng.below((W - 10) as u32) as i32;
                let y = 2 + rng.below((H - 4) as u32) as i32;
                if rng.below(2) == 0 {
                    seg(tiles, x, y, 0, 1, 2 + rng.below(2) as i32, Tile::Low);
                } else {
                    seg(tiles, x, y, 1, 0, 2 + rng.below(2) as i32, Tile::Low);
                }
            }
            // 중앙 통로 관통 보장 (최소 1줄은 바닥 유지)
            let lane_y = 7 + rng.below(2) as i32;
            for x in 4..W - 4 {
                if tiles[idx((x, lane_y))] == Tile::Wall {
                    tiles[idx((x, lane_y))] = Tile::Floor;
                }
            }
        }
        BattleBiome::Forest => {
            // 유기적 수풀 엄폐 군락 + 듬성듬성한 거목 기둥
            for _ in 0..16 {
                let cx = 4 + rng.below((W - 8) as u32) as i32;
                let cy = 1 + rng.below((H - 2) as u32) as i32;
                put(tiles, cx, cy, Tile::Low);
                let dirs = [(1, 0), (-1, 0), (0, 1), (0, -1)];
                let d1 = dirs[rng.below(4) as usize];
                let d2 = dirs[rng.below(4) as usize];
                put(tiles, cx + d1.0, cy + d1.1, Tile::Low);
                if rng.below(3) != 0 {
                    put(tiles, cx + d2.0, cy + d2.1, Tile::Low);
                }
            }
            for _ in 0..11 {
                let cx = 5 + rng.below((W - 10) as u32) as i32;
                let cy = 1 + rng.below((H - 2) as u32) as i32;
                put(tiles, cx, cy, Tile::Wall);
                if rng.below(3) == 0 {
                    put(tiles, cx, cy + 1, Tile::Wall);
                }
            }
        }
        BattleBiome::Hill => {
            // 남북 능선 단차: 세로 엄폐선과 암벽 기둥, 이동용 틈새 확보
            for band in 0..5 {
                let x = 5 + band * 4 + rng.below(2) as i32;
                let mut y = 1;
                while y < H - 1 {
                    let len = 2 + rng.below(3) as i32;
                    let t = if rng.below(4) == 0 { Tile::Wall } else { Tile::Low };
                    seg(tiles, x, y, 0, 1, len, t);
                    y += len + 2 + rng.below(2) as i32;
                }
            }
        }
        BattleBiome::Road => {
            // 중앙 고속도로 개활지(y=6..=9) + 도로변 방호벽 + 상하 측면 엄폐
            for x in (4..W - 5).step_by(4) {
                let off = rng.below(2) as i32;
                seg(tiles, x + off, 5, 1, 0, 2, Tile::Low);
                seg(tiles, x + (1 - off), 10, 1, 0, 2, Tile::Low);
            }
            for _ in 0..8 {
                let x = 4 + rng.below((W - 8) as u32) as i32;
                let top = rng.below(2) == 0;
                let y = if top { 1 + rng.below(3) as i32 } else { 12 + rng.below(3) as i32 };
                let t = if rng.below(2) == 0 { Tile::Wall } else { Tile::Low };
                seg(tiles, x, y, 1, 0, 2 + rng.below(2) as i32, t);
            }
            // 중앙 차선은 교전 엄폐 1~2개만 잔해로 남겨 속도감 유지
            for _ in 0..2 {
                let x = 8 + rng.below((W - 16) as u32) as i32;
                let y = 7 + rng.below(2) as i32;
                put(tiles, x, y, Tile::Low);
            }
        }
        BattleBiome::Skirmish => {
            // 균형 잡힌 소규모 엄폐 바리케이드와 벽 기둥
            for _ in 0..10 {
                let x = 4 + rng.below((W - 8) as u32) as i32;
                let y = 1 + rng.below((H - 2) as u32) as i32;
                if rng.below(2) == 0 {
                    seg(tiles, x, y, 0, 1, 2 + rng.below(2) as i32, Tile::Low);
                } else {
                    seg(tiles, x, y, 1, 0, 2, Tile::Low);
                }
            }
            for _ in 0..7 {
                let x = 5 + rng.below((W - 10) as u32) as i32;
                let y = 1 + rng.below((H - 2) as u32) as i32;
                if rng.below(2) == 0 {
                    seg(tiles, x, y, 0, 1, 2, Tile::Wall);
                } else {
                    seg(tiles, x, y, 1, 0, 2, Tile::Wall);
                }
            }
        }
    }
}

#[cfg(test)]
mod battle_biome_tests {
    use super::*;

    #[test]
    fn biome_maps_are_structured_and_keep_spawns_clear() {
        for biome in [
            BattleBiome::Skirmish,
            BattleBiome::Forest,
            BattleBiome::Hill,
            BattleBiome::Outpost,
            BattleBiome::Road,
        ] {
            let cfg = BattleConfig {
                seed: 77,
                special: vec![(0, Gene::Sniper, 5), (1, Gene::Burst, 5)],
                allied_ai: 0,
                empire: vec![Class::Trooper, Class::Shield],
                ambush: false,
                garrison: false,
                relay_cut: false,
                biome,
                title: "test".to_string(),
                tags: vec![],
            };
            let g = Game::from_battle(&cfg);
            let walls = g.tiles.iter().filter(|&&t| t == Tile::Wall).count();
            let lows = g.tiles.iter().filter(|&&t| t == Tile::Low).count();
            assert!(lows > 0, "{biome:?} should generate low cover");
            assert!(walls + lows >= 15, "{biome:?} should generate structured cover");
            for y in 0..H {
                assert_eq!(g.tile((0, y)), Tile::Floor);
                assert_eq!(g.tile((1, y)), Tile::Floor);
                assert_eq!(g.tile((W - 1, y)), Tile::Floor);
                assert_eq!(g.tile((W - 2, y)), Tile::Floor);
            }
            // 결정론 재현
            assert_eq!(g.fingerprint(), Game::from_battle(&cfg).fingerprint());
        }
    }

    #[test]
    fn shield_facing_points_to_nearest_visible_brood() {
        let mut g = Game::with_units(1, &[Gene::Plain], &[Class::Shield]);
        g.tiles.fill(Tile::Floor);
        g.units[0].pos = (4, 6);
        g.units[1].pos = (10, 6);
        assert_eq!(g.shield_facing(1), Some((-6, 0)));
        assert_eq!(g.shield_facing(0), None);
    }

    #[test]
    fn overwatch_triggers_on_movement_for_both_sides() {
        let mut g = Game::with_units(11, &[Gene::Sniper], &[Class::Trooper]);
        g.tiles.fill(Tile::Floor);
        g.units[0].pos = (4, 6);
        g.units[1].pos = (16, 6); // 사거리 14 밖(거리 12, 사거리 14 안이지만 벽으로 막음)
        g.tiles[idx((10, 6))] = Tile::Wall;

        // 1. 아군이 경계 태세에 들어가면 AP가 0이 되고 Event::Overwatch가 발생한다.
        assert!(g.click((4, 6)));
        assert!(g.can_overwatch());
        assert!(g.overwatch());
        assert!(g.units[0].overwatch);
        assert_eq!(g.units[0].ap, 0);
        assert!(matches!(g.events.last(), Some(Event::Overwatch { unit: 0 })));
        g.events.clear();

        // 2. 제국이 벽 옆으로 한 칸 나와 시선에 들어오면 아군 경계가 즉시 발동한다.
        assert!(g.move_unit(1, (16, 5)));
        let trig_idx = g
            .events
            .iter()
            .position(|e| matches!(e, Event::OverwatchTrigger { shooter: 0, target: 1 }))
            .expect("아군 경계 발동 이벤트가 있어야 한다");
        assert!(matches!(g.events.get(trig_idx + 1), Some(Event::Shot { shooter: 0, target: 1, .. })));
        assert!(!g.units[0].overwatch, "경계는 1회 발동 후 해제된다");

        // 3. 반대로 제국이 경계 태세일 때 아군이 움직이면 제국 경계가 발동한다.
        g.units[1].hp = 5;
        g.units[1].pos = (13, 5); // 보병 사거리 10 안
        g.units[1].ap = 2;
        g.units[0].ap = 2;
        g.events.clear();
        assert!(g.set_overwatch(1));
        assert!(g.units[1].overwatch);
        assert!(g.move_unit(0, (5, 6)));
        let trig2 = g
            .events
            .iter()
            .position(|e| matches!(e, Event::OverwatchTrigger { shooter: 1, target: 0 }))
            .expect("제국 경계 발동 이벤트가 있어야 한다");
        assert!(matches!(g.events.get(trig2 + 1), Some(Event::Shot { shooter: 1, target: 0, .. })));
        assert!(!g.units[1].overwatch);
    }
}

