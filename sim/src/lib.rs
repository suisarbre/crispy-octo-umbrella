//! 결정론적 전투 코어. 렌더링도, 시간도, 외부 입력도 모른다.
//! 상태를 바꾸는 입구는 `click`과 `end_turn` 둘뿐이라서
//! (시드, 입력 목록)만 있으면 판 전체를 그대로 재현할 수 있다.
#![forbid(unsafe_code)]

mod ai;
pub mod rng;

use rng::Rng;

pub const W: i32 = 28;
pub const H: i32 = 16;
pub const SIGHT: i32 = 14;
pub const AP_PER_TURN: u8 = 2;
/// 중계기가 살아 있을 때 제국 병사가 받는 조준 보정.
pub const NETWORK_AIM: i32 = 15;
pub const COVER_LOW: i32 = 20;
pub const COVER_WALL: i32 = 40;
/// 이 거리까지는 감점 없음. 그 뒤로 칸당 `FALLOFF_PER_TILE`.
pub const FALLOFF_START: i32 = 6;
pub const FALLOFF_PER_TILE: i32 = 3;

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
    Lancer,
    Shell,
    Stalker,
    Trooper,
    Relay,
}

pub struct ClassDef {
    pub glyph: char,
    pub name: &'static str,
    pub hp: i32,
    pub aim: i32,
    pub dmg: i32,
    pub mv: i32,
    pub range: i32,
}

impl Class {
    pub fn def(self) -> &'static ClassDef {
        match self {
            Class::Lancer => &ClassDef { glyph: 'ψ', name: "창", hp: 4, aim: 80, dmg: 4, mv: 5, range: 14 },
            Class::Shell => &ClassDef { glyph: 'θ', name: "껍질", hp: 8, aim: 65, dmg: 3, mv: 5, range: 8 },
            Class::Stalker => &ClassDef { glyph: 'λ', name: "추적자", hp: 5, aim: 70, dmg: 3, mv: 8, range: 8 },
            Class::Trooper => &ClassDef { glyph: 'h', name: "보병", hp: 5, aim: 60, dmg: 3, mv: 6, range: 10 },
            Class::Relay => &ClassDef { glyph: '&', name: "중계기", hp: 4, aim: 50, dmg: 2, mv: 5, range: 8 },
        }
    }
}

#[derive(Clone, Debug)]
pub struct Unit {
    pub side: Side,
    pub class: Class,
    pub hp: i32,
    pub pos: Pos,
    pub ap: u8,
}

impl Unit {
    pub fn alive(&self) -> bool {
        self.hp > 0
    }
}

/// 사격 한 번의 명중률과 그 내역. 화면에 보이는 숫자가 곧 굴리는 숫자다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Shot {
    pub chance: i32,
    pub aim: i32,
    pub network: i32,
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
    rng: Rng,
}

pub fn dist(a: Pos, b: Pos) -> i32 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

fn in_bounds(p: Pos) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < W && p.1 < H
}

impl Game {
    pub fn new(seed: u64) -> Game {
        let mut rng = Rng::new(seed);
        let mut tiles = vec![Tile::Floor; (W * H) as usize];
        for y in 0..H {
            for x in 3..W - 3 {
                let r = rng.below(100);
                tiles[(y * W + x) as usize] = if r < 7 {
                    Tile::Wall
                } else if r < 19 {
                    Tile::Low
                } else {
                    Tile::Floor
                };
            }
        }
        let mut units = Vec::new();
        let brood = [Class::Lancer, Class::Shell, Class::Stalker, Class::Stalker];
        for (i, c) in brood.iter().enumerate() {
            units.push(Unit { side: Side::Brood, class: *c, hp: c.def().hp, pos: (1, 3 + 3 * i as i32), ap: AP_PER_TURN });
        }
        let empire = [Class::Trooper, Class::Trooper, Class::Relay, Class::Trooper, Class::Trooper];
        for (i, c) in empire.iter().enumerate() {
            let x = if *c == Class::Relay { W - 1 } else { W - 2 };
            units.push(Unit { side: Side::Empire, class: *c, hp: c.def().hp, pos: (x, 2 + 3 * i as i32), ap: AP_PER_TURN });
        }
        Game { seed, tiles, units, round: 1, selected: None, outcome: None, log: Vec::new(), events: Vec::new(), rng }
    }

    pub fn tile(&self, p: Pos) -> Tile {
        if in_bounds(p) {
            self.tiles[(p.1 * W + p.0) as usize]
        } else {
            Tile::Wall
        }
    }

    pub fn unit_at(&self, p: Pos) -> Option<usize> {
        self.units.iter().position(|u| u.alive() && u.pos == p)
    }

