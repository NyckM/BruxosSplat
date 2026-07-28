# BruxoSplat + WebEDIT — Roadmap de Pesquisa (jul/2026)

Este documento organiza tudo que você trouxe (os ~30 links de papers/repos + as ideias de treinamento) em um plano de trabalho. A regra de separação usada em todo o documento:

- **BruxoSplat (app desktop)** = tudo que muda **como** os Gaussians são gerados/treinados (qualidade, steps, densificação, câmera).
- **WebEDIT (3dGS_WebEDIT)** = tudo que muda **o que você faz** com os Gaussians depois de prontos (visualizar, editar, animar, exportar).

Diagnóstico do bug relatado (modo PPISP com qualidade pior que Brush) vem primeiro porque muda a prioridade do resto do roadmap.

---

## 1. Por que o modo "PPISP" fica pior que o Brush (causa raiz encontrada)

Fui ler `models/ppisp_train.py` e comparar com o motor Brush. O nome certo é **PPISP** (não "ppip") — é uma extensão da NVIDIA que corrige exposição/vinheta/cor por frame, aplicada *em cima* do render antes da loss. O problema não é o PPISP em si, é o treinador gsplat que criamos para rodar ao lado dele. Comparado ao Brush, `ppisp_train.py` hoje:

- **Não faz densificação nem poda.** O número de Gaussians fica travado no que o COLMAP devolveu (até 180k pontos) do início ao fim do treino. O Brush cresce e poda Gaussians o tempo todo.
- **Uma única learning rate (0.002) para tudo** — posição, cor, escala, rotação e opacidade aprendem todos na mesma velocidade. O 3DGS original (e o Brush) usa uma LR por atributo.
- **Sem Spherical Harmonics** — a cor é um RGB fixo (`sigmoid`), sem componente dependente do ângulo de visão. Isso perde brilho especular e reflexos que o Brush captura.
- **Sem anti-aliasing/mip-splatting, sem resolution schedule, sem reset de opacidade.**

Ou seja: aos mesmos "steps", o Brush está fazendo um treino completo e o PPISP está fazendo uma otimização rasa de uma nuvem de pontos fixa. A boa notícia é que a lib `gsplat` (já é dependência do PPISP) **já implementa isso pronto** — `gsplat.strategy.DefaultStrategy` (densificação clássica + AbsGS) e `gsplat.strategy.MCMCStrategy` (densificação por reamostragem, sem heurísticas de gradiente) — e `rasterization(..., antialiased=True)` para mip-splatting. Não precisamos escrever densificação do zero: dá para plugar a strategy do gsplat no `ppisp_train.py` e ganhar Brush-parity, mantendo a correção de exposição do PPISP como diferencial extra (nenhum dos dois motores tem isso hoje). Esse é o item #1 da seção 3.

---

## 2. WebEDIT (3dGS_WebEDIT) — o que adicionar no visualizador

O visualizador já é rico (10 abas: Editar, Distorção, Câmera, Luz/Cor, Transição, Diversos, Interativo, Cinema, VFX, Rig, Experimental) e já tem timeline 4D, modo GPU/Stream, conversão `.splat`. A separação **3DGS vs 4DGS** que você pediu:

### 2.1 Novo agrupamento de botões

Hoje o 4D já se comporta como um "modo" (a timeline só aparece com `seq4d` carregado), mas está solto misturado nas outras abas. Proposta: criar uma aba dedicada **"🎞 4D"** na barra de ferramentas, junto das já existentes, reunindo o que já existe (Timeline, Stream/GPU, conversão `.splat`, Time Slice) e onde entram as novidades de sequência dinâmica (Sync4D, FreeTimeGS — ver 2.2). Isso também abre espaço para 2 abas novas, ainda vazias, para os recursos mais ambiciosos:

- **"🧬 Semântica"** — seleção por texto/clique (LangSplat).
- **"🩹 Física"** — simulação leve sobre os handles de Rig (PhysGaussian).

### 2.2 O que puxar de cada paper, por encaixe real

