# Changelog

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
