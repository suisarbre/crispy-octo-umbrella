use sim::world::{SiteKind, World};
use sim::Side;

fn main() {
    let w = World::new(3);
    let home = w.sites.iter().find(|s| s.kind == SiteKind::Hq(Side::Brood)).unwrap().pos;
    println!("{}", web::world::dump(3, &[home, w.sites[7].pos], 20));
}