| Paper/Repo | O que é | Onde encaixa | Esforço |
|---|---|---|---|
| **LangSplat** (minghanqin) | Destila features de linguagem (CLIP+SAM) em cada Gaussian, permite selecionar objetos digitando uma palavra | Aba nova "Semântica": clique ou texto → isola/oculta Gaussians. Depende de uma passada extra no treino do BruxoSplat (não é só viewer) | Alto — precisa mudar o treinador e o viewer juntos |
| **PhysGaussian** (XPandora) | Simulação física (MPM) direto sobre Gaussians, sem malha | Aba "Física": jelly/soft-body puxando os handles de Rig que já existem no viewer | Alto — MPM completo é pesado pro navegador; viável uma versão simplificada (mass-spring) usando o rig já pronto |
| **SuGaR** (Anttwo) | Extrai malha (mesh) de uma cena já treinada | Exportação: botão "Exportar malha (OBJ)" no BruxoSplat, pós-treino | Médio — é um passo de otimização extra (~30-45min), não em tempo real |
| **StyleSplat** | Transferência de estilo por região | Aba VFX/Experimental como filtro; versão "de verdade" exige reotimizar os Gaussians (melhor como ação offline no BruxoSplat) | Médio-Alto |
| **Scaffold-GS** (city-super) | Gaussians "âncora" com MLP prevendo atributos — menos memória, mais qualidade em cenas grandes | Motor de treino alternativo no BruxoSplat para cenas grandes/complexas | Alto — formato de dado incompatível com `.splat`/`.ply` simples; precisaria de exportação especial |
| **VastGaussian** | Divide-e-conquista para cenas grandes ao ar livre | BruxoSplat, para captações muito grandes (múltiplos vídeos) | Longo prazo |
| **VHAP / GaussianAvatars / GHA / Goliath** | Pipelines de avatar de cabeça/corpo (tracking + rig) | Concorrem com o FaceAnything que já temos. VHAP é só o tracker e poderia virar uma alternativa ao MASt3R/DPVO para rostos. Goliath (Meta) exige rig multi-câmera — não serve para vídeo único | Baixa prioridade — já coberto pelo FaceAnything |
| **Online-3DGS-Monocular** (Meta, SIGGRAPH 2025) | Reconstrução incremental em tempo real, câmera única | Futuro "preview ao vivo enquanto filma". Só Linux/CUDA hoje | Longo prazo / experimental |
| **VolSplat** (ECCV 2026) | Rede prevê Gaussians direto da imagem, sem otimização por cena | Modo "Preview rápido" no BruxoSplat: prévia em segundos, qualidade menor, antes do treino completo | Médio — é um modelo pré-treinado a mais para baixar, no estilo TripoSplat |
| **RayGauss / GRay** | Ray tracing volumétrico de Gaussians (reflexos/refração) | Não serve pro viewer WebGL em tempo real (30min–2h de treino). Poderia virar um "render still de alta qualidade" offline | Baixo, nicho |
| **GSWT** (SIGGRAPH Asia 2025) | "Wang tiles" de Gaussians — padrões repetíveis eficientes | Nicho, útil só para ambientes/fundos proceduais no viewer | Baixo prioridade |
| **FreeTimeGS** (ZJU, CVPR 2025) | Gaussians "livres no espaço-tempo", melhor 4D atual | Alvo de longo prazo para o modo 4D do BruxoSplat (hoje é sequência de frames do SHARP) | Alto |
| **Sync4D** | Transfere movimento de um vídeo de referência para um asset 3D gerado | Ótimo complemento pro TripoSplat (imagem→3D): dá movimento a um objeto estático sem precisar de rig manual | Alto, mas é o tipo de diferencial real |
| **3D-MOM / ICLR2025** | Anima água/nuvens de uma foto de paisagem só (cinemagraph) | Candidato a um quarto modelo de IA no BruxoSplat (parecido com SHARP), efeito "uau" com pouco esforço de UI | Médio |
| **No3DTrackSG / instok3d / Syn4D** | Pesquisa de tracking/tokenização de cena e um dataset sintético | Bastidor (poderiam melhorar qualidade de alinhamento 4D no futuro), não são feature de usuário final | Baixo, monitorar |
| **AlignYourGaussians (TXT4D)** | Texto → 4D via difusão de vídeo (NVIDIA) | Fora do escopo (vídeo único do usuário, não geração generativa por texto) | Não recomendado |
| **GaussianSR** | Super-resolução de cena já treinada | Pós-processamento no BruxoSplat para escanenamentos de baixa resolução (SHARP/FaceAnything) | Médio |
| **SSS-GS** (Dihlmann) | Subsurface scattering + relight em tempo real | Reforça a ferramenta de Relight que o viewer já tem — pele/cera/folhas ficam mais realistas | Médio-Alto — precisa assar parâmetros de material no treino |
| **Lyra 2.0** (NVIDIA, Apache-2.0) | Uma foto → vídeo navegável → 3DGS completo | **O mais interessante da lista.** Um quinto modelo de IA no BruxoSplat: gera mundo 3D andável a partir de 1 foto só. Licença permite uso comercial | Alto — precisa checar tamanho de checkpoint/VRAM antes de prometer |
| **RealityScan** (Epic) | App de fotogrametria proprietário, sem SDK aberto | Não dá para integrar (não é biblioteca) — só citar como alternativa externa | Não integrável |
| **awesome-4dgs** (lista) | Bibliografia curada de 4DGS | Não é ferramenta — bom radar para revisitar a cada poucos meses | — |

---

## 3. BruxoSplat (treinador) — plano de qualidade, em ordem de prioridade

### Curto prazo (resolve o bug relatado + ganhos rápidos de UI)

