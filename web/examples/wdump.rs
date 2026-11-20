use sim::world::{SiteKind, World};
use sim::Side;

fn main() {
    // 화면 확인용. 본진의 세 부대를 서로 다른 곳으로 보낸다. 둘은 길이 겹친다.
    let w = World::new(3);
    let home = w.sites.iter().find(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap().pos;
    let far = w.sites[7].pos;
    let near = w.route(home, far).unwrap()[9];
    let other = w.sites[10].pos;
    println!("{}", web::world::dump(3, &[home, far, home, near, home, other], 4));
}
