# Changelog

## 1.3.0 — 2026-07-30

Versão focada em **qualidade de treino**. A investigação de por que os splats saíam com menos
definição que outros aplicativos encontrou três bugs no caminho padrão — não eram limitações de
técnica, eram chamadas erradas ao motor.

### Corrigido — qualidade do treino (motor Brush)

- **O preset de qualidade era ignorado.** O app passava `--total-steps`, flag que **não existe** no
  Brush (o nome real é `--total-train-iters`). Como o Brush aborta em flag desconhecida, a chamada
  falhava e caía num modo de emergência com o padrão de **30.000 passos**: escolher "Ultra 75k" ou
  "Extreme 100k" não fazia diferença alguma. Agora o app lê o `--help` da versão instalada e usa os
  nomes que ela aceita.
- **Mip-Splatting estava desligado.** O Brush já traz anti-aliasing por footprint de pixel
  (`--render-mode mip`) e o app nunca ativava. Menos *shimmering* ao mover a câmera e mais nitidez
  a distância.
- **Densificação parava cedo demais.** O padrão do Brush interrompe a criação de Gaussians no passo
  15.000 independentemente do total; num treino de 100k, parava com 15% do caminho. Agora acompanha
  o total de passos.
- **Teto de resolução escondido.** O Brush reduz imagens acima de `--max-resolution` (padrão 1920) e
  o app nunca passava esse valor — não havia como treinar acima de Full HD.
- **Filtro de extração limitava a largura**, não o lado maior, apesar do rótulo. Em vídeo retrato
  isso deixava passar resolução acima da pedida, gastando VRAM à toa.

### Corrigido — trajeto de câmera

- A conversão de coordenadas do voo virtual **espelhava** a cena em vez de rotacioná-la (negava só o
  eixo Y): a câmera apontava para a direção errada e não ficava sobre o trajeto desenhado.
- O trajeto agora **acompanha os Gaussians** ao movê-los com o gizmo; antes ficava descolado.
- **DPVO:** campo de visão agora é configurável. O DPVO não lê o FOV real do vídeo e assumia 60°
  fixo, o que produzia câmera e trajetória com escala/proporção incompatíveis com a filmagem.

### Novo — Triangle Splatting (motor experimental que gera malha)

Novo motor de treino baseado em **Triangle Splatting** (3DV 2026, Univ. de Liège/KAUST/Oxford).
A primitiva é o **triângulo**, não o Gaussian — então a saída é uma **malha de verdade**
(`.off` no formato COFF, com cor por face), que abre em Blender, Unity, Unreal e MeshLab
sem shader especial.

- Consome o **mesmo projeto COLMAP** dos outros motores; não precisa refazer o alinhamento.
- Usa `train_game_engine.py` do repositório oficial, que poda triângulos de baixa opacidade e
  força opacidade alta no fim do treino, deixando a geometria compatível com game engines.
- Ambiente Python próprio (`pyenv_trianglesplat`, torch 2.4 + CUDA 12.4), com os dois módulos
  CUDA do projeto compilados na primeira instalação.
- Requer GPU NVIDIA; aparece desabilitado no macOS junto dos demais motores CUDA.

⚠️ **A saída não é um splat.** O `.off` não abre no editor de pontos nem no WebEDIT — o app
salva o arquivo e avisa. Um carregador de malha no WebEDIT fica para uma próxima etapa.

⚠️ **Licença:** o núcleo é Apache-2.0, mas o submódulo `simple-knn` vem da INRIA sob licença
**não-comercial**, e o conjunto herda essa restrição — mesma situação do MASt3R.

### Corrigido — exportação da câmera virtual

- **O sidecar `*.camera.json` era apenas copiado ao salvar uma edição.** Como o `edSave()` grava a
  transformação do gizmo dentro do PLY (`p' = q·(p·s) + t`), mover/girar/escalar os Gaussians fazia
  o PLY e a câmera deixarem de casar em qualquer visualizador externo. Agora a mesma transformação
  é aplicada às poses: centro da câmera, direção, up, `quaternionWorldToCamera` e
  `translationWorldToCamera`.
- **O campo `coordinateSystem` do JSON descrevia a conversão errada.** Dizia "display flips Y",
  quando o correto é uma rotação de 180° em torno de X — que nega Y **e** Z. Negar só o Y é um
  espelhamento e inverte a lateralidade da cena; foi exatamente o bug que existia no visualizador.
  O arquivo agora traz também um bloco `conventions` explicando cada campo.