1. **Reescrever `ppisp_train.py` para usar `gsplat.strategy.DefaultStrategy`/`MCMCStrategy`.** Isso sozinho traz densificação, poda, absgrad e paridade real com o Brush — é a correção direta do "PPISP fica pior". Junto: separar as learning rates por atributo (posição com decaimento exponencial, cor/opacidade/escala/rotação fixas — os valores clássicos do paper original já são um bom ponto de partida) e ligar `antialiased=True` (mip-splatting) na rasterização.
2. **SH degree progressivo** (0 → 1 → 2 → 3, subindo a cada N mil passos) — item clássico, melhora bastante detalhe fino e reflexos, baixo custo de implementação.
3. **Exposure/Appearance optimization** já existe via PPISP — só precisa ficar disponível no motor Brush também (hoje só o motor experimental tem). Vale expor como opção independente do motor escolhido.
4. **Presets de qualidade estendidos**: adicionar Ultra (75k) e Extreme (100k) ao `<select id="steps">`, mais uma opção "Custom" com campo numérico livre — a tabela que você mandou (Draft 7k / Medium 15k / High 30k / Maximum 50k / Ultra 75k / Extreme 100k / Custom) bate exatamente com o que já existe, é só estender.
5. **Densificação/poda escaladas com os steps**: hoje os cronogramas de `densify_from_iter`/`densify_until_iter` são pensados para ~30k. Ao invés de travar em valores fixos, calcular `densify_until_iter` como uma fração dos steps totais (ex.: até 50% do treino) para que 100k passos realmente aproveitem as iterações extras, e não apenas façam refino fino no final — exatamente o ponto que você levantou.
6. **Gráfico de loss em tempo real**: o processo já imprime `passo X/Y loss=Z` no stdout (visto no `ppisp_train.py`, e o Brush tem equivalente). Já existe streaming de linhas de log para a UI — só falta: (a) extrair o valor de loss com regex no `main.js`, (b) mandar via IPC, (c) desenhar num canvas simples (sparkline) na tela de progresso. Não precisa de lib externa, dá pra fazer com `<canvas>` puro em ~100 linhas.

### Médio prazo

7. **Parada adaptativa por platô de loss**: treinar até no máx. 100k, checar a cada 500–1000 passos a média móvel da loss, e encerrar se a melhora ficar abaixo de um limiar (ex. <0,1%) por alguns ciclos seguidos. Assim uma cena simples termina em ~28k e uma cena complexa vai até 80-90k sem gastar tempo à toa. Isso é direto de implementar no loop de treino (é só uma condição de saída antecipada).
8. **Importance sampling de câmeras/frames**: em vez de sortear o próximo frame uniformemente (como o `ppisp_train.py` faz hoje com `rng.integers`), manter um erro médio por frame e amostrar com probabilidade proporcional a esse erro — mais passos de treino para as views difíceis, menos para as já convergidas. Ganho de qualidade sem custo de tempo extra.
9. **Camera fine-tuning (bundle adjustment conjunto)**: permitir que as poses de câmera (vindas do COLMAP/DPVO/MASt3R) recebam um pequeno ajuste durante o treino junto com os Gaussians. O `gsplat.rasterization` já aceita `viewmats` diferenciáveis, então é possível declarar as poses como parâmetros treináveis com uma LR bem baixa. Reduz borrões de um alinhamento de câmera imperfeito — você marcou isso como ⭐⭐⭐⭐⭐ e concordo, é um dos itens de maior retorno.
10. **Densificação por curvatura/bordas**: em vez de só usar o gradiente da loss (como o algoritmo clássico), calcular um mapa de bordas/detalhe por view (Sobel/Laplaciano na imagem, ou curvatura da geometria já reconstruída) e usar isso para enviesar onde novos Gaussians nascem — cabelo, fios, folhas e cantos ganham mais densidade. É uma heurística de pré-processamento, não exige treinar rede nova.
11. **GaussianSR como pós-processo opcional** para escaneamentos de baixa resolução.

### Longo prazo (as três apostas que você descreveu para 2026-2027)

12. **Treino guiado por IA** — uma rede pequena decide densificar/podar/LR por região em vez de heurísticas fixas (na prática, isso está começando a aparecer como "learned strategies" em papers recentes de 3DGS; ainda não há implementação pronta para importar, seria pesquisa própria).
13. **Treino hierárquico** — Gaussians grandes primeiro (estrutura global), refino só nas áreas complexas depois. Scaffold-GS (seção 2) é o parente mais próximo disso que já tem código aberto.
14. **Treino semântico** — usar SAM 2/DINO para diferenciar superfície, vegetação, pessoas, objetos, e aplicar estratégia diferente por tipo de região. LangSplat é o caminho mais maduro para começar essa direção (distillation de features, seção 2).
15. **Lyra 2.0 como novo modelo de IA** e **Sync4D** para animar assets do TripoSplat são as duas apostas de "feature nova" (não só qualidade) que mais se destacam da lista toda.

---

## 4. Ordem sugerida de execução

Sugiro atacar nesta ordem, cada item já é uma tarefa fechada e testável sozinha:

1. Trocar densificação do PPISP para `gsplat.strategy` (resolve o bug reportado).
2. LR por atributo + SH progressivo + antialiasing no PPISP.
3. Presets 75k/100k/Custom + densify schedule escalado por steps.
4. Gráfico de loss em tempo real.
5. Parada adaptativa por platô + importance sampling de frames.
6. Camera fine-tuning conjunto.
7. Densificação por curvatura.
8. A partir daí, decidir junto qual dos itens "grandes" (Lyra 2.0, LangSplat, PhysGaussian-lite, Sync4D) vira o próximo grande recurso do app.

Me diga por qual item da lista 1-7 você quer começar e eu já parto para a implementação.

---

## 4.1 ⭐ CAUSA RAIZ da diferença de qualidade vs. outros apps (jul/2026)

Comparando com o MipMap, você notou Gaussians melhores e mais rápidos. Fui atrás do motivo e encontrei **três bugs reais no caminho padrão** (motor Brush), não uma limitação de técnica. Isso muda tudo, porque o Brush em si é bom — nós é que estávamos chamando ele errado.

