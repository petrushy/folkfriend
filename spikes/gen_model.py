"""Generate a basic-pitch-CLASS CNN ONNX to test tract op coverage + latency.

This is NOT the real basic-pitch model (that needs a TF->ONNX conversion). It
mirrors the op families (Conv2D, BatchNorm, ReLU, Sigmoid) and realistic tensor
shapes: harmonic-CQT input [1, 8, 172, 264] (8 harmonics as channels, ~2 s of
frames, 3 bins/semitone over ~88 keys) and three sigmoid output heads
(contour / note / onset). Purpose: validate that tract can load and run a model
of this scale at acceptable latency, before investing in the real conversion.
"""
import numpy as np
import torch
import torch.nn as nn

FRAMES = 172      # ~2 s window
FREQ_BINS = 264   # 3 bins/semitone * 88
HARMONICS = 8     # harmonic stacking -> channels


class BasicPitchClass(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(HARMONICS, 16, kernel_size=5, padding=2)
        self.bn1 = nn.BatchNorm2d(16)
        self.conv2 = nn.Conv2d(16, 8, kernel_size=(3, 39), padding=(1, 19))
        self.bn2 = nn.BatchNorm2d(8)
        # contour head: full freq resolution
        self.contour = nn.Conv2d(8, 1, kernel_size=5, padding=2)
        # note head: downsample freq 3x (3 bins/semitone -> 1/semitone)
        self.note_a = nn.Conv2d(8, 32, kernel_size=7, stride=(1, 3), padding=3)
        self.note_b = nn.Conv2d(32, 1, kernel_size=(7, 3), padding=(3, 1))
        # onset head: from early features
        self.onset_a = nn.Conv2d(16, 32, kernel_size=7, stride=(1, 3), padding=3)
        self.onset_b = nn.Conv2d(32, 1, kernel_size=(7, 3), padding=(3, 1))
        self.act = nn.ReLU()

    def forward(self, x):
        h1 = self.act(self.bn1(self.conv1(x)))
        h2 = self.act(self.bn2(self.conv2(h1)))
        contour = torch.sigmoid(self.contour(h2))      # (1,1,172,264)
        note = torch.sigmoid(self.note_b(self.act(self.note_a(h2))))   # (1,1,172,88)
        onset = torch.sigmoid(self.onset_b(self.act(self.onset_a(h1))))  # (1,1,172,88)
        return contour, note, onset


def main():
    torch.manual_seed(0)
    model = BasicPitchClass().eval()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"params: {n_params}")

    # Deterministic input, also reproducible on the Rust side.
    rng = np.random.default_rng(42)
    x = rng.standard_normal((1, HARMONICS, FRAMES, FREQ_BINS), dtype=np.float32)

    with torch.no_grad():
        c, n, o = model(torch.from_numpy(x))
    print("output shapes:", tuple(c.shape), tuple(n.shape), tuple(o.shape))

    base = __import__("pathlib").Path(__file__).parent / "tract-wasm"
    onnx_path = base / "model.onnx"
    torch.onnx.export(
        model, (torch.from_numpy(x),), onnx_path.as_posix(),
        input_names=["hcqt"], output_names=["contour", "note", "onset"],
        opset_version=13, dynamo=False,
    )
    print("wrote", onnx_path, f"({onnx_path.stat().st_size/1024:.0f} KB)")

    # Save input + reference contour output as raw LE f32 for the tract spike.
    x.tofile(base / "input.bin")
    c.numpy().astype(np.float32).tofile(base / "ref_contour.bin")
    print("wrote input.bin + ref_contour.bin")

    # onnxruntime cross-check (sanity that the ONNX is valid).
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx_path.as_posix(), providers=["CPUExecutionProvider"])
    import time
    t0 = time.perf_counter()
    N = 20
    for _ in range(N):
        ort_out = sess.run(None, {"hcqt": x})
    dt = (time.perf_counter() - t0) / N * 1000
    print(f"onnxruntime latency: {dt:.1f} ms/inference (avg of {N})")
    np.save(base / "ort_contour.npy", ort_out[0])


if __name__ == "__main__":
    main()
