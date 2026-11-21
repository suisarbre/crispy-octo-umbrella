use sim::world::{SiteKind, World};
use sim::Side;

fn main() {
    // 화면 확인용. 특수부대를 고르고 가까운 거점에 명령을 내린 뒤 출력한다.
    let w = World::new(3);
    let home = w.sites.iter().find(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap().pos;
    let target = w.sites.iter().find(|s| s.pos != home).unwrap().pos;
    let menu = std::env::args().nth(1).as_deref() == Some("menu");
    let mut steps = vec![home, target];
    if !menu {
        steps.push((-1, 0));
    }
    println!("{}", web::world::dump(3, &steps, 0));
}
