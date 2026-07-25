"""Treinador 3D Gaussian Splatting simples com PPISP para o BruxoSplat.

Recebe o modelo COLMAP já criado pelo aplicativo. Este backend é NVIDIA/CUDA:
PPISP é aplicado ao RGB renderizado antes da loss e aprende parâmetros por frame.
"""
import argparse
import math
import os
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pycolmap
import torch
import torch.nn.functional as F
from PIL import Image
from plyfile import PlyData, PlyElement

from gsplat import rasterization
from ppisp import PPISP


SH_C0 = 0.28209479177387814


def camera_matrix(camera, scale):
    p = np.asarray(camera.params, dtype=np.float32)
    # COLMAP OPENCV/SIMPLE_RADIAL/PINHOLE: os quatro primeiros valores incluem
    # fx/fy/cx/cy; SIMPLE_* usa f, cx, cy.
    if camera.model.name.startswith("SIMPLE"):
        fx = fy = p[0]
        cx, cy = p[1], p[2]
    else:
        fx, fy, cx, cy = p[:4]
    return np.array([[fx * scale, 0, cx * scale], [0, fy * scale, cy * scale], [0, 0, 1]], dtype=np.float32)


def load_views(colmap_dir, images_dir, max_resolution):
    rec = pycolmap.Reconstruction(str(colmap_dir))
    views, camera_ids = [], {}
    for image_id, image in rec.images.items():
        image_path = Path(images_dir) / image.name
        if not image_path.exists():
            continue
        rgb = iio.imread(image_path)[..., :3]
        h0, w0 = rgb.shape[:2]
        scale = min(1.0, float(max_resolution) / max(w0, h0))
        w, h = max(1, round(w0 * scale)), max(1, round(h0 * scale))
        if (w, h) != (w0, h0):
            rgb = np.asarray(Image.fromarray(rgb).resize((w, h), Image.Resampling.BILINEAR))
        camera = rec.cameras[image.camera_id]
        if image.camera_id not in camera_ids:
            camera_ids[image.camera_id] = len(camera_ids)
        # pycolmap 3.13 expõe cam_from_world() como método; versões anteriores
        # podem expô-lo como atributo. Aceita as duas APIs para não amarrar o
        # treinador à versão que o uv resolveu no ambiente isolado.
        cam_from_world = image.cam_from_world
        cam_from_world = cam_from_world() if callable(cam_from_world) else cam_from_world
        matrix = cam_from_world.matrix
        matrix = matrix() if callable(matrix) else matrix
        viewmat = np.asarray(matrix, dtype=np.float32)
        # COLMAP armazena a transformação mundo→câmera como [R|t] 3×4,
        # enquanto o gsplat exige uma matriz homogênea 4×4 por câmera.
        if viewmat.shape == (3, 4):
            homogeneous = np.eye(4, dtype=np.float32)
            homogeneous[:3, :4] = viewmat
            viewmat = homogeneous
        if viewmat.shape != (4, 4):
            raise RuntimeError(f'Pose COLMAP inválida para gsplat: esperado 3x4 ou 4x4, recebido {viewmat.shape}.')
        views.append((rgb.astype(np.float32) / 255.0, viewmat, camera_matrix(camera, scale), camera_ids[image.camera_id]))
    if len(views) < 3:
        raise RuntimeError("COLMAP retornou menos de 3 imagens alinhadas para PPISP.")
    return views, rec, len(camera_ids)


def initial_points(rec, limit=180_000):
    pts = list(rec.points3D.values())
    if not pts:
        raise RuntimeError("O modelo COLMAP não possui pontos 3D para inicializar os Gaussians.")
    if len(pts) > limit:
        rng = np.random.default_rng(42)
        pts = [pts[i] for i in rng.choice(len(pts), limit, replace=False)]
    xyz = np.asarray([p.xyz for p in pts], dtype=np.float32)
    rgb = np.asarray([p.color for p in pts], dtype=np.float32) / 255.0
    extent = float(np.linalg.norm(xyz.max(0) - xyz.min(0)))
    scale = max(extent / 500.0, 1e-4)
    return xyz, rgb, scale


