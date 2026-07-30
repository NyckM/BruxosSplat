# 🔮 BruxoSplat v1.3.0

**Vídeo → 3D Gaussian Splatting no seu PC, usando a sua GPU.** Gratuito e open source, por **Bruxos do VFX**.

<img width="1581" height="1015" alt="BruxoSplat" src="https://github.com/user-attachments/assets/c2fea7f2-a94b-4f3d-9d69-bb45429d9b91" />

Uma alternativa gratuita ao Postshot: escolha um vídeo, clique em *Iniciar Treino*, e o resultado abre direto no editor [3dGS_WebEDIT](https://github.com/NyckM/3dGS_WebEDIT) (efeitos, crop, animação de câmera, gravação de vídeo). Além do pipeline clássico de vídeo, o app traz modelos de IA para gerar splats a partir de **uma foto**, de **uma imagem 360°** e até **rostos em 4D** a partir de vídeo.

---

## 🆕 O que mudou na v1.3.0

Esta versão é focada em **qualidade de treino**. Investigando por que os splats saíam com menos definição que outros aplicativos, encontramos três bugs no caminho padrão — não eram limitações de técnica, eram chamadas erradas ao motor.

### Correções de qualidade (motor Brush)

**O preset de qualidade era ignorado.** O app passava a flag `--total-steps` para o Brush, mas esse parâmetro **não existe** — o nome real é `--total-train-iters`. Como o Brush aborta em flag desconhecida, a chamada falhava e caía num modo de emergência que rodava com o padrão de **30.000 passos**. Na prática, escolher "Ultra 75k" ou "Extreme 100k" não fazia diferença alguma. Agora o app lê o `--help` da versão instalada do Brush e usa exatamente os nomes que ela aceita, o que também deixa o app compatível com versões futuras.

**Mip-Splatting estava desligado.** O Brush já traz anti-aliasing por footprint de pixel embutido (`--render-mode mip`), e o app nunca ativava — treinava sempre no modo padrão. Ligado agora: menos *shimmering* ao mover a câmera, mais nitidez a distância e zoom mais estável.

**A densificação parava cedo demais.** O padrão do Brush interrompe a criação de novos Gaussians no passo 15.000, independentemente do total. Num treino de 100k, ela parava com 15% do caminho andado e os outros 85k passos apenas refinavam um conjunto que já tinha parado de crescer. Agora o limite acompanha o total de passos.

### Resolução até 4K

O Brush reduz qualquer imagem acima de `--max-resolution` (padrão **1920**) ao carregar o dataset, e o app nunca informava esse valor — não havia como treinar acima de Full HD, mesmo extraindo frames maiores. Agora há opções de **2560 (2.5K)** e **3840 (4K)**.

Junto veio a correção do filtro de extração, que limitava a **largura** em vez do lado maior (apesar do rótulo dizer "lado maior"). Em vídeo retrato isso deixava passar resolução bem acima da pedida, gastando VRAM à toa.

> **Dica:** 4K multiplica o consumo de VRAM e o tempo do COLMAP. Se faltar memória, reduza o **FPS de extração** (menos frames) antes de reduzir a resolução — poucos frames em 4K costuma render mais nitidez que muitos frames em 1080p.

### Seleção do trecho do vídeo com preview

Antes era preciso digitar início e fim em campos de hora/minuto/segundo **sem ver o vídeo** — na prática, adivinhando onde ficava o trecho bom. Agora cada vídeo da lista tem um botão **🎬** que abre uma janela de preview com o player e uma **timeline com duas alças arrastáveis** para marcar início e fim. Dá para clicar em qualquer ponto da barra para navegar e usar o play, que **repete em laço apenas o trecho marcado** — assim você confere exatamente o corte antes de aplicar.

Os campos hh:mm:ss continuam lá e são preenchidos ao aplicar, então nada muda no que é entregue ao ffmpeg.

### Controles de visualização no viewport

- **Estilos da nuvem de pontos:** Nuvem, Anéis, Centros, **Depth cinza** e **Depth colorido** — úteis para inspecionar a reconstrução por profundidade em vez de só por cor.
- **Projeção Perspectiva / Ortográfica**, para conferir alinhamento e proporções sem distorção de perspectiva.

### Nitidez extra (LPIPS)

Perda perceptual opcional no motor Brush: compara as imagens pelo que o olho percebe em vez de pixel a pixel. Costuma dar um salto de nitidez em textura fina. Vem **desligada por padrão**, porque encarece o treino e muda a métrica de loss (o que atrapalha comparações A/B).

### Controle fino do COLMAP

Novo seletor **Qualidade do alinhamento**, com presets **Alta** e **Máxima** e um modo **Personalizado** que expõe:

número de features por imagem · peak threshold · matching sequencial/exaustivo/vocabulary tree · guided matching · **loop detection** · DSP-SIFT · affine shape · bundle adjustment completo (focal, ponto principal e distorção) · mínimo de correspondências · ângulo mínimo de triangulação.

O modo **Automático** continua sendo o padrão e mantém o comportamento anterior.

> **Loop detection** é o item mais relevante para vídeo: sem ele, uma filmagem que dá a volta e retorna ao ponto de partida nunca liga o fim ao começo, e o erro de pose acumulado aparece como deriva. Exige uma *vocabulary tree* pré-treinada (~250 MB), que o app baixa **sob demanda**, só quando você marca a opção.
>
> **Atenção:** *affine shape* e *DSP-SIFT* não têm implementação em GPU no COLMAP. Ligar qualquer um dos dois joga a extração de features para a CPU, multiplicando o tempo dessa etapa. Valem a pena em cenas difíceis, não como padrão.

### Progresso real durante o processamento

Etapas longas como o alinhamento de câmeras ficavam com a barra parada em 0% mesmo com o log mostrando `100%|##########| 784/784`. Agora a porcentagem é extraída do log, e um indicador pulsante mostra há quanto tempo saiu a última linha — para ninguém fechar o app achando que travou durante um passo interno silencioso.

O log também passa a registrar a linha de comando final enviada ao motor (`▶ Brush: ...`), para que dê para conferir se os parâmetros foram aplicados.

### Correção do trajeto de câmera

A conversão de coordenadas do voo virtual **espelhava** a cena em vez de rotacioná-la (negava só o eixo Y), então a câmera apontava para a direção errada e nem sequer ficava sobre o trajeto desenhado na tela. Além disso, o trajeto agora **acompanha os Gaussians** quando você os move com o gizmo — antes ficava para trás, descolado do modelo.

### Editor WebEDIT

O [3dGS_WebEDIT](https://github.com/NyckM/3dGS_WebEDIT) recebeu abas novas de **Física** (simulação massa-mola sobre os handles de Rig), **Semântica** (seleção e isolamento por região), **4D**, além de **translucência** no Relight e **Style Transfer Neural de verdade** (rede rodando no navegador via TensorFlow.js, aceita qualquer imagem de estilo).

---

## Pipeline clássico (vídeo → 3DGS)

| Etapa | Ferramenta | O que faz |
|---|---|---|
| 1 | **ffmpeg** | extrai frames do vídeo |
| 2 | **COLMAP**, **DPVO**, **MASt3R** ou **MegaSam** | calcula a posição das câmeras |
| 3 | **[Brush](https://github.com/ArthurBrussee/brush)**, **GSplat + PPISP**, **3DGRUT** ou **Triangle Splatting** | treina o Gaussian Splatting na sua GPU |
| 4 | **3dGS_WebEDIT** | abre o `.ply` no editor embutido |

<img width="1585" height="1015" alt="Alinhamento de câmera" src="https://github.com/user-attachments/assets/4965aa7f-04b6-43df-9a68-f6bc4279c2a0" />

### Métodos de câmera

- **COLMAP** — padrão mais universal; indicado para cenas estáticas com boa textura. É o único que suporta vídeo 360°/equiretangular.
- **DPVO CEB** (Windows/NVIDIA) — rápido em vídeo contínuo, via pacote portátil local, sem Docker. A calibração é aproximada: se a câmera aparecer com escala ou proporção estranhas, ajuste o **campo de visão** nos parâmetros (o DPVO não lê o FOV real do vídeo).
- **MASt3R** — experimental, para cenas difíceis. Código e pesos oficiais em **CC BY-NC-SA 4.0**: uso não comercial.
- **MegaSam** — experimental, combina trajetória e profundidade; útil em cenas dinâmicas.

### Motores de treino

- **Brush** — padrão, multiplataforma (roda em NVIDIA, AMD, Intel e Apple Silicon via WebGPU). É o motor recomendado.
- **GSplat + PPISP** — experimental, NVIDIA/CUDA. Corrige exposição, vinheta e cor entre frames. Traz densificação MCMC, learning rate por atributo, SH progressivo, anti-aliasing, refinamento de câmera e *importance sampling* de frames.
- **3DGRUT / Ray Tracing** — experimental, RTX.
- **Triangle Splatting** — experimental, NVIDIA/CUDA. A primitiva é o **triângulo**, não o Gaussian, então a saída é uma **malha de verdade** (`.off` em formato COFF, com cor por face) que abre em Blender, Unity, Unreal e MeshLab sem shader especial. Consome o mesmo projeto COLMAP dos outros motores. ⚠️ A saída **não é um splat**: não abre no editor de pontos nem no WebEDIT. ⚠️ O submódulo `simple-knn` vem da INRIA sob licença **não comercial**, e o conjunto herda essa restrição.

---

## Modelos de IA

Baixados sob demanda, cada um só na primeira vez. Cada modelo roda no **seu próprio ambiente Python isolado** para evitar conflitos de versão de torch — um modelo nunca quebra o outro.

| Modelo | Entrada → Saída | Observações |
|---|---|---|
| **SHARP** | Foto → 3DGS | rápido; funciona também no macOS |
| **TripoSplat** (TripoSR) | Imagem → Asset 3D 360° | gera malha colorida; ambiente próprio (torch 2.6); requer NVIDIA |
| **FaceAnything** | Vídeo → Rosto 4D | requer NVIDIA; ambiente próprio (torch 2.9 CUDA); checkpoint ~15 GB; licença CC BY-NC |
| **ZipSplat** | Foto/Vídeo → 3DGS | requer NVIDIA/CUDA |

---

## Sequências 4D (timeline)

<img width="397" height="1097" alt="Timeline 4D" src="https://github.com/user-attachments/assets/bbf8acb3-be61-43eb-9fce-3cf4c19bc53e" />

- Importa sequências `.ply` / `.splat` / `.ksplat` de uma pasta, com **play/pause/scrub e FPS ajustável**.
- **Dois modos de reprodução:** *Stream* (leve na memória) e *GPU* (sobe tudo pra placa, play instantâneo).
- **⚡ Converter pra .splat** — deixa a sequência ~4× menor e muito mais rápida de abrir.
- **Exportar** como sequência de arquivos ou empacotada num único **`.splat4d`** (streaming).
- Abre a sequência inteira no **WebEDIT** como timeline, não só um frame.
- Importação de `.ply`, `.splat`, `.ksplat` e `.splat4d`.

---

## Requisitos

### Windows

- Windows 10/11 64-bit.
- GPU dedicada com 4 GB de VRAM no mínimo; 8 GB ou mais recomendado. Para treinar em 4K, 12 GB ou mais.
- Internet no primeiro uso, para baixar ferramentas e modelos abertos.
- **NVIDIA** é necessária para PPISP, MASt3R, MegaSam, FaceAnything, ZipSplat, TripoSplat, 3DGRUT e DPVO CEB.
- CUDA Toolkit e Visual Studio Build Tools são necessários apenas para motores que compilam extensões, como o PPISP.

### macOS

- macOS 12 ou superior, Intel ou Apple Silicon.
- [Homebrew](https://brew.sh) — o app usa `brew` para instalar ffmpeg e COLMAP (o COLMAP não publica binário pronto para Mac).

**✅ O que funciona no macOS:** alinhamento por **COLMAP**, treino com o motor **Brush** (usa Metal via WebGPU e vai bem no Apple Silicon), o editor completo, o WebEDIT e o modelo **SHARP**.

**❌ O que não funciona no macOS:** PPISP, DPVO, MASt3R, MegaSam, 3DGRUT, TripoSplat, FaceAnything e ZipSplat. Todos dependem de **CUDA**, que é exclusivo de placas NVIDIA e não existe no Mac. Não é uma limitação do app e não há como contornar — na versão Mac essas opções e botões aparecem **desabilitados**, com o motivo no rótulo.

### Linux

Ainda não há build oficial para Linux. O app depende de binários pré-compilados de ffmpeg, COLMAP e Brush, e o COLMAP publica apenas binários Windows — o suporte a Linux exige um caminho próprio via gerenciador de pacotes, ainda não implementado.

---

## Instalação

### Windows

**Instalador pronto (recomendado):** em **[Releases](../../releases)**, baixe `BruxoSplat-Setup-1.3.0.exe` (instalador) ou `BruxoSplat-Portable-1.3.0.exe` (só executar). Não precisa de Node, Python nem terminal.

**A partir do código:** baixe o ZIP (**Code → Download ZIP**) para `C:\BruxoSplat`, rode **`INSTALAR.bat`** uma vez, depois **`RODAR.bat`** (ou `BruxoSplat.vbs`, que abre sem janela de terminal).

### macOS

**App pronto:** em **[Releases](../../releases)**, baixe o `.dmg` correspondente (`arm64` para Apple Silicon, `x64` para Intel), abra e arraste para Aplicativos.

**A partir do código:** baixe o ZIP, rode **`INSTALAR.command`** uma vez (se o Finder recusar: `chmod +x *.command`), depois **`RODAR.command`**.

#### ⚠️ "O app está danificado" ou some depois de baixar

O BruxoSplat é gratuito e **não tem certificado de desenvolvedor da Apple** (custa US$ 99/ano). Por isso o macOS marca o download como suspeito e pode oferecer mover o app para o Lixo. **O app não está danificado nem infectado** — é apenas a ausência de assinatura paga.

Para abrir:

1. Arraste o BruxoSplat para a pasta **Aplicativos**.
2. Abra o Terminal e rode:
   ```bash
   xattr -cr /Applications/BruxoSplat.app
   ```
   Isso remove a marca de quarentena que o navegador colocou no arquivo.
3. Abra normalmente.

*Alternativa sem Terminal:* clique com o **botão direito** no app → **Abrir** → confirme. Ou vá em **Ajustes do Sistema → Privacidade e Segurança** e clique em **Abrir mesmo assim**.

Na primeira execução o app baixa sozinho ffmpeg, COLMAP e Brush (`%APPDATA%\BruxoSplat\tools` no Windows; Homebrew no Mac).

---

## Como usar

1. Grave uma cena com movimento **lento**, boa luz, sem borrão e com sobreposição entre os quadros. Para objetos, faça uma órbita de 30 segundos a 2 minutos.
2. Importe o vídeo e escolha FPS, resolução, alinhamento e motor de treino. Use o botão **🎬** ao lado do arquivo para assistir ao vídeo e marcar início e fim direto na timeline.
3. Clique em **Iniciar Treino**. O log mostra o progresso; use **Copiar log** para enviar um diagnóstico.
4. O `.ply` é salvo em `Documentos\BruxoSplat` e abre no editor. Sequências 4D aparecem na timeline embaixo.

> Não extraia todos os frames se houver pouco movimento. Um frame a cada 2–5 costuma funcionar melhor que 30 fps: reduz redundância e facilita o matching.

Para DPVO, o app mostra a relação entre frames extraídos e poses usadas. Exemplo: `40/80 poses` é normal com `stride 2`.

### Câmera virtual e WebEDIT

Todo alinhamento que gera poses (incluindo DPVO e MegaSam) salva `camera_path.json` dentro do projeto. Ao concluir o treino, uma cópia chamada `NomeDoSplat.camera.json` é exportada ao lado do PLY, preservando intrínsecas, poses COLMAP originais, posição, direção e up de cada frame.

O botão de trajeto no viewport reproduz essa câmera. Ao abrir o PLY no 3dGS_WebEDIT pelo BruxoSplat, o mesmo arquivo é enviado ao editor e aparece o botão **Câmera virtual**.

Se você quiser usar esse trajeto em outra engine (three.js, Babylon, WebGL puro, Blender), veja **[CAMERA_PATH.md](CAMERA_PATH.md)** — documenta o formato completo, as convenções de cada campo, a conversão de coordenadas correta (rotação de 180° em X, **não** apenas negar o Y) e um exemplo pronto em three.js.

A partir da v1.3.0, quando você move/gira/escala os Gaussians com o gizmo e salva, a **mesma transformação é aplicada às poses de câmera** antes de gravar o sidecar. Antes o arquivo era só copiado, e PLY e câmera saíam desalinhados sempre que o gizmo era usado.

### Projeto `.bvfx`

Em **Cena → Salvar projeto**, o BruxoSplat cria um arquivo `.bvfx` com as referências do projeto local: frames, reconstrução, nuvem inicial, câmera virtual, PLY final e sidecar de câmera. Use **Abrir projeto** para recuperar a cena sem reprocessar o vídeo. O `.bvfx` aponta para arquivos no seu computador; para mover o projeto a outro PC, copie também a pasta `proj_...` e o PLY exportado.

---

## Pacotes locais opcionais: DPVO CEB e MegaSam

Os conectores DPVO CEB e MegaSam foram feitos para usar **pacotes portáteis fornecidos separadamente**. Eles não são incluídos neste repositório, nos instaladores públicos nem nas releases.

Depois de obter os pacotes com autorização e respeitando suas licenças, instale-os em:

```text
%APPDATA%\BruxoSplat\external_engines\DPVO_CEB
%APPDATA%\BruxoSplat\external_engines\MegaSam_CEB
```

O app detecta os arquivos locais e mantém esses ambientes separados dos demais. Nunca publique pesos, ambientes portáteis ou software de terceiros sem verificar a licença e ter permissão de redistribuição.

---

## Backup e uso offline

Os modelos e pesos são grandes e vêm de fontes externas (GitHub, HuggingFace). Para não depender delas no futuro:

- **Mesmo PC:** `backup_modelos.bat` cria um `.tar` com tudo; `instalar_modelos.bat` restaura sem internet.
- **Outro PC:** `criar_pacote_offline.bat` monta um pacote completo (Python + ambientes compilados + repositórios + pesos); `instalar_offline.bat` recria os ambientes em qualquer Windows 64-bit, offline.

Consulte [MODELOS_FONTES.txt](MODELOS_FONTES.txt) para a origem de cada modelo antes de redistribuir qualquer pacote ou peso.

---

## Compilar e publicar

Precisa do [Node.js](https://nodejs.org) (LTS). **O build do Mac só pode ser gerado num Mac** — o electron-builder não cria pacotes Mac a partir do Windows.

**Windows** — sem terminal: `INSTALAR.bat` uma vez, depois `GERAR_EXE.bat`. Ou:

```bash
npm install
npm start          # testar em modo dev
npm run dist:win   # gera instalador + portátil em /dist
```

**macOS** — `npm run dist:mac`, ou use o workflow `.github/workflows/build-mac.yml` pela aba **Actions** do GitHub (roda num Mac do GitHub, sem precisar de um Mac próprio). Ele também dispara sozinho ao publicar uma tag `v*.*.*`.

Anexe os arquivos de `dist/` a uma Release. **Não anexe** `node_modules`, `external_engines`, ambientes Python, pesos, projetos de usuários ou caches.

---

## Solução de problemas

- **A qualidade não melhora ao aumentar os passos** — confira no log a linha `▶ Brush:`. Se aparecer o aviso de que o Brush recusou os parâmetros, atualize o Brush: a versão instalada é antiga demais e o preset de qualidade não está sendo aplicado.
- **COLMAP não reconstrói** — grave mais devagar, com mais luz e textura visível. Tente o preset de alinhamento **Alta**.
- **A cena "não fecha" num vídeo que dá a volta** — ative **loop detection** nos parâmetros de alinhamento.
- **A câmera do DPVO aparece com escala/proporção erradas** — ajuste o **campo de visão** nos parâmetros; o DPVO não lê o FOV real do vídeo e assume 60° por padrão.
- **Falta de memória em 4K** — reduza o FPS de extração antes de reduzir a resolução.
- **PPISP falha ao compilar** — instale CUDA Toolkit e Visual Studio Build Tools; o ambiente PPISP permanece isolado dos demais.
- **Mac bloqueia o app** — veja a seção de instalação do macOS acima (`xattr -cr`).

---

## Créditos e licenças

[Brush](https://github.com/ArthurBrussee/brush) · [COLMAP](https://colmap.github.io) · [gsplat](https://github.com/nerfstudio-project/gsplat) · [PPISP](https://github.com/nv-tlabs/ppisp) · [DPVO](https://github.com/princeton-vl/DPVO) · [MASt3R](https://github.com/naver/mast3r) · [3DGRUT](https://github.com/nv-tlabs/3dgrut) · [ffmpeg](https://ffmpeg.org) · [TripoSR](https://github.com/VAST-AI-Research/TripoSR) · [SHARP](https://github.com/apple/ml-sharp) · [Magenta.js](https://github.com/magenta/magenta-js)

### Agradecimento especial

Um agradecimento especial a **CEB Studios / Carlos Barreto** pelo trabalho e pela contribuição técnica que tornou possível a integração local dos fluxos portáteis de DPVO e MegaSam no Windows.

- [Patreon — CEB Studios](https://www.patreon.com/cebstudios)
- [GitHub — carlosedubarreto](https://github.com/carlosedubarreto)

O código do BruxoSplat é [MIT](LICENSE). Cada modelo e ferramenta de terceiros mantém sua própria licença. Veja [MODELOS_FONTES.txt](MODELOS_FONTES.txt).