### Bug 1 — o preset de qualidade era silenciosamente ignorado (o mais grave)

O `pipeline.js` passava `--total-steps` para o Brush. **Essa flag não existe.** O nome real é `--total-train-iters` (confirmado no fonte: `crates/brush-train/src/config.rs`). O clap (parser de argumentos do Brush) aborta com erro em flag desconhecida, então a chamada inteira falhava e caía no `catch` — que rodava o Brush **sem nenhum parâmetro**, ou seja, com o padrão dele: **30.000 passos**.

Consequência: escolher "Máxima — 50k", "Ultra — 75k" ou "Extreme — 100k" **não fazia diferença nenhuma**. Todo treino rodava 30k. E o aviso do fallback estava enterrado no log como uma linha discreta.

### Bug 2 — Mip-Splatting existia e estava desligado

Você perguntou como aplicar Mip-Splatting. Resposta: **o Brush já tem isso embutido**. Existe `SplatRenderMode { Default, Mip }` (em `crates/brush-render/src/gaussian_splats.rs`) exposto como `--render-mode mip`. O app nunca ativou — treinava sempre no `Default`. É exatamente o filtro passa-baixa por footprint de pixel que você descreveu: menos shimmering ao mover a câmera, mais nitidez a distância, zoom estável.

### Bug 3 — a densificação parava cedo demais em treinos longos

`growth_stop_iter` no Brush tem padrão **15000 fixo**, que **não acompanha** o total de passos. Num treino de 100k, a densificação parava com 15% do caminho — os outros 85k passos só refinavam um conjunto de Gaussians que já tinha parado de crescer. É a explicação técnica de por que "mais passos" não virava "mais qualidade" mesmo quando o preset funcionava.

### O que foi corrigido

O `trainSplat()` agora lê o `--help` da build do Brush instalada e monta os argumentos com os nomes que **aquela build** aceita (funciona em versões antigas e novas, sem chutar):

- `--total-train-iters` (com fallback pro `--total-steps` legado) → o preset de qualidade finalmente é respeitado;
- `--render-mode mip` → Mip-Splatting ligado;
- `--growth-stop-iter` escalado para 50% do total de passos (mínimo 15000) → treinos longos densificam por mais tempo;
- o fallback de emergência agora **avisa em alto e bom som** que o preset não foi aplicado, em vez de mascarar o problema.

### O que NÃO era o problema (verificado, para não perder tempo aí)

- ~~`max_resolution` do Brush~~ → **corrigido depois: ERA um teto sim.** O Brush reduz qualquer imagem acima de `--max-resolution` (padrão **1920**) ao carregar o dataset, e o app nunca passava essa flag. Com o seletor da UI limitado a 1920 o problema ficava escondido, mas significava que **não havia como treinar acima de Full HD**. Agora a flag é passada com a resolução escolhida, e a UI oferece **2560 (2.5K)** e **3840 (4K)**.
  - Junto veio outro bug: o filtro do ffmpeg era `scale='min(MAX,iw)':-2`, que limita a **largura**, não o lado maior (apesar do rótulo dizer "lado maior"). Em vídeo retrato isso deixava passar resolução bem acima da pedida (2160x3840 com preset 1600 virava 1600x2844) — gastando VRAM à toa. Trocado por uma expressão que limita o lado maior de verdade em retrato e paisagem, sem nunca fazer upscale (testado com ffmpeg real: 3840x2160→1600x900, 2160x3840→900x1600, 1280x720→inalterado).
- `sh_degree`: padrão **3** (completo) → harmônicos esféricos já estavam no máximo.
- `max_splats`: padrão **10.000.000** → não era teto.

### Ainda no radar (não implementado, precisa de teste seu)

- ~~`--lpips-loss-weight`~~ → **implementado** como "Nitidez extra (perceptual)" na aba de parâmetros: Desligada (padrão) / Leve (0.1) / Média (0.25) / Forte (0.5). Verificado que o LPIPS do Brush é uma VGG embutida no binário (crate `lpips`, depende só de `burn` + `image`) — **não baixa nada em runtime**, então funciona offline. Roda **só em desktop** (em WASM o Brush ignora), o que serve pro nosso caso. Fica desligado por padrão de propósito: encarece o treino e muda a métrica de loss, o que atrapalharia a comparação A/B dos 4 fixes.
- **`--refine-every`** (padrão 200): a doc do Brush diz que idealmente é "o número de imagens necessárias pra cobrir a cena". Para vídeos com muitos frames, ajustar pode ajudar — mas é chute sem medir, então deixei quieto.
- **Velocidade**: o Brush roda em WebGPU (portátil, roda em AMD/Intel/Mac). Apps como o MipMap usam CUDA nativo, que é mais rápido em placas NVIDIA. Esse gap é arquitetural — nosso caminho equivalente é o motor PPISP (gsplat/CUDA), que já tem MCMC, LR por atributo, SH progressivo, antialiasing, câmera refinada e importance sampling implementados.

### ⚠️ Observação importante sobre o PPISP

