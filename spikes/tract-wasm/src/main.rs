// Phase 2 gate: does tract load + run the REAL basic-pitch nmp.onnx, matching
// onnxruntime? Input is raw audio [1, 43844, 1]; 3 sigmoid heads out.
use std::time::Instant;
use tract_onnx::prelude::*;

fn read_f32(path: &str) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn main() -> TractResult<()> {
    let input = read_f32("nmp_input.bin");
    let refs: Vec<Vec<f32>> = (0..3).map(|i| read_f32(&format!("nmp_out{i}.bin"))).collect();
    println!("input samples: {}", input.len());

    let t_load = Instant::now();
    let model = tract_onnx::onnx()
        .model_for_path("nmp.onnx")?
        .with_input_fact(0, f32::fact([1, 43844, 1]).into())?
        .into_optimized()?
        .into_runnable()?;
    println!("load + optimize: {:.1?}", t_load.elapsed());

    let arr = tract_ndarray::Array3::from_shape_vec((1, 43844, 1), input)?;
    let input_tensor: Tensor = arr.into();

    let result = model.run(tvec!(input_tensor.clone().into()))?;
    println!("num outputs: {}", result.len());

    // Match each tract output to the onnxruntime ref of equal length (best diff).
    let mut worst = 0.0f32;
    for (oi, out) in result.iter().enumerate() {
        let got: Vec<f32> = out.to_array_view::<f32>()?.iter().cloned().collect();
        let best = refs
            .iter()
            .filter(|r| r.len() == got.len())
            .map(|r| {
                got.iter()
                    .zip(r)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0f32, f32::max)
            })
            .fold(f32::INFINITY, f32::min);
        println!("  output {oi}: len={} max_abs_diff_vs_ref={:.3e}", got.len(), best);
        worst = worst.max(if best.is_finite() { best } else { 1.0 });
    }

    let n = 30;
    let t = Instant::now();
    for _ in 0..n {
        let _ = model.run(tvec!(input_tensor.clone().into()))?;
    }
    let per = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
    println!("tract latency: {per:.1} ms/inference (avg of {n})");

    if worst < 1e-3 {
        println!("RESULT: ✅ tract runs the REAL nmp.onnx, matches onnxruntime (worst {worst:.1e})");
    } else {
        println!("RESULT: ⚠️ output diff {worst:.3e} > 1e-3 — investigate");
    }
    Ok(())
}
