"""FaceAnything (kocasariumut/FaceAnything, ECCV 2026, licença CC BY-NC): reconstroi o rosto em 4D
a partir de um video curto (nuvem 3D densa e consistente no tempo, um frame por vez).
Baseado nos notebooks Bruxos_VFX_FaceAnything.ipynb / Bruxos_VFX_FaceAnything4D.ipynb.

Saida: uma sequencia de arquivos .splat (frame_0000.splat, frame_0001.splat, ...) na pasta
passada em --output. Formato .splat (32 bytes/ponto: pos f32x3, scale f32x3, rgba u8x4, rot u8x4)
e o mesmo que o player4d do WebEDIT (Bruxos do VFX) espera - arraste todos os frames de uma vez nele.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys

import numpy as np

p = argparse.ArgumentParser()
p.add_argument('--input', required=True)          # video do rosto
p.add_argument('--output', required=True)         # pasta de saida (frame_0000.splat, frame_0001.splat, ...)
p.add_argument('--max-frames', type=int, default=60)
a = p.parse_args()

repo_dir = os.environ.get('MODEL_REPO_DIR')
if not repo_dir or not os.path.isdir(repo_dir):
    print('ERRO: repositorio do FaceAnything nao encontrado. Instale o modelo primeiro (botao Instalar).')
    sys.exit(1)

out_dir = os.path.abspath(a.output)
os.makedirs(out_dir, exist_ok=True)
video_abs = os.path.abspath(a.input)
work_out = os.path.join(out_dir, '_infer')
os.makedirs(work_out, exist_ok=True)

# 1) roda a reconstrucao 4D (run_inference.py mora dentro do repositorio clonado)
cmd = [
    sys.executable, 'run_inference.py',
    '--input', video_abs,
    '--output', work_out,
    '--outputs', 'ply',
    '--process-mode', 'one-by-one',
    '--max-frames', str(a.max_frames),
]
print('Rodando FaceAnything:', ' '.join(cmd))
r = subprocess.run(cmd, cwd=repo_dir)
if r.returncode != 0:
    sys.exit(r.returncode)

plys = sorted(glob.glob(os.path.join(work_out, 'ply', 'geometry', '*.ply')))
if not plys:
    print('ERRO: nenhum frame reconstruido pelo FaceAnything (veja o log acima).')
    sys.exit(1)

# 2) converte cada .ply em .splat (formato binario compacto, ja pronto pro player4d)
from plyfile import PlyData

MAX_SPLATS_FRAME = 400000  # teto por frame (mesmo limite usado no notebook)


def ply_to_splat(src_path, dst_path):
    ply = PlyData.read(src_path)
    v = ply['vertex'].data
    n = len(v)
    xyz = np.stack([v['x'], v['y'], v['z']], axis=1).astype(np.float32)
    names = v.dtype.names
    if 'red' in names:
        rgb = np.stack([v['red'], v['green'], v['blue']], axis=1).astype(np.uint8)
    else:
        rgb = np.full((n, 3), 200, np.uint8)
    if n > MAX_SPLATS_FRAME:
        idx = np.linspace(0, n - 1, MAX_SPLATS_FRAME).astype(np.int64)
        xyz, rgb = xyz[idx], rgb[idx]
        n = MAX_SPLATS_FRAME
    diag = float(np.linalg.norm(xyz.max(0) - xyz.min(0))) if n > 1 else 1.0
    s = max(diag / max(np.sqrt(n), 1.0) * 1.6, 1e-4)
    buf = np.zeros(n, dtype=[('pos', np.float32, 3), ('scale', np.float32, 3),
                             ('rgba', np.uint8, 4), ('rot', np.uint8, 4)])
    buf['pos'] = xyz
    buf['scale'] = s
    buf['rgba'][:, :3] = rgb
    buf['rgba'][:, 3] = 255
    buf['rot'] = [255, 128, 128, 128]  # rotacao identidade
    buf.tofile(dst_path)
    return n


for i, src in enumerate(plys):
    dst = os.path.join(out_dir, 'frame_%04d.splat' % i)
    n = ply_to_splat(src, dst)
    print('[%d/%d] %s - %s pontos' % (i + 1, len(plys), os.path.basename(dst), format(n, ',')))

shutil.rmtree(work_out, ignore_errors=True)
print('OK: %d frames em %s' % (len(plys), out_dir))