Todo o trabalho de qualidade que fizemos antes (densificação MCMC, learning rate por atributo, SH progressivo, `rasterize_mode="antialiased"`, fine-tuning de câmera, importance sampling, densificação por bordas) está no **`ppisp_train.py`** — que na UI aparece como **"experimental"** e **não é o padrão**. O padrão é o Brush. Ou seja: as melhorias estavam invisíveis para quem não trocava o motor manualmente. Vale reconsiderar qual motor é o padrão depois de testar os dois lado a lado com os fixes acima.

### 🧪 Protocolo de teste dos 4 fixes (fazer ANTES de qualquer mudança grande)

Foram 4 correções que nunca rodaram numa máquina real. Testar tudo junto com outras mudanças torna impossível saber o que funcionou. Sugestão:

1. Pegue **uma cena** já conhecida (de preferência uma que hoje ficou ruim) e mantenha o mesmo vídeo, mesmo FPS de extração e mesmo método de alinhamento em todos os testes.
2. Rode com **1920** e o preset **Alta — 30k**. No log, procure a linha `▶ Brush:` — ela mostra a linha de comando final. Confirme que aparecem `--total-train-iters 30000`, `--render-mode mip`, `--growth-stop-iter` e `--max-resolution 1920`.
   - Se em vez disso aparecer o aviso `⚠️ O Brush recusou os parâmetros de qualidade`, **pare**: a build do Brush instalada é velha demais e precisa ser atualizada antes de qualquer teste.
3. Rode a **mesma cena** com o preset **Extreme — 100k**. Antes essa opção não mudava nada (treinava 30k); agora deve levar visivelmente mais tempo e densificar até o passo 50000.
4. Só depois de confirmar 2 e 3, suba a resolução pra 2560 ou 3840. Aqui o gargalo vira VRAM: se estourar memória, reduza o FPS de extração antes de reduzir a resolução.

O que observar: nitidez em texturas finas (tecido, folhagem, texto), estabilidade ao mover a câmera (o Mip ataca o shimmering) e o número final de Gaussians.

### Controle fino do COLMAP (implementado)

O `automatic_reconstructor` que usávamos **não aceita** nenhuma das opções de qualidade do SIFT/matching/mapper — ele só tem `--quality LOW|MEDIUM|HIGH|EXTREME`. Para expor esses controles foi preciso trocar pelo pipeline em etapas (`feature_extractor` → `sequential_matcher`/`exhaustive_matcher` → `mapper`).

Novo seletor **"Qualidade do alinhamento (COLMAP)"**: `Automático` (padrão, comportamento antigo intacto) · `Alta` (16384 features, peak 0.003, guided matching) · `Máxima` (32768, peak 0.002, + DSP-SIFT + affine shape) · `Personalizado` (todos os campos expostos).

Duas correções ao que foi sugerido, verificadas na doc oficial do COLMAP:

- **`first_octave` já é `-1` por padrão** — não era um ganho, só já estava certo. Passamos explícito mesmo assim, pra não depender do padrão mudar entre versões.
- **`edge_threshold` já é `10` por padrão** — idem.

Cuidados que valem registro:

- **`estimate_affine_shape` e `domain_size_pooling` não têm kernel CUDA no COLMAP.** Ligar qualquer um dos dois joga a extração de features pra CPU, o que multiplica o tempo dessa etapa várias vezes. Por isso ficam desligados fora do preset "Máxima", e a UI avisa.
- **Loop detection: implementado** (junto com o matcher `vocab_tree_matcher`). Exige a vocabulary tree pré-treinada do COLMAP, então o app agora baixa a árvore de 32K palavras (~250 MB) **sob demanda** — só quando o usuário marca loop detection ou escolhe o matcher por vocabulary tree, nunca no fluxo padrão. Se o download falhar, o alinhamento segue sem loop detection em vez de abortar. Vem ligado no preset "Máxima": sem ele, um vídeo que dá a volta e volta ao ponto de partida nunca fecha o laço, e o erro de pose acumulado aparece como deriva — por melhor que sejam os outros parâmetros.
- **Dense (PatchMatch Stereo + Stereo Fusion) não foi implementado**, de propósito: como você mesmo observou, o 3DGS treina a partir das câmeras e da nuvem esparsa. A nuvem densa custa muito tempo/VRAM e não entra no treino — só faria sentido se um dia exportarmos malha por outro caminho.
- **Nomes de flag mudam entre versões**: o COLMAP 4.x renomeou `--SiftMatching.guided_matching` para `--FeatureMatching.guided_matching` (e `SiftExtraction.use_gpu`/`max_image_size` para `FeatureExtraction.*`). Como o Brush já tinha nos mordido com isso, aqui a montagem dos argumentos lê o `-h` de cada subcomando e usa só os nomes que a build instalada aceita; flag inexistente é simplesmente omitida.
- **Fallback**: se o caminho ajustado falhar, o app refaz no modo Automático e **avisa em alto e bom som** que os parâmetros escolhidos não foram aplicados — em vez de perder o alinhamento inteiro ou fingir que deu certo.

Padrão continua **Automático** de propósito: mudar o alinhamento junto com os 4 fixes de treino tornaria impossível saber o que causou qualquer diferença.

### Primitivas texturizadas ("Less Gaussians, Texture More") — o caminho depois dos fixes

