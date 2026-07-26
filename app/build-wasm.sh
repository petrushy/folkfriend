#!/usr/bin/env bash
# Rebuild the Rust WASM and copy it into the Vue app (app/src/wasm/).
#
# Runs automatically before `npm run build` via the "prebuild" script, so the
# bundled/deployed WASM is never stale relative to the Rust source. This matters
# because app/src/wasm/ is gitignored — the compiled artifact is otherwise only
# updated by hand and is very easy to forget (which shipped an old, weaker ML
# transcriber to the field once).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust"
WASM_DEST="$SCRIPT_DIR/src/wasm"

# Homebrew's rustc (often first on PATH) has no wasm32 target; prepend the
# rustup-managed toolchain's bin so wasm-pack uses a toolchain that does.
RUSTUP_BIN="$(dirname "$(rustup which rustc)")"

echo "build-wasm: compiling (rustup toolchain bin: $RUSTUP_BIN)…"
( cd "$RUST_DIR" && PATH="$RUSTUP_BIN:$PATH" wasm-pack build )

# app/src/wasm/ is gitignored, so it does not exist on a fresh checkout (CI, or
# a new clone) and the copy below would fail with "No such file or directory".
mkdir -p "$WASM_DEST"

cp "$RUST_DIR/pkg/folkfriend.d.ts" \
   "$RUST_DIR/pkg/folkfriend.js" \
   "$RUST_DIR/pkg/folkfriend_bg.js" \
   "$RUST_DIR/pkg/folkfriend_bg.wasm" \
   "$RUST_DIR/pkg/folkfriend_bg.wasm.d.ts" \
   "$RUST_DIR/pkg/package.json" \
   "$WASM_DEST/"
echo "build-wasm: copied fresh WASM to $WASM_DEST"
