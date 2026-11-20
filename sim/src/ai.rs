//! 수 고르기. 체스 엔진처럼 지금 판에서 제일 좋은 다음 행동을 찾되, 아는 것만 가지고 찾는다.
//!
//! - 확률은 기대값으로 센다. 피해가 고정이라 명중률 × 피해면 된다.
//! - 두 턴 반을 본다: 내 행동, 상대의 반격(한 번 움직여 쏠 수 있는 최선), 살아남았을 때
//!   그 자리에서 시작하는 내 다음 턴, 그리고 거기에 대한 반격.
//! - 행동 하나를 하고 나면 결과를 보고 처음부터 다시 고른다.
//! - 탐색량은 판의 크기로만 정해진다. 시간 제한은 쓰지 않는다. 기기마다 결과가 달라지면 세이브가 깨진다.
//!
//! 중계가 살아 있으면 분대가 한 머리로 둔다. 시야와 기억을 합치고, 매번 분대 전체에서
//! 가장 이득이 큰 행동을 고른다. 중계가 끊기면 각자 번호 순서대로, 자기 눈에 보이는 것만 가지고,
//! 상대가 움직일 것도 다음 턴도 계산하지 않고 둔다.

use crate::{dist, Class, Game, Pos, Side, SIGHT, W};

/// 수를 고를 때의 가중치. 탐색기는 그대로 두고 이 값만 바꿔서 성향을 바꾼다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Doctrine {
    /// 줄 피해 1의 값.
    pub dmg: i32,
    /// 사살의 추가 값.
    pub kill: i32,
    /// 받을 피해 1의 값.
    pub threat: i32,
    /// 가장 가까운 적까지 1칸의 값. 쏠 데가 없을 때 다가가게 만든다.
    pub approach: i32,
    /// 이동 한 번의 값. 얻는 게 없으면 안 움직이게 만든다.
    pub step_cost: i32,
    /// 중계기는 받을 피해를 이만큼 더 크게 친다.
    pub relay_caution: i32,
    /// 다음 턴에 얻을 것을 지금 것의 몇 퍼센트로 치는가.
    pub foresight: i32,
}

impl Doctrine {
    /// 제국 기본값. `sweep`으로 재서 골랐다: 덜 물러나고, 더 이기고, 판이 덜 늘어진다.
    pub const STANDARD: Doctrine =
        Doctrine { dmg: 10, kill: 15, threat: 2, approach: 40, step_cost: 10, relay_caution: 3, foresight: 70 };
    /// 몸을 사리는 성향. 시험에서 아군 쪽을 두는 상대로 쓴다. 비교 기준이라 바꾸지 않는다.
    pub const CAUTIOUS: Doctrine =
        Doctrine { dmg: 10, kill: 15, threat: 6, approach: 20, step_cost: 10, relay_caution: 3, foresight: 70 };
}

impl Default for Doctrine {
    fn default() -> Self {
        Doctrine::STANDARD
    }
}

struct Known {
    unit: usize,
    pos: Pos,
    /// 지금 보이는가. 기억만 있는 적은 쏠 수 없고, 위협과 접근에만 쓴다.
    seen: bool,
}

enum Act {
    Shoot(usize),
    Move(Pos),
}

/// 한 번의 선택을 위한 판 읽기. `threat`는 칸마다 한 번만 계산한다.
struct Plan<'a> {
    g: &'a Game,
    side: Side,
    shared: bool,
    known: Vec<Known>,
    /// 아는 적마다, 그 적이 쏘기 시작할 수 있는 칸들.
    launch: Vec<Vec<Pos>>,
    threat: Vec<i32>,
    /// 아래 둘은 `cached_for` 유닛 것이다. 칸마다 한 번만 계산한다.
    cached_for: usize,
    shot: Vec<i32>,
    stand: Vec<i32>,
}

const UNSET: i32 = i32::MIN;

