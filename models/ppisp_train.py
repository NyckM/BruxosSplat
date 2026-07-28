"""Treinador 3D Gaussian Splatting (GSplat + PPISP) para o BruxoSplat.

Recebe o modelo COLMAP já criado pelo aplicativo. Este backend é NVIDIA/CUDA.

Reescrita (item 1-2-3-5-6-7 do roadmap de jul/2026): a versão anterior deste
arquivo não fazia densificação/poda (a nuvem de Gaussians ficava travada no
que o COLMAP entregava), usava uma única learning rate pra tudo e não tinha
Spherical Harmonics — por isso ficava com qualidade pior que o motor Brush
aos mesmos "steps". Esta versão usa:

  1) gsplat.strategy.MCMCStrategy pra densificação/poda de verdade (a própria
     NVIDIA exige MCMC, não Default, quando combinado com PPISP — ver
     simple_trainer.py do repositório gsplat).
  2) Learning rate por atributo (means/scales/quats/opacities/sh0/shN) +
     grau de SH progressivo (0→3) + anti-aliasing (mip-splatting) no render.
  3) Cronograma de densificação (refine_start/stop/every, cap_max) escalado
     como fração de --steps, em vez de valores fixos pensados pra ~30k.
  5) Parada adaptativa por platô de loss + importance sampling de frames
     (amostra mais os frames com erro maior, depois de um aquecimento
     uniforme que cobre todos os frames pelo menos 2x).
  6) Camera fine-tuning: pequeno ajuste de pose por frame, treinado junto.
  7) Densificação com viés de borda/curvatura: um "detail score" por ponto
     COLMAP (via Sobel nas imagens reais, projetado nos pontos 3D) empurra a
     opacidade inicial pra cima em regiões de mais detalhe (cabelo, fios,
     cantos), o que faz o MCMC (que clona proporcional à opacidade) crescer
     mais Gaussians ali desde o início do treino.

Antes do início da densificação (step <= refine_start_iter) o número de
Gaussians é garantido estável, então o viés de detalhe é aplicado só nessa
janela — depois disso o MCMC pode redistribuir/adicionar/remover pontos e
não haveria como manter o mapeamento ponto→detail_score em sincronia sem uma
Strategy customizada (fica como ideia pra uma versão futura, se o efeito do
viés inicial não for suficiente).
"""
import argparse
import math
import os
from collections import deque
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pycolmap
import torch
import torch.nn.functional as F
from PIL import Image
from plyfile import PlyData, PlyElement

from gsplat import rasterization
from gsplat.strategy import MCMCStrategy
from ppisp import PPISP


SH_C0 = 0.28209479177387814
MAX_SH_DEGREE = 3
NUM_SH_COEFFS = (MAX_SH_DEGREE + 1) ** 2  # 16


# =============================================================================
# Câmera / dados COLMAP (sem mudanças na leitura em si)
# =============================================================================

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
    return xyz, rgb, scale, max(extent, 1e-3)


# =============================================================================
# Item 7: detail score por ponto (Sobel projetado) — densificação por borda
# =============================================================================

def _sobel_edges(gray):
    """Magnitude de gradiente 3x3 (Sobel), sem depender de scipy."""
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
    padded = np.pad(gray, 1, mode="edge")
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    for i in range(3):
        for j in range(3):
            patch = padded[i:i + gray.shape[0], j:j + gray.shape[1]]
            gx += kx[i, j] * patch
            gy += kx[j, i] * patch  # ky = kx transposta
    return np.sqrt(gx * gx + gy * gy)


