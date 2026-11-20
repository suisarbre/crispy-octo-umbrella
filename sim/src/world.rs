//! 월드. 거점과 길로 된 지도 위에서 시간이 흐르고 부대가 움직인다.
//! 전투와 마찬가지로 결정론적이다. 상태를 바꾸는 입구는 `click`과 `tick` 둘뿐이라서
//! (시드, 입력과 틱의 순서)만 있으면 그대로 재현된다. 시간은 고정 틱으로만 센다.

use crate::rng::Rng;
use crate::{Pos, Side};

pub const WW: i32 = 40;
pub const WH: i32 = 24;
/// 거점은 이 크기의 칸마다 하나씩 놓인다.
const CELL: i32 = 8;
const COLS: i32 = WW / CELL;
const ROWS: i32 = WH / CELL;
/// 한 칸을 가는 데 드는 틱: 기본값에 인원이 많을수록 더.
const STEP_TICKS: u32 = 4;
const TICKS_PER_HEAD: u32 = 3;

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
    Plain,
    /// 그 진영의 본진.
    Hq(Side),
}

#[derive(Clone, Debug)]
pub struct Site {
    pub pos: Pos,
    pub kind: SiteKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Order {
    Hold,
    /// 남은 길. 앞에서부터 한 칸씩 간다.
    Move(Vec<Pos>),
}

#[derive(Clone, Debug)]
pub struct Force {
    pub side: Side,
    pub pos: Pos,
    /// 인원. 많을수록 느리다.
    pub size: u32,
    pub order: Order,
    /// 다음 칸까지 쌓인 틱.
    pub progress: u32,
}

impl Force {
    /// 한 칸을 가는 데 드는 틱.
    pub fn step_ticks(&self) -> u32 {
        STEP_TICKS + self.size / TICKS_PER_HEAD
    }
}

#[derive(Clone, Debug)]
pub struct World {
    pub seed: u64,
    pub ground: Vec<Ground>,
    pub sites: Vec<Site>,
    pub forces: Vec<Force>,
    pub tick: u64,
    pub selected: Option<usize>,
    /// 마주친 두 부대. 생기면 시간이 멈춘다. 전투는 아직 붙이지 않았다.
    pub clash: Option<(usize, usize)>,
}

fn idx(p: Pos) -> usize {
    (p.1 * WW + p.0) as usize
}

pub fn in_world(p: Pos) -> bool {
    p.0 >= 0 && p.1 >= 0 && p.0 < WW && p.1 < WH
}

impl World {
    pub fn new(seed: u64) -> World {
        let mut rng = Rng::new(seed ^ 0x776f726c64);
        let mut ground = vec![Ground::Wild; (WW * WH) as usize];

        // 거점: 칸마다 하나, 칸 안에서 조금씩 흩어 놓는다.
        let mut sites = Vec::new();
        for cy in 0..ROWS {
            for cx in 0..COLS {
                let x = cx * CELL + 2 + rng.below((CELL - 4) as u32) as i32;
                let y = cy * CELL + 2 + rng.below((CELL - 4) as u32) as i32;
                sites.push(Site { pos: (x, y), kind: SiteKind::Plain });
            }
        }
        let site_at = |cx: i32, cy: i32| (cy * COLS + cx) as usize;

        // 길: 이웃 거점끼리 잇되 몇 개는 뺀다. 빼고도 전부 이어지게 한다.
        let mut edges: Vec<(usize, usize)> = Vec::new();
        let mut spare: Vec<(usize, usize)> = Vec::new();
        for cy in 0..ROWS {
            for cx in 0..COLS {
                if cx + 1 < COLS {
                    let e = (site_at(cx, cy), site_at(cx + 1, cy));
                    if rng.below(100) < 75 { edges.push(e) } else { spare.push(e) }
                }
                if cy + 1 < ROWS {
                    let e = (site_at(cx, cy), site_at(cx, cy + 1));
                    if rng.below(100) < 55 { edges.push(e) } else { spare.push(e) }
                }
            }
        }
        let mut group: Vec<usize> = (0..sites.len()).collect();
        fn root(group: &mut [usize], mut i: usize) -> usize {
            while group[i] != i {
                group[i] = group[group[i]];
                i = group[i];
            }
            i
        }
        for &(a, b) in &edges {
            let (ra, rb) = (root(&mut group, a), root(&mut group, b));
            group[ra] = rb;
        }
        for (a, b) in spare {
            let (ra, rb) = (root(&mut group, a), root(&mut group, b));
            if ra != rb {
                group[ra] = rb;
                edges.push((a, b));
            }
        }
        for (a, b) in edges {
            let (p, q) = (sites[a].pos, sites[b].pos);
            // ㄱ자 길. 어느 쪽으로 먼저 꺾을지는 주사위.
            let elbow = if rng.below(2) == 0 { (q.0, p.1) } else { (p.0, q.1) };
            for (from, to) in [(p, elbow), (elbow, q)] {
                let (mut x, mut y) = from;
                loop {
                    ground[idx((x, y))] = Ground::Road;
                    if (x, y) == to {
                        break;
                    }
                    x += (to.0 - x).signum();
                    y += (to.1 - y).signum();
                }
            }
        }
        for (i, s) in sites.iter().enumerate() {
            ground[idx(s.pos)] = Ground::Site(i);
        }

        // 본진: 아군은 서쪽 끝 줄, 인류는 동쪽 끝 줄의 거점 하나.
        let home = site_at(0, rng.below(ROWS as u32) as i32);
        let enemy = site_at(COLS - 1, rng.below(ROWS as u32) as i32);
        sites[home].kind = SiteKind::Hq(Side::Brood);
        sites[enemy].kind = SiteKind::Hq(Side::Empire);

        let force = |side, pos, size| Force { side, pos, size, order: Order::Hold, progress: 0 };
        let mut forces = vec![
            force(Side::Brood, sites[home].pos, 6),
            force(Side::Brood, sites[home].pos, 6),
            force(Side::Brood, sites[home].pos, 2),
            force(Side::Empire, sites[enemy].pos, 12),
        ];
        // 인류의 전방 부대 둘. 동쪽에서 둘째 줄의 서로 다른 거점에.
        let first = rng.below(ROWS as u32) as i32;
        let second = (first + 1 + rng.below((ROWS - 1) as u32) as i32) % ROWS;
        for row in [first, second] {
            forces.push(force(Side::Empire, sites[site_at(COLS - 2, row)].pos, 6));
        }

        World { seed, ground, sites, forces, tick: 0, selected: None, clash: None }
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
        (0..self.forces.len()).filter(move |&i| self.forces[i].pos == p)
    }

