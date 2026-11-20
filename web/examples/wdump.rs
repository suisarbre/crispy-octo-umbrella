use sim::world::{SiteKind, World};
use sim::Side;

fn main() {
    // 화면 확인용. 본진의 두 부대를 서로 다른 곳으로 보내고(길이 겹친다), 셋째는 칸만 찍어서 명령 고르기가 뜬 상태로 둔다.
    let w = World::new(3);
    let home = w.sites.iter().find(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap().pos;
    let far = w.sites[7].pos;
    let near = w.route(home, far).unwrap()[9];
    let other = w.sites[10].pos;
    let menu = std::env::args().nth(1).as_deref() == Some("menu");
    let mut steps = vec![home, far, (-1, 0), home, near, (-1, 3), home, other];
    if !menu {
        steps.push((-1, 2));
    }
    println!("{}", web::world::dump(3, &steps, 0));
}
