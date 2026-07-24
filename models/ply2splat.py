"""Converte gaussians 3DGS em .ply (formato do SHARP/Brush) para .splat compacto (antimatter15).
O .splat é ~4x menor que o .ply e o parse é muito mais rápido (sem harmônicos esféricos de ordem alta),
o que deixa a sequência 4D bem mais leve pra carregar e tocar.

Uso: python ply2splat.py --input pasta_ou_arquivo.ply --output pasta_saida [--single arquivo.splat]
Se --input for uma pasta, converte todos os .ply dela; se for um arquivo, converte só ele.
"""
import argparse, os, sys, struct
import numpy as np

SH_C0 = 0.28209479177387814  # termo DC dos harmônicos esféricos → cor base

def parse_ply_header(f):
    """Lê o cabeçalho de um .ply binário little-endian e devolve (n_vertices, [(nome, np_dtype)]).
    É element-aware: só pega as propriedades do element 'vertex' (ignora face/edge e comentários)."""
    assert f.readline().strip() == b'ply', 'não é um arquivo .ply'
    fmt = f.readline().strip()
    if fmt != b'format binary_little_endian 1.0':
        raise ValueError('só suporto .ply binary_little_endian (recebi: %r)' % fmt)
    n = 0
    props = []
    cur = None  # element atual sendo descrito
    type_map = {b'float': '<f4', b'float32': '<f4', b'double': '<f8', b'float64': '<f8',
                b'uchar': 'u1', b'uint8': 'u1', b'char': 'i1', b'int8': 'i1',
                b'int': '<i4', b'int32': '<i4', b'uint': '<u4', b'uint32': '<u4',
                b'short': '<i2', b'int16': '<i2', b'ushort': '<u2', b'uint16': '<u2'}
    while True:
        line = f.readline()
        if not line:
            raise ValueError('cabeçalho .ply sem end_header')
        parts = line.split()
        if not parts:
            continue
        if parts[0] == b'comment' or parts[0] == b'obj_info':
            continue
        if parts[0] == b'element':
            cur = parts[1]
            if cur == b'vertex':
                n = int(parts[2])
        elif parts[0] == b'property' and cur == b'vertex':
            # só propriedades escalares no vertex (splats 3DGS não têm 'property list' no vertex)
            if parts[1] == b'list':
                continue
            props.append((parts[2].decode(), type_map.get(parts[1], '<f4')))
        elif parts[0] == b'end_header':
            break
    return n, props

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))

def convert_one(ply_path, splat_path):
    with open(ply_path, 'rb') as f:
        n, props = parse_ply_header(f)
        dtype = np.dtype([(name, t) for name, t in props])
        raw = f.read()  # lê todo o resto (o corpo binário)
        avail = len(raw) // dtype.itemsize
        if avail < n:
            # cabeçalho diz mais vértices do que o arquivo tem — usa o que dá em vez de quebrar
            n = avail
        data = np.frombuffer(raw, dtype=dtype, count=n)

    def col(name):
        return data[name].astype(np.float32) if name in data.dtype.names else None

    xyz = np.stack([col('x'), col('y'), col('z')], axis=1)
    scales = np.stack([col('scale_0'), col('scale_1'), col('scale_2')], axis=1)
    scales = np.exp(scales)  # o .ply guarda log(scale)
    rots = np.stack([col('rot_0'), col('rot_1'), col('rot_2'), col('rot_3')], axis=1)
    rots = rots / (np.linalg.norm(rots, axis=1, keepdims=True) + 1e-9)
    opacity = sigmoid(col('opacity'))
    fdc = np.stack([col('f_dc_0'), col('f_dc_1'), col('f_dc_2')], axis=1)
    rgb = np.clip(0.5 + SH_C0 * fdc, 0.0, 1.0)

    # ordena por "importância" (splats maiores e mais opacos primeiro) — padrão do formato .splat
    importance = -np.exp(scales.sum(axis=1)) / (1.0 + np.exp(-col('opacity')))
    order = np.argsort(importance)

    out = bytearray()
    pos_b = xyz[order].astype('<f4').tobytes()
    scale_b = scales[order].astype('<f4').tobytes()
    rgba = np.empty((n, 4), dtype=np.uint8)
    rgba[:, :3] = np.clip(rgb[order] * 255, 0, 255).astype(np.uint8)
    rgba[:, 3] = np.clip(opacity[order] * 255, 0, 255).astype(np.uint8)
    rot_b = np.clip(rots[order] * 128 + 128, 0, 255).astype(np.uint8)

    # intercala por splat: 3 floats pos, 3 floats scale, 4 bytes cor, 4 bytes rot = 32 bytes
    pos_a = np.frombuffer(pos_b, dtype=np.uint8).reshape(n, 12)
    scale_a = np.frombuffer(scale_b, dtype=np.uint8).reshape(n, 12)
    packed = np.concatenate([pos_a, scale_a, rgba, rot_b], axis=1)  # (n, 32)
    with open(splat_path, 'wb') as g:
        g.write(packed.tobytes())
    return n

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    os.makedirs(a.output, exist_ok=True)
    if os.path.isdir(a.input):
        plys = sorted([f for f in os.listdir(a.input) if f.lower().endswith('.ply')])
        if not plys:
            print('ERRO: nenhum .ply em', a.input); sys.exit(1)
        for i, name in enumerate(plys):
            out = os.path.join(a.output, os.path.splitext(name)[0] + '.splat')
            n = convert_one(os.path.join(a.input, name), out)
            print('OK %d/%d: %s (%d splats)' % (i + 1, len(plys), name, n), flush=True)
    else:
        out = os.path.join(a.output, os.path.splitext(os.path.basename(a.input))[0] + '.splat')
        n = convert_one(a.input, out)
        print('OK: %s (%d splats)' % (out, n), flush=True)
    print('DONE:', a.output)

if __name__ == '__main__':
    main()
