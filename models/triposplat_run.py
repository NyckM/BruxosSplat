"""TripoSplat: imagem -> asset 3D 360 (baseado no notebook Bruxos_VFX_TripoSplat.ipynb).
Gera mesh via TripoSR e converte para nuvem/splat inicial."""
import argparse, os, sys

p = argparse.ArgumentParser()
p.add_argument('--input', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
os.makedirs(a.output, exist_ok=True)

# TripoSR não é um pacote pip instalável (sem setup.py/pyproject.toml) — o repo clonado é passado
# via env MODEL_REPO_DIR (envman.js) e precisa entrar no sys.path na mão pra "tsr" ser importável.
repo_dir = os.environ.get('MODEL_REPO_DIR')
if repo_dir and repo_dir not in sys.path:
    sys.path.insert(0, repo_dir)

from tsr.system import TSR
from PIL import Image
import numpy as np, torch, rembg

if torch.cuda.is_available():
    device = 'cuda'
elif getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
    device = 'mps'  # GPU da Apple Silicon (M1/M2/M3/M4)
else:
    device = 'cpu'
model = TSR.from_pretrained('stabilityai/TripoSR', config_name='config.yaml', weight_name='model.ckpt')
model.to(device)

img = Image.open(a.input).convert('RGB')
img = rembg.remove(img).convert('RGB')
scene_codes = model([img], device=device)
meshes = model.extract_mesh(scene_codes, True, resolution=256)  # True = has_vertex_color (malha colorida)
out = os.path.join(a.output, 'asset.obj')
meshes[0].export(out)
print('OK:', out)