def compute_detail_scores(views, xyz, max_views=8):
    """Projeta cada ponto 3D do COLMAP em algumas views e mede o quão perto
    ele cai de uma borda/detalhe (Sobel) na imagem real. Devolve um score em
    [0,1] por ponto — usado só pra enviesar a opacidade inicial (ver main())."""
    n = len(xyz)
    scores = np.zeros(n, dtype=np.float32)
    counts = np.zeros(n, dtype=np.float32)
    step = max(1, len(views) // max_views)
    xyz_h = np.concatenate([xyz, np.ones((n, 1), dtype=np.float32)], axis=1)
    for vi in range(0, len(views), step):
        rgb, viewmat, k, _ = views[vi]
        gray = rgb.mean(axis=-1)
        edges = _sobel_edges(gray)
        h, w = gray.shape
        cam = xyz_h @ viewmat.T
        z = cam[:, 2]
        valid = z > 1e-4
        zc = np.clip(z, 1e-4, None)
        px = k[0, 0] * cam[:, 0] / zc + k[0, 2]
        py = k[1, 1] * cam[:, 1] / zc + k[1, 2]
        inb = valid & (px >= 0) & (px < w - 1) & (py >= 0) & (py < h - 1)
        idx = np.nonzero(inb)[0]
        if len(idx) == 0:
            continue
        xi = px[idx].astype(np.int32)
        yi = py[idx].astype(np.int32)
        scores[idx] += edges[yi, xi]
        counts[idx] += 1
    counts[counts == 0] = 1
    scores = scores / counts
    peak = scores.max()
    if peak > 1e-8:
        scores = scores / peak
    return scores


# =============================================================================
# Item 6: fine-tuning conjunto das poses de câmera
# =============================================================================

def rotation_6d_to_matrix(d6):
    """Gram-Schmidt (Zhou et al. 2019) — representação contínua de rotação."""
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = a2 - (b1 * a2).sum(-1, keepdim=True) * b1
    b2 = F.normalize(b2, dim=-1)
    b3 = torch.linalg.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-2)


class CameraOptModule(torch.nn.Module):
    """Pequeno ajuste (delta) de pose por frame, treinado junto com os Gaussians."""

    def __init__(self, n):
        super().__init__()
        self.embeds = torch.nn.Embedding(n, 9)  # 3 translação + 6D rotação
        torch.nn.init.zeros_(self.embeds.weight)
        self.register_buffer("identity", torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]))

    def forward(self, camtoworld, frame_idx):
        d = self.embeds(frame_idx)
        dx, drot = d[:3], d[3:]
        rot = rotation_6d_to_matrix((drot + self.identity).unsqueeze(0))[0]
        transform = torch.eye(4, device=d.device, dtype=camtoworld.dtype)
        transform[:3, :3] = rot
        transform[:3, 3] = dx
        return camtoworld @ transform


# =============================================================================
# Export .ply (agora com SH completo em vez de RGB "flat")
# =============================================================================