def write_ply(path, means, quats, log_scales, opacities, colors):
    means = means.detach().cpu().numpy()
    quats = F.normalize(quats, dim=-1).detach().cpu().numpy()
    scales = log_scales.detach().cpu().numpy()
    opacity = opacities.detach().cpu().numpy().reshape(-1)
    fdc = (colors.detach().cpu().numpy() - 0.5) / SH_C0
    n = len(means)
    dtype = [("x", "f4"), ("y", "f4"), ("z", "f4"), ("nx", "f4"), ("ny", "f4"), ("nz", "f4"),
             ("f_dc_0", "f4"), ("f_dc_1", "f4"), ("f_dc_2", "f4"), ("opacity", "f4"),
             ("scale_0", "f4"), ("scale_1", "f4"), ("scale_2", "f4"),
             ("rot_0", "f4"), ("rot_1", "f4"), ("rot_2", "f4"), ("rot_3", "f4")]
    data = np.empty(n, dtype=dtype)
    data["x"], data["y"], data["z"] = means[:, 0], means[:, 1], means[:, 2]
    data["nx"], data["ny"], data["nz"] = 0, 0, 0
    data["f_dc_0"], data["f_dc_1"], data["f_dc_2"] = fdc[:, 0], fdc[:, 1], fdc[:, 2]
    data["opacity"] = opacity
    data["scale_0"], data["scale_1"], data["scale_2"] = scales[:, 0], scales[:, 1], scales[:, 2]
    data["rot_0"], data["rot_1"], data["rot_2"], data["rot_3"] = quats[:, 0], quats[:, 1], quats[:, 2], quats[:, 3]
    PlyData([PlyElement.describe(data, "vertex")], text=False).write(str(path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--colmap", required=True)
    ap.add_argument("--images", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--export-every", type=int, default=1500)
    ap.add_argument("--max-resolution", type=int, default=1600)
    args = ap.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("PPISP requer uma GPU NVIDIA/CUDA disponível para o PyTorch.")
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    print("[PPISP] Lendo COLMAP…", flush=True)
    views, rec, num_cameras = load_views(args.colmap, args.images, args.max_resolution)
    xyz, rgb, init_scale = initial_points(rec)
    dev = "cuda"
    means = torch.nn.Parameter(torch.tensor(xyz, device=dev))
    quats = torch.nn.Parameter(torch.tensor(np.tile([1, 0, 0, 0], (len(xyz), 1)), dtype=torch.float32, device=dev))
    log_scales = torch.nn.Parameter(torch.full((len(xyz), 3), math.log(init_scale), device=dev))
    opacities = torch.nn.Parameter(torch.full((len(xyz),), -2.1972246, device=dev))
    colors = torch.nn.Parameter(torch.tensor(rgb, device=dev))
    gaussian_opt = torch.optim.Adam([means, quats, log_scales, opacities, colors], lr=0.002)
    isp = PPISP(num_cameras=num_cameras, num_frames=len(views))
    isp_opts = isp.create_optimizers()
    isp_schedulers = isp.create_schedulers(isp_opts, args.steps)
    print(f"[PPISP] {len(views)} frames, {len(xyz)} Gaussians, {num_cameras} camera(s).", flush=True)
    rng = np.random.default_rng(42)
    for step in range(1, args.steps + 1):
        frame_idx = int(rng.integers(len(views)))
        target_np, view_np, k_np, camera_idx = views[frame_idx]
        h, w = target_np.shape[:2]
        target = torch.from_numpy(target_np).to(dev)
        render, _, _ = rasterization(means, F.normalize(quats, dim=-1), torch.exp(log_scales),
            torch.sigmoid(opacities), torch.sigmoid(colors), torch.from_numpy(view_np).to(dev)[None],
            torch.from_numpy(k_np).to(dev)[None], w, h, packed=False)
        raw = render[0]
        corrected = isp(raw, resolution=(w, h), camera_idx=camera_idx, frame_idx=frame_idx)
        loss = F.l1_loss(corrected, target) + isp.get_regularization_loss()
        gaussian_opt.zero_grad(set_to_none=True)
        for opt in isp_opts: opt.zero_grad(set_to_none=True)
        loss.backward()
        gaussian_opt.step()
        for opt in isp_opts: opt.step()
        for scheduler in isp_schedulers: scheduler.step()
        with torch.no_grad(): colors.clamp_(-8, 8); log_scales.clamp_(math.log(1e-5), math.log(2.0))
        if step % 100 == 0:
            print(f"[PPISP] passo {step}/{args.steps}  loss={loss.item():.5f}", flush=True)
        if step % args.export_every == 0:
            write_ply(out / f"passo_{step}.ply", means, quats, log_scales, opacities, torch.sigmoid(colors))
    write_ply(out / "final.ply", means, quats, log_scales, opacities, torch.sigmoid(colors))
    torch.save({"gaussians": {"means": means.detach(), "quats": quats.detach(), "log_scales": log_scales.detach(), "opacities": opacities.detach(), "colors": colors.detach()}, "ppisp": isp.state_dict()}, out / "ppisp_checkpoint.pt")
    print("[PPISP] concluído.", flush=True)


if __name__ == "__main__":
    main()
