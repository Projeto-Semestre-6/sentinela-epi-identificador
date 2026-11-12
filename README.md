# Sentinela · Inspeção Visual de EPIs

Aplicação web para identificar Equipamentos de Proteção Individual (EPIs) em imagens, usando um modelo YOLOv8 treinado localmente (`best.pt`). Todo o processamento é local: nenhuma imagem sai da sua máquina.

Dois serviços:

- **backend/**: API FastAPI que carrega o modelo e devolve detecções, imagem anotada e conformidade.
- **frontend/**: interface estática (HTML/CSS/JS puro) servida pelo nginx, que também faz proxy de `/api/` para o backend.

## Estrutura

```
epi-identifier/
├── best.pt                 # modelo YOLOv8 treinado
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── main.py             # FastAPI + Ultralytics
│   └── requirements.txt
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    ├── index.html
    ├── css/styles.css
    └── js/app.js
```

## Como executar (Docker)

Requer Docker Desktop com BuildKit (padrão nas versões atuais).

```
docker compose up --build
```

- Interface: <http://localhost:8080>
- API: <http://localhost:8000> (docs interativos em <http://localhost:8000/docs>)

O frontend só sobe depois que o backend passa no healthcheck (`/api/health`). Na primeira execução o carregamento do modelo pode levar alguns minutos, e o healthcheck aguarda até 180 s antes de contar falhas.

Para reconstruir só um serviço: `docker compose up --build frontend` (ou `backend`).

### Sobre a imagem do backend

- Usa PyTorch **somente CPU**, instalado num venv (`/opt/venv`) antes das demais dependências. Isso evita que o `pip` baixe o torch com CUDA (vários GB).
- O cache do `pip` é mantido entre builds (BuildKit), e o bytecode é pré-compilado para acelerar o start.
- Versões do torch fixadas em `torch==2.5.1` e `torchvision==0.20.1`. As demais dependências ainda usam `>=` em `backend/requirements.txt`.
- Se mudar o frontend e a tela não atualizar, recarregue sem cache (Ctrl+Shift+R). O nginx revalida `css` e `js` a cada acesso.

## Estados e cores

O modelo detecta cada EPI tanto presente quanto ausente. As cores são fixas:

| Cor | Estado | Origem |
|---|---|---|
| Azul | **Identificado** | classes presentes: `helmet`, `vest`, `gloves`, `goggles`, `boots` |
| Vermelho | **Ausência** | classes `no-*`: `no-helmet`, `no-vest`, `no-gloves`, `no-goggles`, `no-boots` |
| Cinza | **Indeterminado** | EPI do checklist que o modelo não classificou como presente nem ausente |

Azul e vermelho aparecem nas caixas da imagem anotada. O cinza aparece só no checklist, porque não há caixa para o que não foi detectado. Se o mesmo EPI aparecer como presente e ausente, vale a detecção de maior confiança.

## API

- `GET /api/health`: status e lista de classes carregadas.
- `GET /api/classes`: classes do modelo, com `category` (item do checklist) e `state` (`present` ou `absent`).
- `POST /api/analyze?confidence=0.35`: envia uma imagem (campo `file`, até 10 MB) e recebe:
  - `detections`: `label`, `category`, `state`, `confidence`, `box`;
  - `annotated_image`: JPEG em base64 com as caixas coloridas;
  - `summary`: contagem por classe;
  - `compliance`: `score`, `status`, `detected`, `missing`, `required` e `items` (estado de cada EPI: `present`, `absent` ou `unknown`);
  - `processing_time_ms`, `average_confidence`, `image_size`.

### Conformidade

Os EPIs verificados são: capacete, óculos, luvas, máscara, bota, colete e protetor auricular. O `score` é a porcentagem desses itens identificados como presentes. O `status` pode ser:

- `conforme`: todos os itens presentes;
- `parcial`: pelo menos um presente, mas não todos;
- `nao_conforme`: nenhum presente, com alguma detecção;
- `nenhum_epi`: nenhuma detecção.

Para ajustar a lista, edite `REQUIRED_EPIS` em `backend/main.py`. Cada item tem sinônimos em português e inglês, usados para casar com o nome das classes do modelo. Prefixos `no-`, `sem-` e `without-` marcam ausência.

## Frontend

- Envio por arraste, clique ou **Ctrl+V**; análise com **Ctrl+Enter**; **Esc** limpa.
- Slider de limiar de confiança (10% a 90%).
- Painel "Resultado" com o mesmo tamanho do painel de envio: imagem anotada e, abaixo, status, pontuação, checklist e detecções.
- Download da imagem anotada.
- Histórico da sessão no `localStorage` (até 12 análises).
- Tema claro/escuro.

## Observações

- O backend permite CORS de qualquer origem (`ALLOWED_ORIGINS: "*"` no `docker-compose.yml`). Restrinja em produção.
- Para expor o backend em outro host, ajuste `API_BASE` no topo de `frontend/js/app.js` ou defina `window.__API_BASE__` antes do script.
- Manter o projeto fora de pastas sincronizadas pelo OneDrive deixa o build e o I/O do Docker mais rápidos.
