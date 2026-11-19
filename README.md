# crispy-octo-umbrella

브라우저에서 도는 확률 기반 분대 전술 게임. 정적 페이지 + WASM, 서버 없음.
무엇을 만들고 무엇을 안 만드는지는 [DESIGN.md](DESIGN.md).

## 조작

- 아군 클릭: 선택
- 밝은 점 클릭: 이동 (행동 1)
- 적 클릭: 사격 (그 유닛의 턴이 끝남). 마우스를 올리면 명중률과 내역이 보인다.
- Space: 턴 종료

## 빌드

```sh
rustup target add wasm32-unknown-unknown   # 처음 한 번
./build.sh
python3 -m http.server -d www 8000
```

```sh
cargo test --release
```

`main`에 푸시하면 테스트를 돌리고 GitHub Pages에 배포한다.