- Novo documento **[CAMERA_PATH.md](CAMERA_PATH.md)** com o formato completo e um exemplo em three.js.

### Corrigido — macOS

- `mac.identity` mudou de `null` (assinatura desligada) para `"-"` (ad-hoc). Sem assinatura alguma,
  binários em Apple Silicon não executam e o macOS oferece mover o app para o Lixo — era a causa do
  app "sumir" após o download.

### Novo — seleção de trecho do vídeo com preview

Antes era preciso digitar início e fim em campos de hora/minuto/segundo, sem ver o vídeo — na
prática, adivinhando. Agora cada vídeo importado tem um botão 🎬 que abre uma janela de preview com:

- player do vídeo e uma **timeline com duas alças arrastáveis** para marcar início e fim;
- clique em qualquer ponto da barra para navegar;
- **play em laço apenas dentro do trecho marcado**, para conferir o corte antes de aplicar.

Os campos hh:mm:ss continuam existindo e são preenchidos ao aplicar o corte — o formato entregue ao
ffmpeg não mudou, então o resto do pipeline segue igual.

### Novo — controles de visualização do viewport

- **Estilos da nuvem de pontos:** Nuvem, Anéis, Centros, Depth cinza e Depth colorido, para inspecionar
  a reconstrução por profundidade em vez de só por cor.
- **Projeção Perspectiva / Ortográfica**, útil para conferir alinhamento e proporções sem distorção.

### Novo

- **Resolução até 4K** no treino: opções de 2560 (2.5K) e 3840 (4K).
- **Nitidez extra (LPIPS)**: perda perceptual opcional no motor Brush. Desligada por padrão.
- **Controle fino do COLMAP**: presets Alta/Máxima e modo Personalizado, expondo número de features,
  peak threshold, matcher (sequencial/exaustivo/vocabulary tree), guided matching, **loop
  detection**, DSP-SIFT, affine shape, bundle adjustment completo, mínimo de correspondências e
  ângulo de triangulação. O modo Automático continua padrão.
- **Progresso real**: a porcentagem passa a ser extraída do log das etapas longas (antes a barra
  ficava em 0% durante todo o alinhamento) e um indicador pulsante mostra há quanto tempo saiu a
  última linha. O log registra a linha de comando final enviada ao motor.
- **Versão visível** na barra superior do app.
- **macOS**: opções e botões que dependem de CUDA aparecem desabilitados, com o motivo no rótulo,
  em vez de falharem só na hora de executar.

### Editor 3dGS_WebEDIT (repositório separado)

- Abas novas de **Física** (massa-mola sobre os handles de Rig), **Semântica** (seleção e isolamento
  por região) e **4D**.
- **Translucência** (SSS-lite) no Relight.
- **Style Transfer Neural** real, com rede rodando no navegador via TensorFlow.js, aceitando
  qualquer imagem de estilo.

## 1.1.0 — 2026-07-25

### Novo

- Alinhamento **MegaSam** para câmera e profundidade em cenas dinâmicas.
- Motor **3DGRUT / Ray Tracing** experimental, isolado dos demais ambientes.
- DPVO integrado por pacote portátil CEB local, sem Docker.
- Câmera virtual persistente: `*.camera.json` ao lado do PLY, reprodução no viewport e no 3dGS_WebEDIT.

### Corrigido

- DPVO no Windows: ambiente Python/Torch/CUDA isolado e compatível.
- Exportação DPVO para COLMAP/Brush/PPISP: nomes dos frames, poses e pontos agora são normalizados antes do treino.
- Preview DPVO usa o PLY nativo e mostra o trajeto de câmera no editor.
- Interface e dicas dos motores em português e inglês; log pode ser copiado.
- Build macOS agora assina e verifica o pacote `.app` completo com assinatura ad-hoc antes de gerar DMG/ZIP, evitando assinaturas internas inconsistentes.

### Distribuição

- Pacotes portáteis CEB, pesos, ambientes Python, projetos e ferramentas baixadas são locais e não fazem parte deste repositório ou das releases públicas.
- Agradecimento especial a [CEB Studios](https://www.patreon.com/cebstudios) / [Carlos Barreto](https://github.com/carlosedubarreto) pela contribuição aos fluxos portáteis usados pelos conectores locais.

## 1.0.0

- Primeira versão pública.