impl<'a> Plan<'a> {
    /// `solo`가 있으면 그 유닛 혼자 본 것만 안다.
    fn new(g: &'a Game, side: Side, solo: Option<usize>) -> Plan<'a> {
        let mut known = Vec::new();
        for (i, u) in g.units.iter().enumerate() {
            if !u.alive() || u.side == side {
                continue;
            }
            match solo {
                Some(me) => {
                    let p = g.units[me].pos;
                    if dist(p, u.pos) <= SIGHT && g.los(p, u.pos) {
                        known.push(Known { unit: i, pos: u.pos, seen: true });
                    }
                }
                None => {
                    if g.seen_by(side, u.pos) {
                        known.push(Known { unit: i, pos: u.pos, seen: true });
                    } else if let (Side::Empire, Some(p)) = (side, g.memory[i]) {
                        known.push(Known { unit: i, pos: p, seen: false });
                    }
                }
            }
        }
        let n = g.tiles.len();
        let mut plan = Plan { g, side, shared: solo.is_none(), known, launch: Vec::new(), threat: vec![UNSET; n], cached_for: usize::MAX, shot: vec![UNSET; n], stand: vec![UNSET; n] };
        plan.launch = (0..plan.known.len())
            .map(|k| {
                let mut from = vec![plan.known[k].pos];
                if plan.shared {
                    let mv = g.units[plan.known[k].unit].class.def().mv;
                    from.extend(g.flood_from(plan.known[k].pos, mv, |p| plan.blocked(p)));
                }
                from
            })
            .collect();
        plan
    }

    fn doctrine(&self) -> &'a Doctrine {
        if self.side == Side::Empire {
            &self.g.doctrine
        } else {
            &self.g.stand_in
        }
    }

    /// 계획이 아는 한에서 막힌 칸. 모르는 적이 서 있는 칸은 비었다고 본다.
    fn blocked(&self, p: Pos) -> bool {
        self.g.units.iter().any(|u| u.alive() && u.side == self.side && u.pos == p)
            || self.known.iter().any(|k| k.pos == p)
    }

    /// 이 칸에 서 있으면 다음 상대 차례에 받을 피해의 기대값 × 100.
    fn threat_at(&mut self, tile: Pos) -> i32 {
        let i = (tile.1 * W + tile.0) as usize;
        if self.threat[i] == UNSET {
            let mut sum = 0;
            for (k, known) in self.known.iter().enumerate() {
                let best = self.launch[k]
                    .iter()
                    .filter_map(|&from| self.g.shot_from(known.unit, from, tile))
                    .map(|s| s.chance)
                    .max()
                    .unwrap_or(0);
                sum += best * self.g.units[known.unit].class.def().dmg;
            }
            self.threat[i] = sum;
        }
        self.threat[i]
    }

    /// 이 칸에서 턴을 마치고 반격 한 번을 받는 것까지의 값.
    fn rest(&mut self, me: usize, tile: Pos) -> i32 {
        let d = self.doctrine();
        let relay = self.g.units[me].class == Class::Relay;
        let caution = if relay { d.relay_caution } else { 1 };
        let threat = self.threat_at(tile) * d.threat * caution;
        let pull = if relay {
            0
        } else if let Some(near) = self.known.iter().map(|k| dist(tile, k.pos)).min() {
            near * d.approach
        } else if self.shared {
            // 아는 적이 없으면 상대 진영 쪽으로.
            (if self.side == Side::Empire { tile.0 } else { W - 1 - tile.0 }) * d.approach
        } else {
            0
        };
        -threat - pull
    }

    /// 이 칸에서 턴을 마치는 것의 값. 분대로 둘 때는 살아남았을 경우의 다음 턴까지 본다.
    fn stand(&mut self, me: usize, tile: Pos) -> i32 {
        if self.cached_for != me {
            self.cached_for = me;
            self.shot.iter_mut().for_each(|v| *v = UNSET);
            self.stand.iter_mut().for_each(|v| *v = UNSET);
        }
        let i = (tile.1 * W + tile.0) as usize;
        if self.stand[i] == UNSET {
            self.stand[i] = self.stand_uncached(me, tile);
        }
        self.stand[i]
    }