A ideia central do LGTM é aplicável **sem** os pesos bloqueados da Apple: cada primitiva carrega uma **textura RGB + alpha map** em vez de só cor achatada/SH, então uma primitiva texturizada cobre o detalhe que hoje exige dezenas de Gaussians pequenos. É a resposta estrutural pra "pouca definição" e, de quebra, reduz muito o tamanho do arquivo. Isso é **independente do feed-forward** — funciona em otimização por cena, que é o que fazemos.

| Caminho | Licença | Vantagem | Custo |
|---|---|---|---|
| **Patch gsplat do LGTM** (`extern/gsplat.patch`, gsplat no commit `32f2a54`) | **Código: permissiva** (estilo BSD da Apple — sem cláusula NC, sem research-only; a restrição research-only é só dos *pesos*, que não usaríamos) | Já temos gsplat no ambiente PPISP → menor salto técnico | Patch preso a um commit específico do gsplat; conflita com upgrades futuros |
| **BBSplat** (`david-svitov/BBSplat`) | INRIA Gaussian-Splatting — **não-comercial, sem sublicenciar** (mesmo formato do FLAME: usuário aceita e baixa por conta) | Implementação de referência; PSNR 29.72 no DTU em Full HD; arquivos até **17x menores**; exporta **planos texturizados .obj pro Blender** (também atacaria o problema do Mesh) | Rasterizador CUDA próprio; motor separado, não reaproveita o que temos |

**⚠️ O bloqueio de verdade não é licença, é formato.** Primitiva texturizada **não é `.ply` padrão**. O WebEDIT, o SuperSplat e qualquer viewer de terceiros renderizam Gaussians achatados e não conseguem exibir textura por primitiva. Adotar isso significa:

- escrever suporte no WebEDIT (shader + carregamento de atlas de textura) só pra conseguir *ver* o resultado;
- perder compatibilidade com `KHR_gaussian_splatting`, SPZ, SOG e viewers externos;
- manter dois formatos de saída em paralelo.

Ou seja: é decisão de arquitetura, não ajuste de qualidade. Só faz sentido depois de confirmar que os 4 fixes acima não resolveram o problema.

### Sobre o `apple/ml-lgtm`

Verifiquei: é ICLR 2026 (Apple + HKU), **feed-forward** (prevê Gaussians texturizados direto da imagem, sem otimizar por cena) e mira 4K. Dois bloqueios: (1) os **pesos** são "Apple Machine Learning Research Model License" — literalmente *"does not include any commercial exploitation, product development or use in any commercial product or service"*, o mesmo tipo de bloqueio do Lyra 2.0; (2) exige o dataset DL3DV (acesso restrito no HuggingFace). Não é um upgrade plugável no nosso pipeline de otimização por cena — é outra categoria de método. **Não recomendo** como caminho de qualidade.

---

## 5. Atualização jul/2026 — próximos alvos confirmados + pesquisa nova

Você confirmou interesse em **Lyra 2.0** e **Sync4D** (BruxoSplat) e pediu para elevar os três "lite" do WebEDIT (seleção, física, style transfer) para versões mais reais. Verifiquei os papers/tendências novos que você mandou — todos são reais, com fonte:

