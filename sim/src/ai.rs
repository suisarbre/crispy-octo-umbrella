//! 제국 병사 한 명의 행동. 아직은 고정 교리다.
//! 병사는 자기가 아는 적만 상대한다. 중계기가 살아 있으면 분대 전체의 시야를,
//! 죽었으면 자기 눈에 보이는 것만 안다.

use crate::{dist, Game, Pos, Side, SIGHT};

/// 이 이상이면 자리를 옮기지 않고 바로 쏜다.
const TAKE_SHOT_AT: i32 = 50;

pub(crate) fn act(g: &mut Game, me: usize) {
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
            g.units[me].pos = best_tile;
            g.units[me].ap -= 1;
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
