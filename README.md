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
# 🔮 BruxoSplat v1.1.0

**Vídeo → 3D Gaussian Splatting no seu PC, usando a sua GPU.** Projeto gratuito e open source por **Bruxos do VFX**.

O BruxoSplat transforma vídeos em Gaussian Splats e abre o resultado diretamente no editor [3dGS_WebEDIT](https://github.com/NyckM/3dGS_WebEDIT). Escolha o vídeo, o método de alinhamento de câmera e o motor de treino; o app cria os ambientes isolados necessários sem misturar dependências entre modelos.

## Destaques da v1.1.0

- **MegaSam**: câmera + profundidade para cenas dinâmicas, com exportação para PLY e visualização no editor.
- **DPVO CEB portátil**: rastreamento de câmera NVIDIA/CUDA no Windows, sem Docker. A saída é normalizada para funcionar com Brush e PPISP.
- **MASt3R**: modo experimental para cenas difíceis (uso não comercial; veja licença abaixo).
- **3DGRUT / Ray Tracing**: motor experimental isolado para testes avançados.
- Preview de nuvem de pontos e trajetória de câmera no viewport, com reprodução da câmera virtual.
- Interface e dicas em português e inglês; botão para copiar o log.

## Pipeline de vídeo

| Etapa | Opções | Resultado |
|---|---|---|
| Frames | ffmpeg | imagens do vídeo no FPS escolhido |
| Câmeras | COLMAP, DPVO, MASt3R ou MegaSam | poses e nuvem inicial |
| Treino | Brush, GSplat + PPISP ou 3DGRUT | Gaussian Splat `.ply` |
| Edição | 3dGS_WebEDIT | visualização, crop, animação e exportação |

### Métodos de câmera

- **COLMAP** — padrão mais universal; indicado para cenas estáticas com boa textura.
- **DPVO CEB (Windows/NVIDIA)** — rápido para vídeo contínuo. Usa um pacote portátil local com Python, Torch e CUDA compatíveis; não requer Docker.
- **MASt3R** — modo experimental para cenas difíceis. Os pesos e código oficiais usam **CC BY-NC-SA 4.0**: uso não comercial.
- **MegaSam** — experimental, combina trajetória e profundidade; especialmente útil em cenas dinâmicas.

DPVO e MegaSam não suportam vídeo 360/equiretangular no app. Para 360°, use o modo equiretangular com COLMAP.

## Outros recursos

- Foto → 3DGS com **SHARP**.
- Imagem → asset 3D com **TripoSplat / TripoSR**.
- Vídeo → rosto 4D com **FaceAnything**.
- Importação e edição de `.ply`, `.splat`, `.ksplat` e `.splat4d`.
- Timeline 4D, conversão para `.splat` e exportação de sequências.

## Requisitos

### Windows

- Windows 10/11 64-bit.
- GPU dedicada com 4 GB de VRAM no mínimo; 8 GB ou mais é recomendado.
- Internet no primeiro uso para baixar ferramentas e modelos abertos.
- NVIDIA é necessária para PPISP, MASt3R, MegaSam, FaceAnything, 3DGRUT e DPVO CEB.
- CUDA Toolkit e Visual Studio Build Tools são necessários apenas para motores que compilam extensões, como PPISP.

### macOS

- macOS 12 ou superior, Intel ou Apple Silicon.
- [Homebrew](https://brew.sh) para ferramentas de linha de comando.
- Alguns motores CUDA experimentais são exclusivos de NVIDIA/Windows.

## Instalação

### Usuários do app

Baixe o instalador ou a versão portátil em [Releases](../../releases):

- `BruxoSplat-Setup-1.1.0.exe` — instalador Windows.
- `BruxoSplat-Portable-1.1.0.exe` — Windows sem instalação.
- `.dmg` para macOS Intel ou Apple Silicon.

Na primeira execução, o app baixa ffmpeg, COLMAP e Brush para a pasta de dados do usuário.

### Executar a partir do código

```bash
git clone https://github.com/NyckM/BruxoSplat.git
cd BruxoSplat
npm install
npm start
```

No Windows, também é possível executar `INSTALAR.bat` uma vez e depois `RODAR.bat`.

## Pacotes locais opcionais: DPVO CEB e MegaSam

Os conectores DPVO CEB e MegaSam foram feitos para usar **pacotes portáteis adquiridos/fornecidos separadamente**. Eles não são incluídos neste repositório, nos instaladores públicos nem nas releases.

Depois de obter os pacotes com autorização e respeitar suas licenças, instale-os localmente em:

```text
%APPDATA%\BruxoSplat\external_engines\DPVO_CEB
%APPDATA%\BruxoSplat\external_engines\MegaSam_CEB
```

O app detecta os arquivos locais e mantém esses ambientes separados de PPISP, MASt3R e dos demais modelos. Nunca publique pesos, ambientes portáteis ou software de terceiros sem verificar a licença e ter permissão de redistribuição.

## Como usar

1. Grave uma cena com movimento lento, boa luz e sobreposição entre os quadros. Para objetos, faça uma órbita de 30 segundos a 2 minutos.
2. Importe o vídeo, escolha FPS, resolução, alinhamento e motor de treino.
3. Clique em **Iniciar Treino**. O log mostra o progresso; use **Copiar log** para enviar um diagnóstico.
4. O PLY final abre no editor e pode ser salvo/exportado.

Para DPVO, o app mostra a relação entre frames extraídos e poses usadas. Exemplo: `40/80 poses` é normal com `stride 2`.

### Câmera virtual e WebEDIT

Todo alinhamento que gera poses (incluindo **DPVO** e **MegaSam**) salva `camera_path.json` dentro do projeto. Ao concluir o treino, uma cópia chamada `NomeDoSplat.camera.json` é exportada ao lado do PLY. O arquivo preserva intrínsecas, poses COLMAP originais, posição, direção e up de cada frame.

O botão de trajeto no viewport reproduz essa câmera. Ao abrir o PLY no 3dGS_WebEDIT pelo BruxoSplat, o mesmo arquivo é enviado ao editor e aparece o botão **Camera virtual** para reproduzir o movimento. Ao salvar uma edição do PLY no app, o sidecar da câmera é copiado junto.

### Projeto `.bvfx`

Em **Cena → Salvar projeto**, o BruxoSplat cria um arquivo `.bvfx`. Ele guarda as referências do projeto local: frames, reconstrução, nuvem inicial, câmera virtual, PLY final e sidecar de câmera. Use **Abrir projeto** depois de atualizar ou reiniciar o app para recuperar a cena sem reprocessar o vídeo. O `.bvfx` aponta para os arquivos no seu computador; para mover o projeto a outro PC, copie também a pasta `proj_...` e o PLY exportado.

## Backup e uso offline

`backup_modelos.bat` cria um backup dos ambientes já instalados. `criar_pacote_offline.bat` prepara uma cópia offline para outro computador Windows compatível. Consulte [MODELOS_FONTES.txt](MODELOS_FONTES.txt) antes de redistribuir qualquer pacote ou peso.

## Publicar a v1.1.0

```bash
npm install
npm start
npm run dist:win
```

No macOS, execute `npm run dist:mac`; o workflow em `.github/workflows/build-mac.yml` também gera os artefatos no GitHub Actions ao publicar a tag `v1.1.0`.

Anexe os arquivos gerados em `dist/` a uma Release. Não anexe `node_modules`, `external_engines`, ambientes Python, pesos, projetos de usuários ou caches.

## Solução de problemas

- **COLMAP não reconstrói** — grave mais devagar, com mais luz e textura visível.
- **DPVO não aparece** — confirme uma GPU NVIDIA e a presença do pacote local CEB. Não é necessário Docker.
- **MASt3R/MegaSam falham** — copie o log e confira GPU, VRAM e o pacote/ambiente local correspondente.
- **PPISP falha ao compilar** — instale CUDA Toolkit e Visual Studio Build Tools; o ambiente PPISP permanece isolado.
- **Mac bloqueia o app** — a release recebe assinatura ad-hoc interna, mas não é notarizada. Clique com o botão direito → Abrir na primeira execução. Se o macOS reportar um pacote inconsistente, execute `LIBERAR_MAC.command` depois de copiar o app para Aplicativos; ele remove a quarentena, refaz a assinatura local e a verifica.

## Créditos e licenças

[Brush](https://github.com/ArthurBrussee/brush) · [COLMAP](https://colmap.github.io) · [DPVO](https://github.com/princeton-vl/DPVO) · [MASt3R](https://github.com/naver/mast3r) · [3DGRUT](https://github.com/nv-tlabs/3dgrut) · [ffmpeg](https://ffmpeg.org) · [TripoSR](https://github.com/VAST-AI-Research/TripoSR) · [SHARP](https://github.com/apple/ml-sharp)

### Agradecimento especial

Um agradecimento especial a **CEB Studios / Carlos Barreto** pelo trabalho e pela contribuição técnica que tornou possível a integração local dos fluxos portáteis de DPVO e MegaSam no Windows.

- [Patreon — CEB Studios](https://www.patreon.com/cebstudios)
- [GitHub — carlosedubarreto](https://github.com/carlosedubarreto)

O código do BruxoSplat é [MIT](LICENSE). Cada modelo e ferramenta de terceiros mantém sua própria licença. Veja [MODELOS_FONTES.txt](MODELOS_FONTES.txt).



