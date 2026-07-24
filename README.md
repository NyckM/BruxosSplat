# 🔮 BruxoSplat v1.0

**Vídeo → 3D Gaussian Splatting no seu PC, usando a sua GPU.** Gratuito e open source, por **Bruxos do VFX**.

<img width="1581" height="1015" alt="image" src="https://github.com/user-attachments/assets/c2fea7f2-a94b-4f3d-9d69-bb45429d9b91" />

Uma alternativa gratuita ao Postshot: escolha um vídeo, clique em *Iniciar Treino*, e o resultado abre direto no editor [3dGS_WebEDIT](https://github.com/NyckM/3dGS_WebEDIT) (efeitos, crop, animação de câmera, gravação de vídeo). Além do pipeline clássico de vídeo, a v1 traz modelos de IA para gerar splats a partir de **uma foto**, de **uma imagem 360°** e até **rostos em 4D** a partir de vídeo.

---

## O que tem na v1.0

**Pipeline clássico (vídeo → 3DGS)**

| Etapa | Ferramenta | O que faz |
|---|---|---|
| 1 | **ffmpeg** | extrai frames do vídeo |
| 2 | **COLMAP** ou **DPVO** | calcula a posição das câmeras |
| 3 | **[Brush](https://github.com/ArthurBrussee/brush)** | treina o Gaussian Splatting na sua GPU |
| 4 | **3dGS_WebEDIT** | abre o `.ply` no editor embutido |

- **Alinhamento de câmera COLMAP (padrão) ou DPVO** (experimental): DPVO é bem mais rápido em vídeos longos (roda via Docker + GPU NVIDIA), com calibração aproximada.
<img width="1585" height="1015" alt="image" src="https://github.com/user-attachments/assets/4965aa7f-04b6-43df-9a68-f6bc4279c2a0" />

**Modelos de IA** (aba IA — baixados sob demanda, cada um só na 1ª vez)

| Modelo | Entrada → Saída | Observações |
|---|---|---|
| **SHARP** | Foto → 3DGS | rápido, roda na GPU |
| **TripoSplat** (TripoSR) | Imagem → Asset 3D 360° | gera malha colorida; ambiente próprio (torch 2.6) |
| **FaceAnything** | Vídeo → Rosto 4D | requer GPU NVIDIA; ambiente próprio (torch 2.9 CUDA); checkpoint ~15 GB; licença CC BY-NC |

**Sequências 4D (timeline)**

- Importa sequências `.ply` / `.splat` / `.ksplat` de uma pasta, com **play/pause/scrub e FPS ajustável**.
- **Dois modos de reprodução:** *Stream* (leve na memória) e *GPU* (sobe tudo pra placa de vídeo, play instantâneo).
- **⚡ Converter pra .splat** — deixa a sequência ~4× menor e muito mais rápida de abrir/tocar (ideal pra saída `.ply` do SHARP 4D).
- **Exportar** como sequência de arquivos ou empacotada num único **`.splat4d`** (streaming).
- Abre a sequência inteira no **WebEDIT** como timeline (não só um frame).

**Importação** de `.ply`, `.splat`, `.ksplat` e `.splat4d`.

<img width="397" height="1097" alt="image" src="https://github.com/user-attachments/assets/bbf8acb3-be61-43eb-9fce-3cf4c19bc53e" />


---

## Requisitos

**Windows:** Windows 10/11 64-bit · GPU dedicada com ≥4 GB VRAM (8 GB+ recomendado) · internet no primeiro uso.
- Modelos de IA que compilam extensões (TripoSplat) precisam do **Visual Studio Build Tools** + **CUDA Toolkit** (o app cuida do resto).
- FaceAnything e DPVO exigem **GPU NVIDIA**; DPVO exige também **Docker Desktop**.

**macOS:** macOS 12+ (Intel ou Apple Silicon) · [Homebrew](https://brew.sh) · GPU dedicada recomendada (Apple Silicon treina bem via Metal/WGPU). Alguns modelos de IA podem não suportar Apple Silicon.

---

## Instalação (para quem só quer usar o app)

### Windows

**Instalador pronto (recomendado):** vá em **[Releases](../../releases)**, baixe `BruxoSplat-Setup-1.0.0.exe` (instalador) ou `BruxoSplat-Portable-1.0.0.exe` (só executar), e rode. Não precisa de Node, Python nem terminal.

**A partir do código:** baixe o ZIP (**Code → Download ZIP**) para `C:\BruxoSplat`, rode **`INSTALAR.bat`** uma vez, depois **`RODAR.bat`** (ou `BruxoSplat.vbs`, que abre sem janela de terminal).

### macOS

**App pronto (recomendado):** em **[Releases](../../releases)**, baixe `BruxoSplat-1.0.0-arm64.dmg` (Apple Silicon) ou `BruxoSplat-1.0.0-x64.dmg` (Intel), abra o `.dmg` e arraste pra Aplicativos. **Na primeira vez**, clique com o **botão direito no ícone → Abrir → Abrir** (o app não é assinado — veja mais abaixo).

**A partir do código:** baixe o ZIP, rode **`INSTALAR.command`** uma vez (se o Finder recusar: `chmod +x *.command`), depois **`RODAR.command`**.

Na primeira execução o app baixa sozinho ffmpeg, COLMAP e Brush (`%APPDATA%\BruxoSplat\tools` no Windows; Homebrew no Mac).

---

## Como usar

1. Grave 30 s–2 min orbitando o objeto/cena **devagar**, com boa luz e sem borrão (ou use uma foto/imagem na aba IA).
2. Abra o BruxoSplat → *Importar vídeos* → *Iniciar Treino* (ou escolha um modelo na aba IA).
3. O `.ply` é salvo em `Documentos\BruxoSplat` e abre no editor. Sequências 4D aparecem na timeline embaixo.

---

## Guardar e reinstalar os modelos (offline)

Os modelos e pesos são grandes e vêm de fontes externas (GitHub, HuggingFace). Para não depender delas no futuro, o app inclui bats de backup — veja **`MODELOS_FONTES.txt`** para a origem de cada um e onde ficam guardados.

- **Mesmo PC (rápido):** `backup_modelos.bat` cria um `.tar` com tudo; `instalar_modelos.bat` restaura sem internet.
- **Outro PC / portátil:** `criar_pacote_offline.bat` monta um pacote completo (Python + ambientes já compilados + repositórios + pesos); `instalar_offline.bat` recria os ambientes em qualquer Windows 64-bit, offline.

Cada modelo pesado roda no seu **ambiente Python isolado** (`pyenv`, `pyenv_triposplat`, `pyenv_faceanything`) para evitar conflitos de versão de torch — um modelo nunca quebra o outro.

---

## Compilar (para publicar uma nova versão)

Precisa do [Node.js](https://nodejs.org) (LTS). **O build do Mac só pode ser gerado num Mac** — o electron-builder não cria pacotes Mac a partir do Windows/Linux.

**Windows** — sem terminal: `INSTALAR.bat` uma vez, depois `GERAR_EXE.bat`. Ou:

```bash
npm install
npm start          # testar em modo dev
npm run dist:win   # gera o instalador + portátil em /dist
```

**macOS** — sem terminal: `INSTALAR.command` uma vez, depois `GERAR_APP.command`. Ou `npm run dist:mac`. (Também há `.github/workflows/build-mac.yml` para gerar o `.dmg` pela aba **Actions** do GitHub, sem precisar de um Mac.)

Os arquivos em `dist/` (`BruxoSplat-Setup-1.0.0.exe`, `BruxoSplat-Portable-1.0.0.exe`, `BruxoSplat-1.0.0-arm64.dmg`, `BruxoSplat-1.0.0-x64.dmg`) são o que você anexa numa **Release** no GitHub.

> **Assinatura no Mac:** o build sai **sem assinatura/notarização** (exige conta Apple Developer paga, US$99/ano). Sem isso, o Gatekeeper mostra "desenvolvedor não identificado" na 1ª abertura — clique com o botão direito → Abrir. É normal fora da Mac App Store.

---

## Solução de problemas

- **"COLMAP não conseguiu reconstruir"** → vídeo rápido/tremido, pouca luz ou pouca sobreposição. Grave mais devagar. (Ou teste o alinhamento **DPVO**.)
- **Modelo de IA "DLL load failed"** → conflito de torch entre modelos. Na v1 cada modelo tem ambiente próprio; se acontecer, reinstale o modelo pela aba IA.
- **FaceAnything "cai pra CPU"** → precisa de GPU NVIDIA e do torch CUDA (o app instala do índice cu128). Confira se sua GPU é NVIDIA.
- **DPVO** → precisa do Docker Desktop aberto e GPU NVIDIA.
- **GPU AMD/Intel (Windows)** → o pipeline de vídeo funciona (Brush usa WGPU), mas COLMAP roda na versão *nocuda* (mais lento) e os modelos de IA que exigem CUDA não rodam.
- **Mac: "app está danificado"** → é o Gatekeeper, não corrupção. Botão direito → Abrir, ou `xattr -cr /Applications/BruxoSplat.app`.

---

<img width="437" height="237" alt="image" src="https://github.com/user-attachments/assets/6072c8e3-3a3f-4c35-b0a3-6a8dad79de43" />


## Créditos

[Brush](https://github.com/ArthurBrussee/brush) · [COLMAP](https://colmap.github.io) · [DPVO](https://github.com/princeton-vl/DPVO) · [ffmpeg](https://ffmpeg.org) · [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) · [TripoSR](https://github.com/VAST-AI-Research/TripoSR) · [SHARP](https://github.com/apple/ml-sharp) · FaceAnything · Feito com 💜 por **Bruxos do VFX**

Licença: MIT (o app). Modelos de IA mantêm suas próprias licenças — ver `MODELOS_FONTES.txt`.
