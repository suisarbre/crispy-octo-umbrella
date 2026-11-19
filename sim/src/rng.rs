//! PCG32. 게임 안의 모든 난수는 여기서만 나온다.
//! 같은 시드 + 같은 입력 = 같은 결과.

#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
}

const MUL: u64 = 6364136223846793005;
const INC: u64 = 1442695040888963407;

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut r = Rng { state: 0 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MUL).wrapping_add(INC);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// 0..n 균등 분포 (나머지 편향 없음).
    pub fn below(&mut self, n: u32) -> u32 {
        debug_assert!(n > 0);
        let threshold = n.wrapping_neg() % n;
        loop {
            let r = self.next_u32();
            if r >= threshold {
                return r % n;
            }
        }
    }

    pub fn state(&self) -> u64 {
        self.state
    }
}
