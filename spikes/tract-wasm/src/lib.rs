// Minimal surface that pulls in tract's core types, so building this for
// wasm32 exercises the whole tract dependency tree for target compatibility.
use tract_onnx::prelude::*;

/// Returns the tract version-ish smoke value; real point is that this compiles.
pub fn tract_smoke() -> usize {
    // Construct a trivial in-memory tensor to force tract codegen.
    let t = Tensor::zero::<f32>(&[1, 4]).unwrap();
    t.shape().iter().product()
}
