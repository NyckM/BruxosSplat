# Câmera virtual — formato de exportação

O BruxoSplat exporta o trajeto de câmera calculado no alinhamento como um arquivo JSON, para
que você possa reproduzir o mesmo movimento em qualquer engine (three.js, Babylon, WebGL puro,
Blender, Unreal…).

## Onde o arquivo aparece

| Momento | Arquivo |
|---|---|
| Durante o alinhamento | `camera_path.json`, dentro da pasta `proj_...` do projeto |
| Ao terminar o treino | `NomeDoSplat.camera.json`, ao lado do `.ply` exportado |
| Ao salvar uma edição | o sidecar é regravado **com a transformação do gizmo já aplicada** |

Funciona com todos os métodos que produzem poses: COLMAP, DPVO, MASt3R e MegaSam.

---

## Estrutura

```jsonc
{
  "schema": "bruxos-camera-path/v1",
  "generator": "BruxoSplat",
  "alignmentMethod": "colmap",
  "sourceFps": 2,
  "coordinateSystem": "COLMAP world coordinates (Y down, Z forward) ...",
  "conventions": { /* descrição de cada campo */ },
  "cameras": {
    "1": { "model": "OPENCV", "width": 1600, "height": 900, "params": [fx, fy, cx, cy, ...] }
  },
  "frames": [
    {
      "index": 0,
      "image": "v1_00001.jpg",
      "cameraId": 1,
      "position": [x, y, z],
      "forward":  [x, y, z],
      "up":       [x, y, z],
      "quaternionWorldToCamera":  [w, x, y, z],
      "translationWorldToCamera": [x, y, z]
    }
  ]
}
```

### O que cada campo significa

| Campo | Significado |
|---|---|
| `position` | Centro da câmera no mundo: `C = -Rᵀ·t` |
| `forward` | Eixo **+Z** da câmera no mundo — no COLMAP a câmera olha para **+Z**, não para −Z |
| `up` | Vertical da câmera no mundo (é o **−Y** da câmera, porque no COLMAP o Y aponta para baixo) |
| `quaternionWorldToCamera` | `[w, x, y, z]`, rotação mundo → câmera |
| `translationWorldToCamera` | `t` do COLMAP, onde `p_câmera = R·p_mundo + t` |
| `cameras[id].params` | Intrínsecas: `fx, fy, cx, cy` e distorção, conforme o modelo |

---

## ⚠️ A conversão de coordenadas (a parte que mais dá errado)

O COLMAP usa **Y para baixo e Z para frente**. Engines como three.js usam **Y para cima**.

A conversão correta é uma **rotação de 180° em torno do eixo X**:

```
(x, y, z)  →  (x, −y, −z)
```

**Negar apenas o Y é o erro clássico.** Isso não é uma rotação, é um **espelhamento**: inverte a
lateralidade da cena. O resultado é uma câmera que aponta para o lado errado e não fica sobre o
trajeto desenhado. Esse bug existiu no próprio visualizador do BruxoSplat até a v1.3.0 — vale o
aviso.

**Aplique a mesma rotação na nuvem de pontos e na câmera.** Se você rotacionar só um dos dois,
eles não vão coincidir.

### ⚠️ Exceção importante: visualizadores já configurados em Y-para-baixo

A rotação acima vale para engines **Y-para-cima** (three.js com o padrão, Babylon, Blender).

Se o seu visualizador já foi configurado para trabalhar em coordenadas COLMAP, **não converta
nada** — use as poses exatamente como estão no arquivo. É o caso do **3dGS_WebEDIT**, que cria o
viewer com:

```js
new GaussianSplats3D.Viewer({ cameraUp: [0, -1, 0], ... })
```

Ou seja, ele já vive em Y-para-baixo. Aplicar a rotação de 180° ali deixaria a câmera errada —
exatamente o oposto do problema.

**Como saber em qual caso você está:** carregue o `.ply` do splat e veja se a cena aparece de
cabeça para baixo. Se aparecer invertida, seu engine é Y-para-cima e você precisa da rotação (nos
dois: splat e câmera). Se aparecer na orientação certa sem fazer nada, seu viewer já está em
coordenadas COLMAP e as poses entram cruas.

### Exemplo em three.js

```js
const dados = await (await fetch('MeuSplat.camera.json')).json();

// 1) O mesmo flip para os Gaussians e para a câmera:
//    coloque ambos dentro de um grupo com rotation.x = π,
//    ou converta os vetores manualmente com a função abaixo.
const paraYUp = ([x, y, z]) => new THREE.Vector3(x, -y, -z);

// 2) Reproduzindo um frame
function irParaFrame(i) {
  const f = dados.frames[i];
  const pos = paraYUp(f.position);
  const dir = paraYUp(f.forward);
  const up  = paraYUp(f.up);

  camera.position.copy(pos);
  camera.up.copy(up);
  camera.lookAt(pos.clone().add(dir));   // olha na direção +Z da câmera original
}

// 3) Campo de visão a partir das intrínsecas (opcional, mas deixa o
//    enquadramento idêntico ao do vídeo original)
const cam = dados.cameras[dados.frames[0].cameraId];
if (cam) {
  const [fx] = cam.params;
  camera.fov = 2 * Math.atan(cam.height / (2 * fx)) * 180 / Math.PI;
  camera.aspect = cam.width / cam.height;
  camera.updateProjectionMatrix();
}
```

Para interpolar entre frames, faça `lerp` das posições e das direções **já convertidas**, e
normalize a direção depois — foi assim que o visualizador do app passou a funcionar.

---

## Escala: como o arquivo continua batendo com o PLY

O editor do BruxoSplat permite mover, girar e escalar os Gaussians com o gizmo. Ao salvar, essa
transformação é **gravada dentro do PLY** (as posições dos pontos mudam de verdade).

A partir da v1.3.0, **a mesma transformação é aplicada ao trajeto de câmera** antes de gravar o
sidecar. Antes disso o arquivo era apenas copiado, então PLY e câmera saíam desalinhados sempre
que o gizmo era usado.

Quando há transformação, o JSON ganha um bloco extra, apenas informativo:

```jsonc
"editorTransform": {
  "scale": 2.5,
  "quaternion": [w, x, y, z],
  "translation": [x, y, z],
  "note": "Transformação do gizmo já aplicada nestas poses — elas casam com o PLY exportado."
}
```

Você **não precisa** aplicar nada disso: as poses no arquivo já estão prontas. O bloco existe só
para você conseguir rastrear o que aconteceu.

Como a escala é uniforme, as **intrínsecas não mudam** — `fx`, `fy`, `cx` e `cy` continuam válidas
independentemente do quanto a cena foi escalada.

---

## Escala absoluta (metros)

Vale ser claro sobre uma limitação: reconstrução a partir de vídeo monocular **não recupera a
escala real do mundo**. O COLMAP, o DPVO e o MASt3R produzem uma cena consistente, mas com escala
arbitrária — não há como saber se o objeto tem 10 cm ou 10 m só pelas imagens.

O que o arquivo garante é **coerência interna**: a câmera, a nuvem de pontos e os Gaussians estão
todos na mesma escala. Se você precisa de medidas reais, é necessário um elemento de referência de
tamanho conhecido na cena e um fator de escala aplicado por fora.