    fn stand_uncached(&mut self, me: usize, tile: Pos) -> i32 {
        let now = self.rest(me, tile);
        if !self.shared {
            return now;
        }
        // 다음 턴: 여기서 쏘거나, 한 번 가서 쏘거나, 더 나은 자리로 간다. 그 끝에서 또 반격을 받는다.
        let step = self.doctrine().step_cost;
        let mv = self.g.units[me].class.def().mv;
        let mut next = self.shot_value(me, tile);
        for a in self.g.flood_from(tile, mv, |p| self.blocked(p)) {
            let there = self.shot_value(me, a) + self.rest(me, a) - now - step;
            next = next.max(there);
        }
        // 반격에 죽으면 다음 턴은 없다.
        let hp = self.g.units[me].hp * 100;
        let alive = (hp - self.threat_at(tile)).clamp(0, hp);
        now + next * alive / hp * self.doctrine().foresight / 100
    }

    fn shot_value(&mut self, me: usize, from: Pos) -> i32 {
        let i = (from.1 * W + from.0) as usize;
        if self.shot[i] == UNSET {
            self.shot[i] = self.best_shot(me, from).map_or(0, |(_, v)| v);
        }
        self.shot[i]
    }

    /// `from`에서 쏠 수 있는 가장 값진 사격. (표적, 값)
    fn best_shot(&self, me: usize, from: Pos) -> Option<(usize, i32)> {
        let d = self.doctrine();
        let dmg = self.g.units[me].class.def().dmg;
        let mut best: Option<(usize, i32)> = None;
        for k in self.known.iter().filter(|k| k.seen) {
            let Some(shot) = self.g.shot_from(me, from, k.pos) else { continue };
            let hp = self.g.units[k.unit].hp;
            let value = shot.chance * (d.dmg * dmg.min(hp) + if dmg >= hp { d.kill } else { 0 });
            if value > 0 && best.map_or(true, |(_, v)| value > v) {
                best = Some((k.unit, value));
            }
        }
        best
    }

    /// 이 유닛의 가장 좋은 다음 행동과, 가만히 있는 것보다 얼마나 나은지.
    fn best_action(&mut self, me: usize) -> Option<(Act, i32)> {
        let here = self.g.units[me].pos;
        let ap = self.g.units[me].ap;
        let mv = self.g.units[me].class.def().mv;
        let step = self.doctrine().step_cost;
        let hold = self.stand(me, here);
        let mut best: Option<Act> = None;
        let mut best_value = hold;

        if let Some((t, v)) = self.best_shot(me, here) {
            best = Some(Act::Shoot(t));
            best_value = hold + v;
        }
        for a in self.g.flood_from(here, mv, |p| self.blocked(p)) {
            let at_a = self.stand(me, a);
            let mut value = at_a;
            if ap >= 2 {
                // 가서 쏘거나, 한 번 더 간다.
                if let Some((_, v)) = self.best_shot(me, a) {
                    value = value.max(at_a + v);
                }
                for b in self.g.flood_from(a, mv, |p| self.blocked(p)) {
                    value = value.max(self.stand(me, b) - step);
                }
            }
            value -= step;
            if value > best_value {
                best_value = value;
                best = Some(Act::Move(a));
            }
        }
        best.map(|act| (act, best_value - hold))
    }
}

/// 실행한다. 못 가는 칸이었으면(모르는 적이 길을 막고 있었다) false.
fn apply(g: &mut Game, me: usize, act: Act) -> bool {
    match act {
        Act::Shoot(t) => {
            g.fire(me, t);
            true
        }
        Act::Move(p) => {
            let moved = g.move_unit(me, p);
            g.observe();
            moved
        }
    }
}