- **OpenUSD**: confirmado — versão 26.03 (mar/2026) adicionou o schema `UsdVolParticleField3DGaussianSplat` nativo; Omniverse RTX já renderiza com path tracing. ([nvidia.com](https://www.nvidia.com/en-us/glossary/openusd/), [aousd.org](https://aousd.org/news/alliance-for-openusd-announces-new-member-milestone-industrial-momentum-and-core-specification-progress/))
- **glTF `KHR_gaussian_splatting`**: confirmado, é candidate extension da Khronos, com extensão irmã `KHR_gaussian_splatting_compression_spz` pro formato SPZ. ([khronos.org](https://www.khronos.org/news/press/gltf-gaussian-splatting-press-release))
- **RT-GS2**: confirmado (BMVC 2024) — segmentação semântica *generalizável* (não precisa treinar por cena), 27 FPS, fusão de features view-dependent/independent. ([arxiv.org/abs/2405.18033](https://arxiv.org/abs/2405.18033))
- **SplatBus**: confirmado, arXiv jan/2026 — viewer via IPC da NVIDIA para expor Gaussians pro Unity/Blender/UE/OpenGL. Não se aplica a nós (WebEDIT já é o próprio viewer, não precisamos de uma ponte de IPC).
- **GOF (2024) → SOF (SIGGRAPH Asia 2025)**: confirmado, é extração de malha via opacity field, SOF é 3x mais rápido. Concorrente direto do SuGaR já listado na seção 2 — mesma categoria (exportar malha), então não é um item extra, é uma alternativa ao SuGaR a avaliar quando chegarmos nesse botão.
- **SPZ / KSplat / SOG**: confirmado e **relevante direto pra gente** — o WebEDIT já roda em cima do GaussianSplats3D, cujo formato nativo **é o próprio KSplat**. SPZ/SOG são formatos de entrega (10x menores que .ply), com qualidade quase idêntica. Vale um botão de exportar `.spz`/`.sog` no BruxoSplat ou no WebEDIT pra quem for publicar/hospedar a cena — é a peça que falta pra interoperar com o ecossistema (Omniverse, glTF, outros viewers).
- **Multi-Scale 3DGS, Analytic-Splatting, Mip-Splatting, AA-2DGS, densificação por borda 2025, GeoGaussian**: todos reais e coerentes com o que você já tinha mandado antes. Já cobrimos a parte de mais retorno (mip-splatting via `rasterize_mode="antialiased"` do gsplat, item 1 da seção 3). O resto (multi-escala/LOD, integral analítica, densificação edge-aware "de verdade") é ganho incremental sobre isso — fica como backlog de qualidade, não é bug nem lacuna.

**Onde isso entra no roadmap**: os itens de formato (SPZ/SOG/glTF/KSplat) são baixo esforço e alto valor prático — proponho como um item novo, curto prazo, no BruxoSplat (exportar direto nesses formatos). OpenUSD/SplatBus são infraestrutura de terceiros, não uma feature nossa — só monitorar. RT-GS2 é o candidato mais concreto para a "seleção melhor" (ver 5.2 abaixo).

### 5.1 Lyra 2.0 + Sync4D — próximo grande recurso (BruxoSplat)

Confirma como os dois próximos alvos "grandes". Antes de prometer prazo, preciso checar 3 coisas técnicas para cada um (não são coisas que dá pra responder de memória com confiança — vou verificar direito quando começarmos):

- **Lyra 2.0**: tamanho do checkpoint e VRAM mínima (é foto única → vídeo via difusão → 3DGS feed-forward, então tende a ser pesado, no ranking dos modelos maiores que já rodamos); se o repo oficial da NVIDIA já publicou pesos abertos ou só o paper/código; se cabe no seu fluxo atual (pipeline.js escolhe entre modelos, adicionar como 5ª opção segue o mesmo padrão do SHARP/FaceAnything/TripoSplat).
- **Sync4D**: como o motion transfer é aplicado — se opera sobre a malha/rig do asset gerado pelo TripoSplat ou precisa de um formato intermediário; se dá pra reusar o sistema de Rig que já existe no WebEDIT como destino da animação transferida (isso seria elegante: Sync4D gera o movimento, Rig do WebEDIT já sabe tocar keyframes).

Próximo passo real: eu pesquiso os dois repos a fundo (pesos disponíveis, requisitos, formato de saída) e volto com um plano de integração concreto pra cada um, aí você escolhe qual entra primeiro.

### 5.2 Os três "lite" do WebEDIT → caminho pra versão real

| Recurso hoje (lite) | Versão "de verdade" | Viável no navegador? | Esforço |
|---|---|---|---|
| **Seleção por clique + raio** (geométrica) | RT-GS2-style: extrair features por Gaussian (self-supervised, não precisa re-treinar por cena) no lado do BruxoSplat, gravar como canal extra no `.ply`/`.splat`; no WebEDIT, clique agrupa por similaridade de feature em vez de só distância | Sim, mas é **os dois lados** — BruxoSplat gera as features, WebEDIT consome. Não dá pra fazer só no viewer | Alto |
| **Física mass-spring** (1 handle "corpo todo") | MPM real (partículas em grade, transferências P2G/G2P) | Parcialmente — MPM de verdade precisa de compute shaders (WebGPU, não WebGL/Three.js clássico); dá pra checar suporte WebGPU do navegador do usuário primeiro | Muito alto — é um projeto de pesquisa próprio |
| **Filtro CSS** (toon/vintage/neon) | Rede neural de style transfer (tipo "fast neural style" rodando via TensorFlow.js sobre o canvas renderizado, sem precisar retreinar a cena) | **Sim, esse é o mais viável dos três** — modelos de style transfer pré-treinados (ONNX/TFJS) rodam em tempo real sobre a imagem 2D final, não precisam tocar nos Gaussians | Médio |

Ordem de esforço real: **style transfer neural** é o mais barato de entregar de verdade (modelo pré-treinado + canvas, sem mudar o BruxoSplat). **Seleção RT-GS2** é o segundo — mais trabalho, mas trabalho "normal" (extrair features + consumir no viewer), sem depender de suporte de navegador incerto. **MPM real** é o mais caro e o único que esbarra em limitação de plataforma (WebGPU), recomendo tratar como aposta de longo prazo, e por ora evoluir a física atual pra um sistema massa-mola com múltiplos handles conectados (soft-body leve) em vez de só 1 handle — já dá bem mais realismo sem virar um projeto de meses.

Aguardando sua decisão de prioridade entre: (a) formatos de exportação (SPZ/SOG, barato), (b) Lyra 2.0 / Sync4D (pesquisa de integração), (c) style transfer neural real no WebEDIT (o mais viável dos 3 upgrades), (d) seleção RT-GS2, (e) física soft-body melhorada (intermediário, sem virar MPM).

### 5.3 Status (atualizado)

- **✅ Style Transfer Neural real — implementado no WebEDIT** (aba Experimental, seção "🧠 Style Transfer Neural"). Usa Magenta.js `ArbitraryStyleTransferNetwork` (Apache-2.0, Google, roda 100% no navegador via TensorFlow.js, ~12MB). Usuário envia qualquer imagem de estilo; roda em intervalo configurável (200-2000ms, não 60fps — a rede é pesada demais pra todo frame) como overlay semi-transparente sobre o canvas real, com slider de mistura. Diferente do filtro CSS (que continua existindo como opção rápida/leve).
- **🔍 "Rosto 4D com vídeo drive" (reenactment: um vídeo de referência controla um rosto 3D diferente) — pesquisado, viável mas frágil.** Isso é diferente do FaceAnything atual (que reconstrói o rosto DA PRÓPRIA pessoa no vídeo, não controla um separado). Avaliei as opções reais da área:
  - **MonoGaussianAvatar** (SIGGRAPH 2024) — código **MIT** (bem permissivo!), treina a partir de **1 vídeo monocular só** (mesmo tipo de entrada que já usamos no FaceAnything), depois aceita uma sequência de pose/expressão *diferente* pra reencenar — é exatamente o pedido. Mas depende de: **FLAME** (modelo de rosto paramétrico que exige registro manual em flame.is.tue.mpg.de — licença própria não-comercial, não dá pra baixar automaticamente nem embutir no instalador) + **PyTorch3D** (notoriamente difícil de compilar no Windows) + pré-processamento no formato do IMavatar (pipeline próprio, não trivial). GPU de 24GB.
  - **GaussianAvatars** (CVPR 2024, CC BY-NC-SA) — mesma ideia, mas o setup padrão usa captura multi-câmera de estúdio (16 câmeras, dataset NeRSemble), não um vídeo de celular. O tracker que ele usa (VHAP) até suporta monocular como alternativa, mas com qualidade menor que o método foi desenhado pra entregar.
  - **GSGD** ("Gaussian See, Gaussian Do", SIGGRAPH Asia 2025) — código público, mas pede **vídeo multi-câmera** da motion de referência (não um vídeo só), e a licença diz só "for research purposes" (ambíguo, sem CC clara).
  - **Veredito**: dá pra fazer, só que seria a integração mais frágil do app até agora — FLAME exige o usuário criar conta e baixar manualmente (fricção real de UX, sem automação possível), e PyTorch3D quebra com frequência no Windows. Diferente do Lyra 2.0 (bloqueio de licença) e do Sync4D (sem código nenhum), aqui o bloqueio é "dá pra fazer, mas o primeiro uso vai exigir um passo manual do usuário (conta FLAME) e o instalador vai ser instável".
- **❌ Sync4D — sem código público, integração inviável como está.** Fui direto na fonte (arxiv.org/abs/2405.16849, NTU/A*STAR, 2024) e no site oficial (sync4dphys.github.io): o link "Code" da página está vazio (`<>`) e não existe repositório público mais de 2 anos depois da publicação — diferente do Lyra 2.0, aqui não tem nem checkpoint nem script pra baixar. "Integrar" o Sync4D de verdade significaria reimplementar o método inteiro (reconstrução de forma/movimento por blend skinning + campo de velocidade via triplane + simulação MPM diferenciável otimizada por displacement loss) do zero, a partir só do paper — um projeto de pesquisa de meses, não uma integração.
  - **Alternativa real encontrada: Gaussians-to-Life (3DV 2025, Google/TUM)** — código público em [github.com/wimmerth/gaussians2life](https://github.com/wimmerth/gaussians2life), licença **CC BY 4.0** (permite uso comercial, só exige atribuição — mais permissiva que o CC BY-NC do MASt3R/FaceAnything que já usamos). Resolve o mesmo problema (dar vida a um asset/cena 3DGS estática) mas de um jeito até melhor pro nosso caso: **texto** em vez de precisar de um vídeo de referência da mesma categoria de objeto (ex.: "toy bulldozer lifts up its shovel"). Roda em 1 GPU de 24GB, ~10 min de otimização por cena. Contra: usa o framework `threestudio` como base + `tinycudann` compilado na hora (notoriamente difícil de compilar no Windows) + checkpoint do DynamiCrafter (~2GB) — é a integração mais pesada/frágil de todas que já avaliamos, mais complexa que MASt3R/FaceAnything.
  - Existe ainda uma via não-IA: **3DGS Render 5.0** (Kiri Engine, Apache-2.0, plugin de Blender) deixa animar Gaussians a partir de uma malha proxy rigada manualmente, do jeito tradicional de personagem — não é algo pra integrar no BruxoSplat/WebEDIT, mas mostra que o mesmo conceito do nosso sistema de Rig do WebEDIT (LBS por handles) já está na direção certa, só que mais simples.
- **⚠️ Lyra 2.0 — bloqueio de licença encontrado.** O código é Apache-2.0, mas os **pesos do modelo** (`nvidia/Lyra-2.0` no HuggingFace) são liberados sob a *NVIDIA Internal Scientific Research and Development Model License*, que proíbe explicitamente: distribuição, deploy, sublicenciamento, uso em produção, e "gerar trabalhos para venda ou distribuição". Isso é incompatível com embutir o modelo num app gratuito que gera output para os usuários usarem livremente. Some a isso: é baseado no WAN-14B (transformer de vídeo de 14 bilhões de parâmetros), testado oficialmente só em H100/Blackwell/Hopper/Ampere e Linux, com ~9 min para gerar 80 frames de vídeo num H100 80GB (antes ainda da reconstrução em Gaussians) — muito acima do que os outros 4 modelos do BruxoSplat pedem, e fora do alcance de GPUs de consumidor comuns. Decisão em aberto com o usuário: seguir mesmo assim (uso pessoal/pesquisa, sem distribuir os outputs), ou despriorizar até NVIDIA liberar uma licença de produção.
