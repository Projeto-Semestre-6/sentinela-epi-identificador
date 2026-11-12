# Sentinela · Inspeção Visual de EPIs

Aplicação web para identificação de Equipamentos de Proteção Individual (EPIs) em imagens, usando um modelo YOLOv8 treinado localmente (`best.pt`).

Dividida em dois serviços:

- **backend/** — API em FastAPI que carrega o modelo e devolve as detecções.
- **frontend/** — Interface estática (HTML/CSS/JS puro) com upload, preview, laudo e histórico de sessão.

## Estrutura

```
epi-identifier/
├── best.pt                 # modelo YOLOv8 treinado
├── backend/
│   ├── main.py             # FastAPI + Ultralytics
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── css/styles.css
│   └── js/app.js
├── start-backend.bat       # Windows
├── start-frontend.bat      # Windows
├── start-backend.sh        # Linux/macOS
└── start-frontend.sh       # Linux/macOS
```

## Como executar (Windows)

Abra dois terminais na raiz do projeto:

**Terminal 1 — backend**
```
start-backend.bat
```
Na primeira execução, o script cria um ambiente virtual em `backend/.venv` e instala as dependências (pode levar alguns minutos). Em seguida sobe em <http://localhost:8000>.

**Terminal 2 — frontend**
```
start-frontend.bat
```
Serve a interface em <http://localhost:5173>. Abra o endereço no navegador.

## Como executar (Linux/macOS)

```
chmod +x start-backend.sh start-frontend.sh
./start-backend.sh      # terminal 1
./start-frontend.sh     # terminal 2
```

## API

- `GET /api/health` — status e lista de classes carregadas.
- `GET /api/classes` — classes do modelo com categoria mapeada para EPIs comuns.
- `POST /api/analyze` — envia uma imagem (campo `file`) e recebe:
  - detecções com `label`, `confidence`, `box`;
  - imagem anotada em base64;
  - resumo por classe;
  - score de conformidade e checklist de EPIs essenciais.
- Docs interativos em <http://localhost:8000/docs>.

## Funcionalidades do frontend

- Drag & drop, clique ou **Ctrl+V** (colar da área de transferência).
- Slider de limiar de confiança (10% – 90%).
- Imagem anotada com bounding boxes e porcentagem.
- Score de conformidade em gauge animado.
- Checklist de EPIs essenciais (capacete, óculos, luvas, máscara, bota, colete, protetor auricular).
- Lista de detecções ordenada por confiança, com barras coloridas.
- Download da imagem anotada.
- Histórico da sessão em `localStorage` (até 12 análises).
- Tema claro/escuro.
- Atalho **Ctrl+Enter** para disparar a análise.

## Mapeamento de EPIs

O backend tenta casar o nome de cada classe do modelo com uma das categorias abaixo (por sinônimos, PT/EN):

```
capacete · oculos · luvas · mascara · bota · colete · protetor_auricular
```

Edite `REQUIRED_EPIS` em `backend/main.py` para ajustar à sua lista.

## Observações

- Nenhuma imagem sai da máquina — todo o processamento é local.
- Se precisar expor o backend em outro host, ajuste `API_BASE` no topo de `frontend/js/app.js` ou defina `window.__API_BASE__` antes do script.
- O backend permite CORS de qualquer origem (`*`) por padrão; restrinja em produção.
