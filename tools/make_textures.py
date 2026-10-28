# Run from the repo root:  python tools/make_textures.py web/textures   (needs numpy and pillow; not part of the app)
"""Seamless texture tiles for NiSH Notes: paper grain (page, folder cards) and felt (desk).
Noise is shaped in the frequency domain, so every tile wraps perfectly."""
import sys
import numpy as np
from PIL import Image

out = sys.argv[1]
rng = np.random.default_rng(7)

def shaped(n, lo=None, hi=None, aniso=1.0, angle=0.0):
    """Periodic noise with a frequency band [hi..lo] (in pixels), optionally stretched along an angle."""
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    c, s = np.cos(angle), np.sin(angle)
    u, v = fx * c + fy * s, (-fx * s + fy * c) * aniso
    r = np.sqrt(u * u + v * v)
    mask = np.ones_like(r)
    if lo: mask *= np.exp(-(r * lo) ** 2)            # remove detail finer than lo
    if hi: mask *= 1 - np.exp(-(r * hi) ** 2)        # remove shapes larger than hi
    x = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((n, n))) * mask))
    return (x - x.mean()) / (x.std() + 1e-9)

def save(name, rgb, alpha):
    a = np.clip(alpha, 0, 1)
    img = np.dstack([np.broadcast_to(np.array(rgb, float), a.shape + (3,)), a[..., None]])
    Image.fromarray((img * 255).round().astype(np.uint8), "RGBA").save(f"{out}/{name}", optimize=True)

# ---- paper: fine grain, a few longer fibres, very gentle cloudiness ----
N = 256
grain = shaped(N, lo=0.9)                                   # pixel-fine tooth
fibres = sum(np.clip(shaped(N, lo=1.2, aniso=9, angle=a), 0, None) for a in rng.uniform(0, np.pi, 5)) / 5
cloud = shaped(N, lo=40, hi=200)
dark = 0.012 + 0.018 * grain + 0.045 * np.clip(fibres - 0.7, 0, None) + 0.003 * cloud
save("paper-grain.png", (0.40, 0.31, 0.19), np.clip(dark, 0, 0.1))

# ---- felt: soft fuzzy fibres in every direction plus a faint mottle ----
N = 320
fuzz = shaped(N, lo=1.6)                                    # soft, slightly blurred fluff
fib = sum(shaped(N, lo=1.1, aniso=5, angle=a) for a in rng.uniform(0, np.pi, 8)) / np.sqrt(8)
mottle = shaped(N, lo=30, hi=160)
t = 0.6 * fuzz + 0.55 * fib + 0.18 * mottle
light = np.clip(t, 0, None) * 0.045                         # lighter fibre tips
shade = np.clip(-t, 0, None) * 0.055                         # darker gaps between fibres
save("felt-light.png", (0.86, 0.90, 1.0), light)
save("felt-dark.png", (0.0, 0.0, 0.03), shade)