    /// 중계기가 하나라도 살아 있으면 제국 분대는 시야와 조준 보정을 공유한다.
    pub fn network_up(&self) -> bool {
        self.units.iter().any(|u| u.alive() && u.class == Class::Relay)
    }

    /// 시선. 끝점 순서를 고정해서 a→b와 b→a가 항상 같다.
    pub fn los(&self, a: Pos, b: Pos) -> bool {
        let (a, b) = if a <= b { (a, b) } else { (b, a) };
        let (mut x, mut y) = a;
        let dx = (b.0 - x).abs();
        let dy = -(b.1 - y).abs();
        let sx = if x < b.0 { 1 } else { -1 };
        let sy = if y < b.1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
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

    /// `from`에서 쏠 때 `target` 칸이 받는 엄폐. 사수 쪽 면에 붙은 엄폐물만 센다.
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

    /// `shooter`가 `from` 칸에 있다고 치고 `target` 칸을 쏠 때의 명중률.
    pub fn shot_from(&self, shooter: usize, from: Pos, target: Pos) -> Option<Shot> {
        let u = &self.units[shooter];
        let def = u.class.def();
        let d = dist(from, target);
        if d == 0 || d > def.range || !self.los(from, target) {
            return None;
        }
        let network = if u.side == Side::Empire && self.network_up() { NETWORK_AIM } else { 0 };
        let cover = self.cover(from, target);
        let falloff = (d - FALLOFF_START).max(0) * FALLOFF_PER_TILE;
        let chance = (def.aim + network - cover - falloff).clamp(0, 100);
        Some(Shot { chance, aim: def.aim, network, cover, falloff })
    }

    pub fn shot(&self, shooter: usize, target: usize) -> Option<Shot> {
        let (s, t) = (&self.units[shooter], &self.units[target]);
        if !s.alive() || !t.alive() || s.side == t.side {
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

    /// 행동 1회로 갈 수 있는 칸들과, 각 칸에 오기 직전 칸.
    fn flood(&self, uid: usize) -> (Vec<Pos>, Vec<i32>) {
        let u = &self.units[uid];
        let mut cost = vec![-1i32; (W * H) as usize];
        let mut prev = vec![-1i32; (W * H) as usize];
        let mut queue = vec![u.pos];
        cost[(u.pos.1 * W + u.pos.0) as usize] = 0;
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
                let i = (n.1 * W + n.0) as usize;
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

    /// 행동 1을 써서 `to`로 옮긴다. 갈 수 없으면 false.
    pub(crate) fn move_unit(&mut self, uid: usize, to: Pos) -> bool {
        let Some(path) = self.path_to(uid, to) else { return false };
        let mut from = self.units[uid].pos;
        for p in path {
            self.events.push(Event::Step { unit: uid, from, to: p });
            from = p;
        }
        self.units[uid].pos = to;
        self.units[uid].ap -= 1;
        true
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

    /// 플레이어 입력 하나. 상태가 바뀌었으면 true.
    pub fn click(&mut self, p: Pos) -> bool {
        if self.outcome.is_some() || !in_bounds(p) {
            return false;
        }
        if let Some(t) = self.unit_at(p) {
            if self.units[t].side == Side::Brood {
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
            if self.units[s].ap > 0 {
                return self.move_unit(s, p);
            }
        }
        false
    }

    /// 플레이어 턴을 끝낸다. 제국이 움직이고 다음 라운드가 시작된다.
    pub fn end_turn(&mut self) {
        if self.outcome.is_some() {
            return;
        }
        self.selected = None;
        for i in 0..self.units.len() {
            if self.units[i].side == Side::Empire && self.units[i].alive() {
                ai::act(self, i);
            }
            if self.outcome.is_some() {
                return;
            }
        }
        for u in &mut self.units {
            u.ap = AP_PER_TURN;
        }
        self.round += 1;
    }

    /// 사격은 그 유닛의 턴을 끝낸다.
    pub(crate) fn fire(&mut self, s: usize, t: usize) {
        let Some(shot) = self.shot(s, t) else { return };
        let roll = self.rng.below(100) as i32;
        let hit = roll < shot.chance;
        self.units[s].ap = 0;
        let log_before = self.log.len();
        let (sn, tn) = (self.units[s].class.def().name, self.units[t].class.def().name);
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
        for side in [Side::Brood, Side::Empire] {
            if !self.units.iter().any(|u| u.alive() && u.side == side) {
                self.outcome = Some(if side == Side::Brood { Side::Empire } else { Side::Brood });
            }
        }
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
        }
        h
    }
}