def write_ply(path, means, quats, log_scales, opacities, sh0, shN):
    means = means.detach().cpu().numpy()
    quats = F.normalize(quats, dim=-1).detach().cpu().numpy()
    scales = log_scales.detach().cpu().numpy()
    opacity = opacities.detach().cpu().numpy().reshape(-1)
    dc = sh0.detach().cpu().numpy().reshape(-1, 3)
    rest = shN.detach().cpu().numpy()  # [N, num_rest, 3]
    n = len(means)
    num_rest = rest.shape[1]
    dtype = [("x", "f4"), ("y", "f4"), ("z", "f4"), ("nx", "f4"), ("ny", "f4"), ("nz", "f4"),
             ("f_dc_0", "f4"), ("f_dc_1", "f4"), ("f_dc_2", "f4")]
    dtype += [(f"f_rest_{i}", "f4") for i in range(3 * num_rest)]
    dtype += [("opacity", "f4"), ("scale_0", "f4"), ("scale_1", "f4"), ("scale_2", "f4"),
              ("rot_0", "f4"), ("rot_1", "f4"), ("rot_2", "f4"), ("rot_3", "f4")]
    data = np.empty(n, dtype=dtype)
    data["x"], data["y"], data["z"] = means[:, 0], means[:, 1], means[:, 2]
    data["nx"], data["ny"], data["nz"] = 0, 0, 0
    data["f_dc_0"], data["f_dc_1"], data["f_dc_2"] = dc[:, 0], dc[:, 1], dc[:, 2]
    # convenção padrão (INRIA/3DGS): f_rest ordenado por canal — todas as bandas de R, depois G, depois B.
    for c in range(3):
        for j in range(num_rest):
            data[f"f_rest_{c * num_rest + j}"] = rest[:, j, c]
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
    dev = "cuda"
    steps = args.steps

    print("[PPISP] Lendo COLMAP…", flush=True)
    views, rec, num_cameras = load_views(args.colmap, args.images, args.max_resolution)
    xyz, rgb, init_scale, extent = initial_points(rec)
    n = len(xyz)

    print("[PPISP] Calculando mapa de detalhe (bordas) pra densificação enviesada…", flush=True)
    detail_scores = compute_detail_scores(views, xyz)

    # --- Item 2: parâmetros como SH (sh0 = banda DC, shN = bandas 1..3) ---------------
    means = torch.nn.Parameter(torch.tensor(xyz, device=dev))
    quats = torch.nn.Parameter(torch.tensor(np.tile([1, 0, 0, 0], (n, 1)), dtype=torch.float32, device=dev))
    scales = torch.nn.Parameter(torch.full((n, 3), math.log(init_scale), device=dev))
    # Item 7: opacidade inicial mais alta em regiões de mais detalhe (borda/curvatura) —
    # o MCMC clona proporcional à opacidade, então isso faz esses pontos crescerem primeiro.
    base_logit = math.log(0.1 / 0.9)
    detail_t = torch.from_numpy(detail_scores).to(dev)
    opacities = torch.nn.Parameter(base_logit + 0.6 * detail_t)
    sh0 = torch.nn.Parameter(torch.tensor((rgb - 0.5) / SH_C0, device=dev).unsqueeze(1))  # [N,1,3]
    shN = torch.nn.Parameter(torch.zeros(n, NUM_SH_COEFFS - 1, 3, device=dev))            # [N,15,3]

    splats = torch.nn.ParameterDict({
        "means": means, "scales": scales, "quats": quats,
        "opacities": opacities, "sh0": sh0, "shN": shN,
    })

    means_lr = 1.6e-4 * extent
    lrs = {"means": means_lr, "scales": 5e-3, "quats": 1e-3,
           "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    optimizers = {name: torch.optim.Adam([splats[name]], lr=lr, eps=1e-15) for name, lr in lrs.items()}
    means_scheduler = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / steps))

    # --- Item 1: densificação/poda real via MCMC (exigido pelo PPISP) -----------------
    cap_max = int(min(3_000_000, max(400_000, n * (2 + steps / 15_000))))
    mcmc_kwargs = dict(
        cap_max=cap_max,
        refine_start_iter=max(200, round(0.02 * steps)),
        refine_stop_iter=max(400, round(0.7 * steps)),   # item 3: densifica até 70% do treino, não só os primeiros ~15k
        refine_every=max(50, round(steps / 300)),
        noise_injection_stop_iter=max(500, round(0.85 * steps)),
    )
    try:
        strategy = MCMCStrategy(**mcmc_kwargs)
    except TypeError:
        # gsplat mais antigo pode não ter 'noise_injection_stop_iter' — cai pro conjunto básico.
        mcmc_kwargs.pop("noise_injection_stop_iter", None)
        strategy = MCMCStrategy(**mcmc_kwargs)
    strategy.check_sanity(splats, optimizers)
    strategy_state = strategy.initialize_state()

    # --- Item 6: ajuste conjunto de pose de câmera ------------------------------------
    pose_adjust = CameraOptModule(len(views)).to(dev)
    pose_optimizer = torch.optim.Adam(pose_adjust.parameters(), lr=1e-5)

    # --- PPISP (correção de exposição/vinheta/cor por frame) --------------------------
    isp = PPISP(num_cameras=num_cameras, num_frames=len(views))
    isp_opts = isp.create_optimizers()
    isp_schedulers = isp.create_schedulers(isp_opts, steps)

    sh_degree_interval = max(200, steps // 40)

    print(f"[PPISP] {len(views)} frames, {n} Gaussians iniciais (cap_max={cap_max}), {num_cameras} camera(s).", flush=True)

    # --- Item 5: importance sampling de frames + parada adaptativa por platô ---------
    rng = np.random.default_rng(42)
    frame_err = np.ones(len(views), dtype=np.float64)
    warmup_steps = len(views) * 2  # duas passadas uniformes pra calibrar o erro por frame antes de priorizar

    plateau_check_every = max(500, steps // 100)
    min_steps_before_stop = max(3000, int(0.15 * steps))
    loss_window = deque(maxlen=plateau_check_every)
    prev_window_mean = None
    plateau_strikes = 0
    stopped_early_at = None

    for step in range(1, steps + 1):
        if step <= warmup_steps:
            frame_idx = (step - 1) % len(views)
        else:
            p = (frame_err + 1e-3) / (frame_err.sum() + 1e-3 * len(views))
            frame_idx = int(rng.choice(len(views), p=p))

        target_np, view_np, k_np, camera_idx = views[frame_idx]
        h, w = target_np.shape[:2]
        target = torch.from_numpy(target_np).to(dev)
        viewmat = torch.from_numpy(view_np).to(dev)
        k = torch.from_numpy(k_np).to(dev)

        camtoworld = pose_adjust(torch.linalg.inv(viewmat), torch.tensor(frame_idx, device=dev))
        viewmat_refined = torch.linalg.inv(camtoworld)

        sh_degree_now = min(step // sh_degree_interval, MAX_SH_DEGREE)
        colors = torch.cat([splats["sh0"], splats["shN"]], dim=1)  # [N, 16, 3]

        render, _, info = rasterization(
            splats["means"], splats["quats"], torch.exp(splats["scales"]),
            torch.sigmoid(splats["opacities"]), colors,
            viewmat_refined[None], k[None], w, h,
            packed=False, sh_degree=sh_degree_now, rasterize_mode="antialiased", absgrad=False,
        )
        raw = render[0]
        corrected = isp(raw, resolution=(w, h), camera_idx=camera_idx, frame_idx=frame_idx)
        photo_loss = F.l1_loss(corrected, target)
        loss = photo_loss + isp.get_regularization_loss()

        for opt in optimizers.values():
            opt.zero_grad(set_to_none=True)
        pose_optimizer.zero_grad(set_to_none=True)
        for opt in isp_opts:
            opt.zero_grad(set_to_none=True)

        loss.backward()

        for opt in optimizers.values():
            opt.step()
        pose_optimizer.step()
        for opt in isp_opts:
            opt.step()
        means_scheduler.step()
        for scheduler in isp_schedulers:
            scheduler.step()

        strategy.step_post_backward(
            params=splats, optimizers=optimizers, state=strategy_state,
            step=step, info=info, lr=means_scheduler.get_last_lr()[0],
        )

        with torch.no_grad():
            splats["scales"].clamp_(math.log(1e-5), math.log(2.0))

        frame_err[frame_idx] = 0.85 * frame_err[frame_idx] + 0.15 * max(photo_loss.item(), 1e-6)
        loss_window.append(loss.item())

        if step % 100 == 0:
            print(f"[PPISP] passo {step}/{steps}  loss={loss.item():.5f}  sh={sh_degree_now}  gaussians={len(splats['means'])}", flush=True)

        if step % args.export_every == 0:
            write_ply(out / f"passo_{step}.ply", splats["means"], splats["quats"], splats["scales"],
                       splats["opacities"], splats["sh0"], splats["shN"])

        # Item 5: parada adaptativa por platô de loss (treina até `steps` no máximo,
        # mas encerra antes se a melhora ficar abaixo de 0.1% por 3 checagens seguidas).
        if step >= min_steps_before_stop and step % plateau_check_every == 0 and len(loss_window) == plateau_check_every:
            cur_mean = float(np.mean(loss_window))
            if prev_window_mean is not None:
                improvement = (prev_window_mean - cur_mean) / max(prev_window_mean, 1e-8)
                plateau_strikes = plateau_strikes + 1 if improvement < 0.001 else 0
                if plateau_strikes >= 3:
                    stopped_early_at = step
                    print(f"[PPISP] Parada adaptativa: loss estabilizou em {cur_mean:.5f} "
                          f"(melhora <0.1% por 3 checagens). Passo {step}/{steps}.", flush=True)
                    break
            prev_window_mean = cur_mean

    final_step = stopped_early_at or steps
    write_ply(out / "final.ply", splats["means"], splats["quats"], splats["scales"],
               splats["opacities"], splats["sh0"], splats["shN"])
    torch.save({
        "gaussians": {k: v.detach() for k, v in splats.items()},
        "ppisp": isp.state_dict(),
        "pose_adjust": pose_adjust.state_dict(),
        "final_step": final_step,
    }, out / "ppisp_checkpoint.pt")
    print(f"[PPISP] concluído em {final_step} passos ({len(splats['means'])} Gaussians finais).", flush=True)


if __name__ == "__main__":
    main()
