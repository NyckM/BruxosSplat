# Changelog

## 1.2.0 — 2026-07-28

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

### Corrigido — macOS

- `mac.identity` mudou de `null` (assinatura desligada) para `"-"` (ad-hoc). Sem assinatura alguma,
  binários em Apple Silicon não executam e o macOS oferece mover o app para o Lixo — era a causa do
  app "sumir" após o download.

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