/// `side`의 차례를 끝까지 둔다.
pub fn run(g: &mut Game, side: Side) {
    let mine = |g: &Game, i: usize| g.units[i].side == side && g.units[i].alive() && g.units[i].ap > 0;
    let n = g.units.len();
    let mut done = vec![false; n];

    // 분대가 한 머리로 둔다: 매번 분대 전체에서 이득이 가장 큰 행동 하나.
    while g.outcome.is_none() && (side == Side::Brood || g.network_up()) {
        let mut plan = Plan::new(g, side, None);
        let mut pick: Option<(usize, Act, i32)> = None;
        for i in (0..n).filter(|&i| mine(g, i) && !done[i]) {
            if let Some((act, gain)) = plan.best_action(i) {
                if gain > 0 && pick.as_ref().map_or(true, |p| gain > p.2) {
                    pick = Some((i, act, gain));
                }
            }
        }
        let Some((i, act, _)) = pick else { return };
        if !apply(g, i, act) {
            done[i] = true;
        }
    }

    // 중계 두절: 각자, 번호 순서대로, 자기 눈으로.
    for i in 0..n {
        while g.outcome.is_none() && mine(g, i) {
            let picked = Plan::new(g, side, Some(i)).best_action(i);
            match picked {
                Some((act, gain)) if gain > 0 => {
                    if !apply(g, i, act) {
                        break;
                    }
                }
                _ => break,
            }
        }
    }
}

#[cfg(test)]
mod legacy {
    //! 예전 고정 교리. 새 탐색기와 견줘 보는 데만 쓴다.
    use crate::{dist, Game, Pos, Side, SIGHT};

/// 이 이상이면 자리를 옮기지 않고 바로 쏜다.
    const TAKE_SHOT_AT: i32 = 50;
    
    pub(super) fn act(g: &mut Game, me: usize) {
        while g.units[me].ap > 0 && g.outcome.is_none() {
            let known = known_enemies(g, me);
            let here = g.units[me].pos;
            let best_now = best_shot(g, me, here, &known);
    
            if let Some((t, chance)) = best_now {
                if chance >= TAKE_SHOT_AT {
                    g.fire(me, t);
                    return;
                }
            }
    
            let mut best_tile = here;
            let mut best_score = score(g, me, here, here, &known);
            for p in g.reachable(me) {
                let s = score(g, me, p, here, &known);
                if s > best_score {
                    best_score = s;
                    best_tile = p;
                }
            }
    
            if best_tile != here {
                if !g.move_unit(me, best_tile) {
                    return;
                }
                continue;
            }
            if let Some((t, chance)) = best_now {
                if chance > 0 {
                    g.fire(me, t);
                }
            }
            return;
        }
    }
    
    fn known_enemies(g: &Game, me: usize) -> Vec<usize> {
        let shared = g.network_up();
        let my_pos = g.units[me].pos;
        (0..g.units.len())
            .filter(|&i| {
                let u = &g.units[i];
                if !u.alive() || u.side != Side::Brood {
                    return false;
                }
                if shared {
                    g.seen_by(Side::Empire, u.pos)
                } else {
                    dist(my_pos, u.pos) <= SIGHT && g.los(my_pos, u.pos)
                }
            })
            .collect()
    }
    
    fn best_shot(g: &Game, me: usize, from: Pos, known: &[usize]) -> Option<(usize, i32)> {
        let mut best: Option<(usize, i32)> = None;
        for &t in known {
            if let Some(s) = g.shot_from(me, from, g.units[t].pos) {
                if best.map_or(true, |(_, c)| s.chance > c) {
                    best = Some((t, s.chance));
                }
            }
        }
        best
    }
    
