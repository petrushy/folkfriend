"""Generate an onnxruntime reference for the REAL basic-pitch nmp.onnx so the
tract spike can validate op coverage + numerical match. Uses a deterministic
synthetic raw-audio input [1, 43844, 1] (content is irrelevant for validating
that tract reproduces onnxruntime's outputs op-for-op)."""
import pathlib
import time

import numpy as np
import onnxruntime as ort

BASE = pathlib.Path(__file__).parent / "tract-wasm"
MODEL = BASE / "nmp.onnx"
N = 43844  # samples per window @ 22050 Hz (~2 s)

rng = np.random.default_rng(7)
x = (rng.standard_normal((1, N, 1)).astype(np.float32) * 0.1)  # quiet-ish noise
x.tofile(BASE / "nmp_input.bin")

sess = ort.InferenceSession(MODEL.as_posix(), providers=["CPUExecutionProvider"])
inp = sess.get_inputs()[0].name
outs = sess.get_outputs()
print("input:", inp, sess.get_inputs()[0].shape)
print("outputs:", [(o.name, o.shape) for o in outs])

res = sess.run(None, {inp: x})
for o, r in zip(outs, res):
    print(f"  {o.name}: shape={r.shape} range=[{r.min():.4f},{r.max():.4f}]")
    # Save each output by its onnx output order index for tract to compare.

# Save in the model's declared output order.
for i, r in enumerate(res):
    r.astype(np.float32).tofile(BASE / f"nmp_out{i}.bin")
np.save(BASE / "nmp_shapes.npy", np.array([r.shape for r in res], dtype=object), allow_pickle=True)

t0 = time.perf_counter()
K = 20
for _ in range(K):
    sess.run(None, {inp: x})
print(f"onnxruntime latency: {(time.perf_counter()-t0)/K*1000:.1f} ms/inference")
print("wrote nmp_input.bin + nmp_out{0,1,2}.bin")
