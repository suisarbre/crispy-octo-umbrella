#!/usr/bin/env sh
# game.wasm을 빌드해서 www/에 놓는다. 처음 한 번: rustup target add wasm32-unknown-unknown
set -eu
cd "$(dirname "$0")"
cargo build -p web --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/web.wasm www/game.wasm
echo "www/game.wasm 준비됨. 실행: python3 -m http.server -d www 8000"