    fn score(g: &Game, me: usize, tile: Pos, here: Pos, known: &[usize]) -> i32 {
        if known.is_empty() {
            // 아는 적이 없다. 망이 살아 있으면 전진, 끊겼으면 제자리.
            return if g.network_up() { -tile.0 * 4 } else { -dist(tile, here) };
        }
        let offense = best_shot(g, me, tile, known).map_or(0, |(_, c)| c);
        let mut threat = 0;
        let mut nearest = i32::MAX;
        for &e in known {
            let ep = g.units[e].pos;
            nearest = nearest.min(dist(tile, ep));
            if let Some(s) = g.shot_from(e, ep, tile) {
                threat = threat.max(s.chance);
            }
        }
        offense * 10 - threat * 8 - nearest * 2 - dist(tile, here)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AP_PER_TURN;
    use std::time::{Duration, Instant};

    struct Tally {
        brood: u32,
        empire: u32,
        open: u32,
        slowest: Duration,
        total: Duration,
        turns: u32,
        /// 제국 병사가 턴을 마쳤을 때 가장 가까운 적과의 거리가 어떻게 됐는가.
        closer: u32,
        farther: u32,
        rounds: u32,
    }

    fn gaps(g: &Game) -> Vec<Option<i32>> {
        g.units
            .iter()
            .map(|u| {
                if u.side != Side::Empire || !u.alive() || u.class == Class::Relay {
                    return None;
                }
                g.units.iter().filter(|b| b.side == Side::Brood && b.alive()).map(|b| dist(u.pos, b.pos)).min()
            })
            .collect()
    }

    /// 아군도 탐색기가 둔다. 제국만 예전 교리와 새 탐색기를 바꿔 가며 붙인다.
    fn tournament(games: u64, new_empire: bool, doctrine: &Doctrine) -> Tally {
        let mut t = Tally { brood: 0, empire: 0, open: 0, slowest: Duration::ZERO, total: Duration::ZERO, turns: 0, closer: 0, farther: 0, rounds: 0 };
        for seed in 0..games {
            let mut g = Game::new(seed);
            g.doctrine = doctrine.clone();
            while g.outcome.is_none() && g.round < 60 {
                run(&mut g, Side::Brood);
                if g.outcome.is_some() {
                    break;
                }
                let before = gaps(&g);
                let start = Instant::now();
                if new_empire {
                    run(&mut g, Side::Empire);
                } else {
                    for i in 0..g.units.len() {
                        if g.units[i].side == Side::Empire && g.units[i].alive() && g.outcome.is_none() {
                            legacy::act(&mut g, i);
                        }
                    }
                }
                let took = start.elapsed();
                t.slowest = t.slowest.max(took);
                t.total += took;
                t.turns += 1;
                for (b, a) in before.iter().zip(gaps(&g)) {
                    if let (Some(b), Some(a)) = (b, a) {
                        t.closer += (a < *b) as u32;
                        t.farther += (a > *b) as u32;
                    }
                }
                for u in &mut g.units {
                    u.ap = AP_PER_TURN;
                }
                g.round += 1;
            }
            t.rounds += g.round;
            match g.outcome {
                Some(Side::Brood) => t.brood += 1,
                Some(Side::Empire) => t.empire += 1,
                None => t.open += 1,
            }
        }
        t
    }

    #[test]
    fn search_beats_the_old_doctrine() {
        let old = tournament(300, false, &Doctrine::STANDARD);
        let new = tournament(300, true, &Doctrine::STANDARD);
        for (name, t) in [("예전", &old), ("탐색", &new)] {
            println!(
                "{name}: 제국 승 {} / 패 {} / 미결 {}   다가감 {} / 물러남 {}   판당 {} 라운드   턴당 평균 {:?}, 최장 {:?}",
                t.empire,
                t.brood,
                t.open,
                t.closer,
                t.farther,
                t.rounds / 300,
                t.total / t.turns.max(1),
                t.slowest
            );
        }
        assert!(new.empire > old.empire, "탐색 {} vs 예전 {}", new.empire, old.empire);
    }

    /// 가중치를 바꿔 가며 성향을 본다. `cargo test -p sim --release sweep -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn sweep() {
        println!("위협 접근 예견 | 승  패 미결 | 다가감 물러남 | 라운드");
        for threat in [1, 2, 3, 4, 6] {
            for approach in [20, 40] {
                for foresight in [70, 100] {
                    let d = Doctrine { threat, approach, foresight, ..Doctrine::STANDARD };
                    let t = tournament(120, true, &d);
                    println!(
                        "{threat:>4} {approach:>4} {foresight:>4} | {:>3} {:>3} {:>3} | {:>5} {:>5} | {:>3}",
                        t.empire,
                        t.brood,
                        t.open,
                        t.closer,
                        t.farther,
                        t.rounds / 120
                    );
                }
            }
        }
    }

