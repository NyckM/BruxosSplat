"""Converts a MegaSam CVD NPZ result to COLMAP text and a preview PLY."""
import argparse
import math
from pathlib import Path

import numpy as np


def qvec_from_rotmat(rot):
    q = np.empty(4, dtype=np.float64)
    t = np.trace(rot)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q[:] = (0.25 * s, (rot[2, 1] - rot[1, 2]) / s,
                (rot[0, 2] - rot[2, 0]) / s, (rot[1, 0] - rot[0, 1]) / s)
    else:
        i = int(np.argmax(np.diag(rot)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1.0 + rot[i, i] - rot[j, j] - rot[k, k]) * 2
        q[:] = ((rot[k, j] - rot[j, k]) / s, 0, 0, 0)
        q[i + 1] = 0.25 * s
        q[j + 1] = (rot[j, i] + rot[i, j]) / s
        q[k + 1] = (rot[k, i] + rot[i, k]) / s
    return q / np.linalg.norm(q)


def image_paths(folder):
    return sorted(p for p in Path(folder).iterdir() if p.suffix.lower() in {'.jpg', '.jpeg', '.png'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--npz', required=True)
    parser.add_argument('--images', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--max-points', type=int, default=250000)
    args = parser.parse_args()
    data = np.load(args.npz)
    images = data['images']
    depths = data['depths']
    k = np.asarray(data['intrinsic'], dtype=np.float64)
    poses = np.asarray(data['cam_c2w'], dtype=np.float64)
    files = image_paths(args.images)
    n = min(len(images), len(depths), len(poses), len(files))
    if n < 2:
        raise RuntimeError('MegaSam não entregou imagens/poses suficientes para exportar.')
    if k.ndim == 3:
        k = k[0]
    h, w = images.shape[1:3]
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    txt = out / 'sparse_txt'
    txt.mkdir(exist_ok=True)
    fx, fy, cx, cy = (float(k[0, 0]), float(k[1, 1]), float(k[0, 2]), float(k[1, 2]))
    with open(txt / 'cameras.txt', 'w', encoding='utf8') as f:
        f.write('# Camera list with one line of data per camera:\n')
        f.write(f'1 PINHOLE {w} {h} {fx} {fy} {cx} {cy}\n')
    with open(txt / 'images.txt', 'w', encoding='utf8') as f:
        f.write('# Image list with two lines of data per image:\n')
        for i in range(n):
            w2c = np.linalg.inv(poses[i])
            q = qvec_from_rotmat(w2c[:3, :3])
            t = w2c[:3, 3]
            f.write(f'{i + 1} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} 1 {files[i].name}\n\n')

    # Uniformly sample the RGB-D reconstruction so the preview remains light.
    stride = max(1, int(math.sqrt((n * h * w) / max(1, args.max_points))))
    yy, xx = np.mgrid[0:h:stride, 0:w:stride]
    all_xyz, all_rgb = [], []
    for i in range(n):
        z = np.asarray(depths[i])[yy, xx].reshape(-1)
        good = np.isfinite(z) & (z > 0.05) & (z < 1000.0)
        if not np.any(good):
            continue
        x = xx.reshape(-1)[good]
        y = yy.reshape(-1)[good]
        z = z[good]
        cam = np.stack(((x - cx) * z / fx, (y - cy) * z / fy, z, np.ones_like(z)), axis=1)
        world = (poses[i] @ cam.T).T[:, :3]
        rgb = np.asarray(images[i])[yy, xx].reshape(-1, 3)[good]
        if rgb.dtype.kind == 'f':
            rgb = np.clip(rgb * 255, 0, 255)
        all_xyz.append(world)
        all_rgb.append(rgb.astype(np.uint8))
    if not all_xyz:
        raise RuntimeError('MegaSam não produziu profundidade válida para a nuvem inicial.')
    xyz, rgb = np.concatenate(all_xyz), np.concatenate(all_rgb)
    if len(xyz) > args.max_points:
        keep = np.linspace(0, len(xyz) - 1, args.max_points, dtype=np.int64)
        xyz, rgb = xyz[keep], rgb[keep]
    with open(out / 'points.ply', 'w', encoding='utf8') as f:
        f.write('ply\nformat ascii 1.0\n')
        f.write(f'element vertex {len(xyz)}\nproperty float x\nproperty float y\nproperty float z\n')
        f.write('property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n')
        for p, c in zip(xyz, rgb):
            f.write(f'{p[0]} {p[1]} {p[2]} {int(c[0])} {int(c[1])} {int(c[2])}\n')
    with open(txt / 'points3D.txt', 'w', encoding='utf8') as f:
        for i, (p, c) in enumerate(zip(xyz, rgb), 1):
            f.write(f'{i} {p[0]} {p[1]} {p[2]} {int(c[0])} {int(c[1])} {int(c[2])} 1\n')
    print(f'[MegaSam] Exportado: {len(xyz)} pontos e {n} poses em {txt}', flush=True)


if __name__ == '__main__':
    main()