    /// 길을 따라 `from`에서 `to`까지. 출발 칸은 빼고 도착 칸은 넣는다. 길이 없으면 None.
    pub fn route(&self, from: Pos, to: Pos) -> Option<Vec<Pos>> {
        if !self.walkable(from) || !self.walkable(to) {
            return None;
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

    /// 플레이어 입력: 칸 하나를 누른다. 상태가 바뀌었으면 true.
    /// 아군 부대가 있는 칸이면 고른다 (겹쳐 있으면 누를 때마다 다음 부대).
    /// 부대를 고른 채 길 위의 칸을 누르면 거기로 보낸다. 그 밖의 칸이면 선택을 푼다.
    pub fn click(&mut self, p: Pos) -> bool {
        if !in_world(p) {
            return false;
        }
        let mine: Vec<usize> = self.forces_at(p).filter(|&i| self.forces[i].side == Side::Brood).collect();
        let moving_here = self.selected.is_some_and(|s| self.forces[s].pos != p);
        if !mine.is_empty() && !moving_here {
            let next = match self.selected.and_then(|s| mine.iter().position(|&i| i == s)) {
                Some(k) => mine[(k + 1) % mine.len()],
                None => mine[0],
            };
            let changed = self.selected != Some(next);
            self.selected = Some(next);
            return changed;
        }
        let Some(s) = self.selected else { return false };
        match self.route(self.forces[s].pos, p) {
            Some(path) if !path.is_empty() => {
                self.forces[s].order = Order::Move(path);
                self.forces[s].progress = 0;
                self.clash = None;
            }
            _ => self.selected = None,
        }
        true
    }

    /// 시간을 한 틱 넘긴다. 부대가 마주치면 `clash`가 서고 그 뒤로는 넘어가지 않는다.
    pub fn tick(&mut self) {
        if self.clash.is_some() {
            return;
        }
        self.tick += 1;
        for i in 0..self.forces.len() {
            let Order::Move(path) = &self.forces[i].order else { continue };
            let Some(&next) = path.first() else {
                self.forces[i].order = Order::Hold;
                continue;
            };
            self.forces[i].progress += 1;
            if self.forces[i].progress < self.forces[i].step_ticks() {
                continue;
            }
            self.forces[i].progress = 0;
            let side = self.forces[i].side;
            let foe = (0..self.forces.len()).find(|&j| self.forces[j].pos == next && self.forces[j].side != side);
            if let Some(foe) = foe {
                // 적이 길을 막고 있다. 그 자리에 서서 마주본다.
                self.forces[i].order = Order::Hold;
                self.clash = Some((i, foe));
                return;
            }
            self.forces[i].pos = next;
            if let Order::Move(path) = &mut self.forces[i].order {
                path.remove(0);
                if path.is_empty() {
                    self.forces[i].order = Order::Hold;
                }
            }
        }
    }

    pub fn fingerprint(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        };
        mix(self.tick);
        for f in &self.forces {
            mix(idx(f.pos) as u64);
            mix(f.size as u64);
            mix(f.progress as u64);
            mix(match &f.order {
                Order::Hold => 0,
                Order::Move(path) => 1 + path.len() as u64,
            });
        }
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_site_is_connected_by_road() {
        for seed in 0..200 {
            let w = World::new(seed);
            assert_eq!(w.sites.len(), (COLS * ROWS) as usize);
            for s in &w.sites[1..] {
                assert!(w.route(w.sites[0].pos, s.pos).is_some(), "seed {seed}: {:?}", s.pos);
            }
            let hqs: Vec<_> = w.sites.iter().filter(|s| matches!(s.kind, SiteKind::Hq(_))).collect();
            assert_eq!(hqs.len(), 2);
            assert!(hqs.iter().any(|s| s.kind == SiteKind::Hq(Side::Brood) && s.pos.0 < CELL));
            assert!(hqs.iter().any(|s| s.kind == SiteKind::Hq(Side::Empire) && s.pos.0 >= WW - CELL));
        }
    }

    #[test]
    fn maps_differ_by_seed_and_repeat_for_the_same_seed() {
        assert_eq!(World::new(5).ground, World::new(5).ground);
        assert_ne!(World::new(5).ground, World::new(6).ground);
    }

    fn home(w: &World) -> Pos {
        w.sites.iter().find(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap().pos
    }

    #[test]
    fn a_force_walks_its_route_one_tile_at_a_time() {
        let mut w = World::new(3);
        let start = home(&w);
        let dest = w.sites.iter().map(|s| s.pos).find(|&p| p != start && w.route(start, p).unwrap().len() < 14).unwrap();
        let path = w.route(start, dest).unwrap();
        assert!(w.click(start));
        assert!(w.click(dest));
        let s = w.selected.unwrap();
        let per_tile = w.forces[s].step_ticks() as usize;
        for (n, p) in path.iter().enumerate() {
            for _ in 0..per_tile {
                assert_ne!(w.forces[s].pos, *p, "{n}번째 칸에 너무 일찍 도착");
                w.tick();
            }
            assert_eq!(w.forces[s].pos, *p);
        }
        assert_eq!(w.forces[s].order, Order::Hold);
        assert_eq!(w.tick, (path.len() * per_tile) as u64);
    }

    #[test]
    fn stacked_forces_cycle_and_small_ones_are_faster() {
        let mut w = World::new(3);
        let start = home(&w);
        let mut seen = Vec::new();
        for _ in 0..3 {
            assert!(w.click(start));
            seen.push(w.selected.unwrap());
        }
        seen.sort();
        assert_eq!(seen, vec![0, 1, 2]);
        assert!(w.forces[2].step_ticks() < w.forces[0].step_ticks());
    }

    #[test]
    fn clicking_off_the_road_deselects() {
        let mut w = World::new(3);
        w.click(home(&w));
        let wild = (0..WW * WH).map(|i| (i % WW, i / WW)).find(|&p| !w.walkable(p)).unwrap();
        assert!(w.click(wild));
        assert!(w.selected.is_none());
    }

    #[test]
    fn meeting_the_enemy_stops_time() {
        let mut w = World::new(3);
        let start = home(&w);
        let enemy = w.forces.iter().position(|f| f.side == Side::Empire).unwrap();
        let target = w.forces[enemy].pos;
        w.click(start);
        w.click(target);
        let s = w.selected.unwrap();
        for _ in 0..5000 {
            w.tick();
        }
        let (a, b) = w.clash.expect("마주쳐야 한다");
        assert_eq!(a, s);
        assert_eq!(w.forces[b].side, Side::Empire);
        // 적의 칸으로 들어가지 않고 바로 앞에 선다. 시간은 멈춰 있다.
        let (p, q) = (w.forces[a].pos, w.forces[b].pos);
        assert_eq!((p.0 - q.0).abs() + (p.1 - q.1).abs(), 1);
        let frozen = w.tick;
        w.tick();
        assert_eq!(w.tick, frozen);
    }

    #[test]
    fn same_inputs_same_world() {
        let run = || {
            let mut w = World::new(9);
            let start = home(&w);
            w.click(start);
            w.click(w.sites[7].pos);
            for _ in 0..300 {
                w.tick();
            }
            w.fingerprint()
        };
        assert_eq!(run(), run());
    }
}
