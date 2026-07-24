"""SHARP (Apple ml-sharp): uma foto -> Gaussian Splatting em segundos.
Baseado no notebook Bruxos_VFX_SHARP.ipynb."""
import argparse, subprocess, sys, os, glob

p = argparse.ArgumentParser()
p.add_argument('--input', required=True)   # imagem
p.add_argument('--output', required=True)  # pasta de saída
a = p.parse_args()
os.makedirs(a.output, exist_ok=True)

# CLI oficial do ml-sharp: baixa os pesos sozinho na 1ª execução.
# 'sharp' é instalado como um entrypoint (script gerado pelo pip), não como pacote executável via
# "python -m sharp" (por isso isso dá "'sharp' is a package and cannot be directly executed") — e o
# bare "sharp" também falha porque a pasta Scripts/bin do venv não está no PATH do sistema.
# A forma confiável é achar o executável do entrypoint do próprio venv, ao lado do python que está rodando.
venv_bin = os.path.dirname(sys.executable)
sharp_exe = os.path.join(venv_bin, 'sharp.exe' if os.name == 'nt' else 'sharp')

if os.path.exists(sharp_exe):
    r = subprocess.run([sharp_exe, 'predict', '-i', a.input, '-o', a.output])
else:
    # fallback 1: talvez exista um "__main__" de fato numa versão futura do pacote
    r = subprocess.run([sys.executable, '-m', 'sharp', 'predict', '-i', a.input, '-o', a.output])
    if r.returncode != 0:
        # fallback 2: bare 'sharp' (funciona se por algum motivo já estiver no PATH)
        r = subprocess.run(['sharp', 'predict', '-i', a.input, '-o', a.output])
sys.exit(r.returncode)
