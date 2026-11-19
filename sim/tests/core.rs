use sim::rng::Rng;
use sim::{Game, Side, H, W};

/// 아무 생각 없는 플레이어: 쏠 수 있으면 제일 높은 확률로 쏘고, 아니면 아무 데나 간다.
fn bot_turn(g: &mut Game, bot: &mut Rng) {
    for s in 0..g.units.len() {
        if g.units[s].side != Side::Brood {
            continue;
        }
        for _ in 0..2 {
            if !g.units[s].alive() || g.units[s].ap == 0 || g.outcome.is_some() {
                break;
            }
            g.click(g.units[s].pos);
            let target = (0..g.units.len())
                .filter_map(|t| g.shot(s, t).map(|sh| (sh.chance, t)))
                .max();
            if let Some((_, t)) = target {
                g.click(g.units[t].pos);
            } else {
                let r = g.reachable(s);
                if r.is_empty() {
                    break;
                }
                g.click(r[bot.below(r.len() as u32) as usize]);
            }
        }
    }
    g.end_turn();
}

fn play(seed: u64) -> (u64, Option<Side>, u32) {
    let mut g = Game::new(seed);
    let mut bot = Rng::new(seed ^ 0x9e3779b97f4a7c15);
    while g.outcome.is_none() && g.round < 80 {
        bot_turn(&mut g, &mut bot);
    }
    (g.fingerprint(), g.outcome, g.round)
}

#[test]
fn same_seed_same_game() {
    for seed in 0..50 {
        assert_eq!(play(seed), play(seed), "seed {seed}");
    }
}

#[test]
fn different_seeds_differ() {
    assert_ne!(play(1).0, play(2).0);
}

#[test]
fn los_is_symmetric() {
    for seed in 0..20 {
        let g = Game::new(seed);
        let mut r = Rng::new(seed);
        for _ in 0..500 {
            let a = (r.below(W as u32) as i32, r.below(H as u32) as i32);
            let b = (r.below(W as u32) as i32, r.below(H as u32) as i32);
            assert_eq!(g.los(a, b), g.los(b, a), "seed {seed} {a:?} {b:?}");
        }
    }
}

#[test]
fn shown_chance_is_the_rolled_chance() {
    // 표시 확률대별로 실제 적중을 세서 비교한다.
    let mut shots = [0u32; 10];
    let mut hits = [0u32; 10];
    for seed in 0..300 {
        let mut g = Game::new(seed);
        let mut bot = Rng::new(seed);
        while g.outcome.is_none() && g.round < 80 {
            let before = g.log.len();
            bot_turn(&mut g, &mut bot);
            for line in &g.log[before..] {
                let Some(pct) = line.split('%').next().and_then(|s| s.rsplit(' ').next()).and_then(|s| s.parse::<usize>().ok()) else {
                    continue;
                };
                let b = (pct / 10).min(9);
                shots[b] += 1;
                if line.contains("적중") {
                    hits[b] += 1;
                }
            }
        }
    }
    for b in 0..10 {
        if shots[b] < 400 {
            continue;
        }
        let actual = hits[b] as f64 / shots[b] as f64;
        let (lo, hi) = (b as f64 / 10.0 - 0.04, b as f64 / 10.0 + 0.14);
        assert!(actual >= lo && actual <= hi, "{}0%대: 실제 {actual:.3} ({} 발)", b, shots[b]);
    }
}

#[test]
fn games_end_and_both_sides_can_win() {
    let (mut brood, mut empire, mut unfinished) = (0, 0, 0);
    for seed in 0..300 {
        match play(seed).1 {
            Some(Side::Brood) => brood += 1,
            Some(Side::Empire) => empire += 1,
            None => unfinished += 1,
        }
    }
    println!("무작위 봇 300판: 승 {brood} / 패 {empire} / 미결 {unfinished}");
    assert!(brood > 0 && empire > 0);
    assert!(unfinished < 60, "미결 {unfinished}");
}

#[test]
fn killing_the_relay_cuts_the_network() {
    let mut g = Game::new(7);
    assert!(g.network_up());
    let relay = g.units.iter().position(|u| u.class == sim::Class::Relay).unwrap();
    g.units[relay].hp = 0;
    assert!(!g.network_up());
}

#[test]
fn events_replay_to_the_same_positions() {
    use sim::Event;
    for seed in 0..40 {
        let mut g = Game::new(seed);
        let mut bot = Rng::new(seed);
        let mut pos: Vec<_> = g.units.iter().map(|u| u.pos).collect();
        let mut hp: Vec<_> = g.units.iter().map(|u| u.hp).collect();
        while g.outcome.is_none() && g.round < 40 {
            bot_turn(&mut g, &mut bot);
            for e in std::mem::take(&mut g.events) {
                match e {
                    Event::Step { unit, from, to } => {
                        assert_eq!(pos[unit], from);
                        assert_eq!((from.0 - to.0).abs() + (from.1 - to.1).abs(), 1);
                        pos[unit] = to;
                    }
                    Event::Shot { target, dmg, killed, .. } => {
                        hp[target] -= dmg;
                        assert_eq!(killed, hp[target] <= 0);
                    }
                }
            }
            for (i, u) in g.units.iter().enumerate() {
                assert_eq!((pos[i], hp[i]), (u.pos, u.hp), "seed {seed} unit {i}");
            }
        }
    }
}