    /// 한 판을 끝까지. 양쪽 다 탐색기가 둔다.
    fn duel(seed: u64, empire: &Doctrine, brood: &Doctrine) -> Option<Side> {
        let mut g = Game::new(seed);
        g.doctrine = empire.clone();
        g.stand_in = brood.clone();
        while g.outcome.is_none() && g.round < 40 {
            run(&mut g, Side::Brood);
            if g.outcome.is_none() {
                run(&mut g, Side::Empire);
            }
            for u in &mut g.units {
                u.ap = AP_PER_TURN;
            }
            g.round += 1;
        }
        g.outcome
    }

    /// 여러 판의 (제국 승, 제국 패). 코어를 나눠 쓴다.
    fn series(seeds: std::ops::Range<u64>, empire: &Doctrine, brood: &Doctrine) -> (i32, i32) {
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get()) as u64;
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|k| {
                    let seeds = seeds.clone();
                    scope.spawn(move || {
                        let (mut won, mut lost) = (0, 0);
                        for seed in seeds.filter(|s| s % threads == k) {
                            match duel(seed, empire, brood) {
                                Some(Side::Empire) => won += 1,
                                Some(Side::Brood) => lost += 1,
                                None => {}
                            }
                        }
                        (won, lost)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
        })
    }

    fn show(d: &Doctrine) -> String {
        format!("위협 {:>2} 접근 {:>3} 예견 {:>3} 사살 {:>2} 중계조심 {}", d.threat, d.approach, d.foresight, d.kill, d.relay_caution)
    }

