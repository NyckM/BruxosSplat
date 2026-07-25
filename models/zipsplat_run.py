"""ZipSplat wrapper: imagem ou vídeo para PLY padrão 3DGS."""
import argparse
from pathlib import Path
import torch
from zipsplat import ZipSplat, load_image, load_video

ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True)
ap.add_argument('--output', required=True)
ap.add_argument('--compression', type=float, default=1.0)
args = ap.parse_args()
if not torch.cuda.is_available():
    raise RuntimeError('ZipSplat requer GPU NVIDIA/CUDA.')
p = Path(args.input)
out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
print('[ZipSplat] Carregando modelo e pesos…', flush=True)
model = ZipSplat(weights='zipsplat').cuda().eval()
if p.suffix.lower() in {'.mp4', '.mov', '.avi', '.mkv', '.webm'}:
    views = load_video(str(p), num_frames=24)
else:
    views = [load_image(str(p))]
with torch.inference_mode():
    gaussians = model(views, compression=max(0.05, min(1.0, args.compression)))[0]
target = out / 'zipsplat.ply'
gaussians.save_ply(str(target))
print('[ZipSplat] Pronto: ' + str(target), flush=True)
