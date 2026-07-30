"""Treina Triangle Splatting a partir de um projeto COLMAP e exporta a malha.

Diferente dos outros motores do BruxoSplat, aqui a primitiva é um TRIÂNGULO, não um
Gaussian. Isso muda o que sai no fim:

  - a saída é uma MALHA de verdade (COFF: vértices + faces com cor por face),
    que abre em Blender, Unity, Unreal e three.js sem shader especial;
  - não existe .ply de Gaussians, então o resultado NÃO abre nos visualizadores
    de splat convencionais.

O repositório oficial não é um pacote pip: é um conjunto de scripts. Por isso este
wrapper invoca `train.py` e `create_off.py` como subprocessos dentro do checkout,
em vez de importá-los.

Licença: núcleo Apache-2.0 (Univ. de Liège / KAUST / Oxford); o submódulo
`simple-knn` é da INRIA sob licença não-comercial, e o conjunto herda essa restrição.
"""
import argparse
import os
import subprocess
import sys


def run(cmd, cwd, env):
    """Executa um passo e repassa a saída linha a linha (o app lê isso pro log)."""
    print('[TriangleSplat] $ ' + ' '.join(str(c) for c in cmd), flush=True)
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        print(line.rstrip(), flush=True)
    proc.wait()
    if proc.returncode != 0:
        raise SystemExit(f'[TriangleSplat] passo falhou (código {proc.returncode}): {cmd[1] if len(cmd) > 1 else cmd[0]}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='checkout do triangle-splatting')
    ap.add_argument('--source', required=True, help='pasta do projeto COLMAP (com images/ e sparse/)')
    ap.add_argument('--output', required=True, help='pasta de saída do modelo')
    ap.add_argument('--iterations', type=int, default=30000)
    ap.add_argument('--outdoor', action='store_true', help='usa os hiperparâmetros de cena externa')
    # O train_game_engine.py poda triângulos de baixa opacidade e força opacidade alta
    # no fim do treino, deixando a malha compatível com o jeito que game engines
    # renderizam geometria. É o modo certo pra quem vai exportar a malha.
    ap.add_argument('--game-engine', action='store_true', default=True)
    ap.add_argument('--no-game-engine', dest='game_engine', action='store_false')
    ap.add_argument('--mesh-name', default='malha.off')
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    source = os.path.abspath(args.source)
    output = os.path.abspath(args.output)
    os.makedirs(output, exist_ok=True)

    if not os.path.isdir(os.path.join(source, 'sparse')):
        raise SystemExit('[TriangleSplat] O projeto precisa ter a pasta sparse/ do COLMAP. '
                         'Use o alinhamento COLMAP (o Triangle Splatting lê o mesmo formato).')

    env = dict(os.environ)
    # Sem isso o Python segura os prints em buffer e o log do app fica mudo por minutos.
    env['PYTHONUNBUFFERED'] = '1'
    env['PYTHONPATH'] = repo + os.pathsep + env.get('PYTHONPATH', '')

    script = 'train_game_engine.py' if args.game_engine else 'train.py'
    if not os.path.exists(os.path.join(repo, script)):
        # Versões antigas do repositório podem não ter a variante de game engine.
        print(f'[TriangleSplat] {script} não existe no checkout; usando train.py.', flush=True)
        script = 'train.py'

    cmd = [sys.executable, script, '-s', source, '-m', output, '--iterations', str(args.iterations)]
    if args.outdoor:
        cmd.append('--outdoor')
    print(f'[TriangleSplat] Treinando com {script} ({args.iterations} iterações)…', flush=True)
    run(cmd, repo, env)

    # Localiza o checkpoint gerado. O layout varia entre versões, então procuramos.
    ckpt = None
    for root, _dirs, files in os.walk(output):
        for f in files:
            if f == 'point_cloud_state_dict.pt':
                p = os.path.join(root, f)
                if ckpt is None or os.path.getmtime(p) > os.path.getmtime(ckpt):
                    ckpt = p
    if not ckpt:
        raise SystemExit('[TriangleSplat] Treino terminou mas não achei point_cloud_state_dict.pt em ' + output)

    mesh_out = os.path.join(output, args.mesh_name)
    print('[TriangleSplat] Exportando malha (.off com cor por face)…', flush=True)
    run([sys.executable, 'create_off.py', '--checkpoint_path', ckpt, '--output_name', mesh_out], repo, env)

    if not os.path.exists(mesh_out):
        raise SystemExit('[TriangleSplat] create_off.py não gerou o arquivo de malha.')
    print('[TriangleSplat] ✅ Malha salva em: ' + mesh_out, flush=True)


if __name__ == '__main__':
    main()