    /// 적응 실험. 아군 쪽 성향을 셋으로 바꿔 놓고, 제국 가중치를 모의전 결과만 보고 조금씩 고친다.
    /// 끝에 남은 가중치가 상대마다 다르고, 자기 상대에게 제일 잘 통하면 적응이 된다는 뜻이다.
    /// `cargo test -p sim --release adaptation -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn adaptation() {
        const TRAIN: std::ops::Range<u64> = 0..160;
        const HELD_OUT: std::ops::Range<u64> = 10_000..10_400;
        let players = [
            ("소심", Doctrine::CAUTIOUS),
            ("돌격", Doctrine { threat: 0, approach: 60, ..Doctrine::CAUTIOUS }),
            ("사살욕심", Doctrine { threat: 3, approach: 40, kill: 60, ..Doctrine::CAUTIOUS }),
        ];
        let score = |d: &Doctrine, p: &Doctrine, seeds: std::ops::Range<u64>| {
            let (won, lost) = series(seeds, d, p);
            won - lost
        };
        let mut adapted = Vec::new();
        for (name, player) in &players {
            let mut d = Doctrine::STANDARD;
            let mut best = score(&d, player, TRAIN);
            println!("\n[{name}] 시작  {}  점수 {best:+}", show(&d));
            for _pass in 0..2 {
                for knob in 0..5 {
                    for dir in [-1, 1] {
                        let mut c = d.clone();
                        match knob {
                            0 => c.threat = (c.threat + dir).max(0),
                            1 => c.approach = (c.approach + 20 * dir).max(0),
                            2 => c.foresight = (c.foresight + 30 * dir).clamp(0, 130),
                            3 => c.kill = (c.kill + 15 * dir).max(0),
                            _ => c.relay_caution = (c.relay_caution + dir).max(1),
                        }
                        if c == d {
                            continue;
                        }
                        let s = score(&c, player, TRAIN);
                        // 잡음에 끌려가지 않게, 뚜렷이 나아질 때만 옮긴다.
                        if s >= best + 8 {
                            best = s;
                            d = c;
                            println!("[{name}] 고침  {}  점수 {best:+}", show(&d));
                        }
                    }
                }
            }
            adapted.push(d);
        }
        println!("\n처음 보는 판 {}개에서 (제국 승 − 제국 패)", HELD_OUT.end - HELD_OUT.start);
        println!("{:<12} | {:>6} {:>6} {:>8}", "제국 \\ 상대", "소심", "돌격", "사살욕심");
        let mut rows = vec![("기본".to_string(), Doctrine::STANDARD)];
        rows.extend(players.iter().zip(&adapted).map(|((n, _), d)| (format!("{n}에 적응"), d.clone())));
        for (name, d) in &rows {
            let cells: Vec<String> = players.iter().map(|(_, p)| format!("{:>+6}", score(d, p, HELD_OUT))).collect();
            println!("{name:<12} | {}", cells.join(" "));
        }
    }

    /// 12 대 12가 얼마나 걸리는지 잰다. `cargo test -p sim --release big_battle -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn big_battle() {
        use Class::*;
        let brood = [Lancer, Lancer, Lancer, Shell, Shell, Shell, Shell, Stalker, Stalker, Stalker, Stalker, Stalker];
        let mut empire = [Trooper; 12];
        empire[6] = Relay;
        for (label, b, e) in [("4 대 5", &brood[..0], &empire[..0]), ("8 대 8", &brood[2..10], &empire[2..10]), ("12 대 12", &brood[..], &empire[..])] {
            let (mut won, mut lost, mut rounds, mut turns) = (0, 0, 0, 0);
            let (mut think, mut slowest, mut actions) = (Duration::ZERO, Duration::ZERO, 0usize);
            let games = 30;
            for seed in 0..games {
                let mut g = if b.is_empty() { Game::new(seed) } else { Game::with_units(seed, b, e) };
                while g.outcome.is_none() && g.round < 60 {
                    run(&mut g, Side::Brood);
                    if g.outcome.is_none() {
                        let before = g.events.len();
                        let start = Instant::now();
                        run(&mut g, Side::Empire);
                        let took = start.elapsed();
                        think += took;
                        slowest = slowest.max(took);
                        turns += 1;
                        actions += g.events.len() - before;
                    }
                    for u in &mut g.units {
                        u.ap = AP_PER_TURN;
                    }
                    g.round += 1;
                }
                rounds += g.round;
                match g.outcome {
                    Some(Side::Empire) => won += 1,
                    Some(Side::Brood) => lost += 1,
                    None => {}
                }
            }
            println!(
                "{label}: 제국 승 {won} / 패 {lost} / {games}판   판당 {} 라운드   제국 턴 평균 {:?}, 최장 {:?}   제국 턴당 화면 박자 {}",
                rounds / games as u32,
                think / turns.max(1),
                slowest,
                actions / turns.max(1) as usize
            );
        }
    }

    #[test]
    fn a_cut_relay_makes_the_squad_worse() {
        let mut wins = [0u32; 2];
        for (k, cut) in [false, true].into_iter().enumerate() {
            for seed in 0..300 {
                let mut g = Game::new(seed);
                if cut {
                    let relay = g.units.iter().position(|u| u.class == Class::Relay).unwrap();
                    g.units[relay].hp = 0;
                }
                while g.outcome.is_none() && g.round < 60 {
                    run(&mut g, Side::Brood);
                    if g.outcome.is_none() {
                        run(&mut g, Side::Empire);
                    }
                    for u in &mut g.units {
                        u.ap = AP_PER_TURN;
                    }
                    g.round += 1;
                }
                if g.outcome == Some(Side::Empire) {
                    wins[k] += 1;
                }
            }
        }
        println!("제국 승: 연결 {} / 두절 {} (300판씩)", wins[0], wins[1]);
        assert!(wins[0] > wins[1]);
    }
}
