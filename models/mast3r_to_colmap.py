"""Executa o MASt3R oficial e grava um modelo COLMAP textual + points.ply.

Este adaptador não altera o checkout do MASt3R. Ele permite que Brush/PPISP e o
preview do BruxoSplat recebam poses e pontos usando o formato já empregado pelo app.
"""
import argparse
import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image

# O processo é iniciado com cwd no checkout oficial; estes imports são dele.
import mast3r.utils.path_to_dust3r  # noqa: F401
from mast3r.model import AsymmetricMASt3R
from mast3r.image_pairs import make_pairs
from mast3r.cloud_opt.sparse_ga import sparse_global_alignment
from dust3r.utils.image import load_images


def rot_to_qvec(r):
    """Rotação 3x3 para o quaternion qw qx qy qz do COLMAP."""
    q = np.empty(4, dtype=np.float64)
    trace = np.trace(r)
    if trace > 0:
        s = np.sqrt(trace + 1.0) * 2.0
        q[:] = [0.25 * s, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s]
    else:
        i = int(np.argmax(np.diag(r)))
        if i == 0:
            s = np.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2.0
            q[:] = [(r[2, 1] - r[1, 2]) / s, 0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s]
        elif i == 1:
            s = np.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2.0
            q[:] = [(r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s]
        else:
            s = np.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2.0
            q[:] = [(r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s]
    return q / np.linalg.norm(q)


def write_ply(filename, points):
    with open(filename, 'w', encoding='ascii') as f:
        f.write('ply\nformat ascii 1.0\nelement vertex %d\n' % len(points))
        f.write('property float x\nproperty float y\nproperty float z\n')
        f.write('property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n')
        for p in points:
            f.write('%.6f %.6f %.6f 190 210 255\n' % tuple(p))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', default='naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric')
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError('MASt3R requer CUDA/NVIDIA neste modo.')
    paths = sorted(str(p) for p in Path(args.images).iterdir() if p.suffix.lower() in ('.jpg', '.jpeg', '.png'))
    if len(paths) < 5:
        raise RuntimeError('MASt3R precisa de ao menos 5 imagens.')
    print('[MASt3R] Carregando %d imagens…' % len(paths), flush=True)
    images = load_images(paths, size=512, verbose=True)
    model = AsymmetricMASt3R.from_pretrained(args.model).to('cuda').eval()
    pairs = make_pairs(images, scene_graph='swin-5-noncyclic', prefilter=None, symmetrize=True)
    cache = os.path.join(args.output, 'mast3r_cache')
    scene = sparse_global_alignment(paths, pairs, cache, model, device='cuda',
                                    lr1=0.07, niter1=300, lr2=0.01, niter2=300,
                                    opt_depth=True, shared_intrinsics=False,
                                    matching_conf_thr=0)
    focals = scene.get_focals().detach().cpu().numpy().reshape(-1)
    c2w = scene.get_im_poses().detach().cpu().numpy()
    pts3d, _, _ = scene.get_dense_pts3d(clean_depth=True)
    cloud = np.concatenate([p.detach().cpu().numpy().reshape(-1, 3) for p in pts3d], axis=0)
    cloud = cloud[np.isfinite(cloud).all(axis=1)]
    # Preview responsivo e arquivo razoável: até 250 mil pontos distribuídos.
    if len(cloud) > 250000:
        cloud = cloud[np.linspace(0, len(cloud) - 1, 250000, dtype=np.int64)]
    out = Path(args.output)
    txt = out / 'sparse_txt'
    txt.mkdir(parents=True, exist_ok=True)
    write_ply(out / 'points.ply', cloud)
    with open(txt / 'cameras.txt', 'w', encoding='utf-8') as cameras, open(txt / 'images.txt', 'w', encoding='utf-8') as ims:
        cameras.write('# Camera list with one line of data per camera:\n')
        ims.write('# Image list with two lines of data per image:\n')
        for i, (source, im, focal, pose) in enumerate(zip(paths, images, focals, c2w), 1):
            mast_h, mast_w = [int(x) for x in np.asarray(im['true_shape']).reshape(-1)[:2]]
            # O MASt3R calcula a focal na imagem redimensionada. Reescala para o
            # frame extraído original, que é o arquivo usado pelos treinadores.
            with Image.open(source) as source_image:
                w, h = source_image.size
            focal_scaled = float(focal) * (w / mast_w)
            cameras.write(f'{i} PINHOLE {w} {h} {focal_scaled:.8f} {focal_scaled:.8f} {w/2:.8f} {h/2:.8f}\n')
            w2c = np.linalg.inv(pose)
            q = rot_to_qvec(w2c[:3, :3]); t = w2c[:3, 3]
            ims.write(f'{i} {q[0]:.12f} {q[1]:.12f} {q[2]:.12f} {q[3]:.12f} {t[0]:.12f} {t[1]:.12f} {t[2]:.12f} {i} {Path(source).name}\n\n')
    with open(txt / 'points3D.txt', 'w', encoding='utf-8') as pts:
        pts.write('# MASt3R dense points; tracks are intentionally omitted.\n')
        for i, p in enumerate(cloud, 1):
            pts.write(f'{i} {p[0]:.8f} {p[1]:.8f} {p[2]:.8f} 190 210 255 0\n')
    print('[MASt3R] Exportado: %d pontos e %d poses em %s' % (len(cloud), len(paths), txt), flush=True)


if __name__ == '__main__':
    main()
