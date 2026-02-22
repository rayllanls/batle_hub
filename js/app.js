// ========================================
// Fight Stats Hub — ARKDEMIA
// Pure JavaScript, no frameworks
// Google Sheets + Start.gg via /api proxy
// ========================================

// -------------------------------------------------------------
// CONFIGURAÇÃO
// -------------------------------------------------------------
const STARTGG_PROXY = "/api/startgg";

const SPREADSHEET_IDS = {
    sf6: "1sDmKRGTTUhuUhODJ7YmwPuVG9CX4VQmZr8iigeDCdOw",
    "2xko": "1sPqEeBAqnVfFO-8y4W1n4kCi9SXbAst1VCT4Bqa3pfM",
};

const GAME_META = {
    sf6: { title: "SF6", subtitle: "ROAD TO BATTLE COLISEUM", icon: "🔥" },
    "2xko": { title: "2XKO", subtitle: "ROAD TO BATTLE COLISEUM", icon: "⚡" },
};

// Tabela de pontos padrão (usada se BD não carregar)
const DEFAULT_POINTS = [
    { max: 1, pts: 10 },
    { max: 2, pts: 8 },
    { max: 3, pts: 6 },
    { max: 4, pts: 5 },
    { max: 6, pts: 4 },
    { max: 8, pts: 3 },
    { max: 9999, pts: 1 },
];

// ---- State ----
let currentGame = "sf6";
let currentEventId = null;
let eventsCache = {};

// ---- DOM ----
const $ = (id) => document.getElementById(id);

// ---- CSV Parsing ----
function parseCSV(csv) {
    const lines = csv.split("\n").filter((l) => l.trim());
    return lines.map((line) => {
        const result = [];
        let current = "";
        let inQuotes = false;
        for (const char of line) {
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === "," && !inQuotes) {
                result.push(current.trim());
                current = "";
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    });
}

function imgurToDirectUrl(url) {
    if (!url) return "";
    const match = url.match(/imgur\.com\/(\w+)/);
    if (match) return `https://i.imgur.com/${match[1]}.jpg`;
    return url;
}

// ---- Google Sheets ----
async function fetchSheetCSV(spreadsheetId, sheetName) {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const csv = await res.text();
        if (csv.trimStart().startsWith("<!")) return null;
        const rows = parseCSV(csv);
        if (rows.length < 2) return null;
        return rows;
    } catch {
        return null;
    }
}

// ---- Points Table from BD ----
async function fetchPointsTable(spreadsheetId) {
    const rows = await fetchSheetCSV(spreadsheetId, "BD");
    if (!rows || rows.length < 2) return DEFAULT_POINTS;

    const table = [];
    const seen = {};
    for (let i = 1; i < rows.length; i++) {
        const placement = parseInt(rows[i][0]);
        const points = parseInt(rows[i][1]);
        if (placement > 0 && points > 0 && !seen[placement]) {
            table.push({ max: placement, pts: points });
            seen[placement] = true;
        }
    }

    if (table.length === 0) return DEFAULT_POINTS;
    table.sort((a, b) => a.max - b.max);
    table.push({ max: 9999, pts: 1 }); // catch-all
    return table;
}

function getPoints(placement, table) {
    for (const tier of table) {
        if (placement <= tier.max) return tier.pts;
    }
    return 1;
}

// ---- Format Detection ----
function hasHeader(rows, keyword) {
    if (!rows || rows.length < 1) return false;
    return rows[0].some((h) => h.toLowerCase().includes(keyword));
}

function isNewFormat(rows) {
    return hasHeader(rows, "link");
}

function isOldFormat(rows) {
    return hasHeader(rows, "jogador");
}

// ---- Start.gg API ----
function extractSlug(url) {
    const clean = url.replace(/\/(overview|standings|brackets)\/?$/, "");
    const match = clean.match(/start\.gg\/(tournament\/[^\/]+\/event\/[^\/\s?#]+)/);
    return match ? match[1] : null;
}

async function fetchStartGGStandings(slug) {
    try {
        const res = await fetch(`${STARTGG_PROXY}?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) return null;
        const json = await res.json();
        if (json.errors || !json.data?.event) return null;
        return json.data.event;
    } catch {
        return null;
    }
}

// ---- Process ETAPA Tab (new format: Link + Fotos) ----
async function processNewFormat(rows, etapaNum, game, pointsTable) {
    const header = rows[0].map((h) => h.toLowerCase());
    const linkCol = header.findIndex((h) => h.includes("link"));
    const fotosCol = header.findIndex((h) => h.includes("foto"));

    if (linkCol === -1) return null;

    // Pega link do start.gg
    const startggUrl = rows[1]?.[linkCol];
    if (!startggUrl || !startggUrl.includes("start.gg")) return null;

    const slug = extractSlug(startggUrl);
    if (!slug) return null;

    console.log(`[ARKDEMIA] Buscando start.gg: ${slug}`);
    const eventData = await fetchStartGGStandings(slug);
    if (!eventData) return null;

    // Coleta fotos da coluna
    const photos = [];
    if (fotosCol !== -1) {
        for (let i = 1; i < rows.length; i++) {
            const url = imgurToDirectUrl(rows[i]?.[fotosCol] || "");
            if (url) photos.push(url);
        }
    }

    // Monta jogadores
    const players = (eventData.standings?.nodes || [])
        .filter((n) => n.entrant)
        .map((node, idx) => ({
            rank: node.placement,
            name: node.entrant.name,
            points: getPoints(node.placement, pointsTable),
            photoUrl: idx < photos.length ? photos[idx] : "",
        }));

    return {
        id: `${game}-etapa-${etapaNum}`,
        name: `Etapa ${String(etapaNum).padStart(2, "0")}`,
        sheetName: `ETAPA${etapaNum}`,
        startggName: eventData.name,
        players,
    };
}

// ---- Process ETAPA Tab (old format: Jogador + Pontos) ----
function processOldFormat(rows, etapaNum, game) {
    const players = rows
        .slice(1)
        .map((row) => ({
            rank: parseInt(row[0]) || 0,
            name: row[1] || "",
            points: parseInt(row[2]) || 0,
            photoUrl: imgurToDirectUrl(row[4] || ""),
        }))
        .filter((p) => p.name);

    return {
        id: `${game}-etapa-${etapaNum}`,
        name: `Etapa ${String(etapaNum).padStart(2, "0")}`,
        sheetName: `ETAPA${etapaNum}`,
        players,
    };
}

// ---- Fetch All Events ----
async function fetchAllEvents(game) {
    // Session cache
    const cacheKey = `fight-stats-v3-${game}`;
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            const data = JSON.parse(cached);
            if (Date.now() - data.ts < 5 * 60 * 1000) return data.events;
        }
    } catch { }

    const spreadsheetId = SPREADSHEET_IDS[game];

    // Busca tabela de pontos do BD
    const pointsTable = await fetchPointsTable(spreadsheetId);
    console.log(`[ARKDEMIA] Pontos carregados para ${game}: ${pointsTable.length} faixas`);

    const events = [];
    let num = 1;
    let consecutiveInvalid = 0;

    while (num <= 50 && consecutiveInvalid < 2) {
        const rows = await fetchSheetCSV(spreadsheetId, `ETAPA${num}`);

        if (!rows) {
            // Aba não existe → parar
            break;
        }

        let event = null;

        if (isNewFormat(rows)) {
            // Novo formato: Link → busca do start.gg
            event = await processNewFormat(rows, num, game, pointsTable);
        } else if (isOldFormat(rows)) {
            // Formato antigo: Jogador + Pontos manual
            event = processOldFormat(rows, num, game);
        }

        if (event && event.players.length > 0) {
            events.push(event);
            consecutiveInvalid = 0;
            console.log(`[ARKDEMIA] ETAPA${num}: ${event.players.length} jogadores`);
        } else {
            consecutiveInvalid++;
            console.log(`[ARKDEMIA] ETAPA${num}: formato não reconhecido ou vazio, pulando...`);
        }

        num++;
    }

    console.log(`[ARKDEMIA] ${game.toUpperCase()}: ${events.length} etapa(s) carregadas`);

    try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ events, ts: Date.now() }));
    } catch { }

    return events;
}

// ---- Ranking Calculation ----
function calculateRanking(events, eventId) {
    const relevant = eventId ? events.filter((e) => e.id === eventId) : events;
    const map = {};

    for (const event of relevant) {
        for (const p of event.players) {
            map[p.name] = (map[p.name] || 0) + p.points;
        }
    }

    const sorted = Object.entries(map)
        .map(([name, totalPoints]) => ({ name, totalPoints, rank: 0 }))
        .sort((a, b) => b.totalPoints - a.totalPoints);

    let currentRank = 1;
    for (let i = 0; i < sorted.length; i++) {
        if (i > 0 && sorted[i].totalPoints < sorted[i - 1].totalPoints) {
            currentRank = i + 1;
        }
        sorted[i].rank = currentRank;
    }

    return sorted;
}

// ---- Render Functions ----

function renderGameSelector() {
    $("btn-2xko").classList.toggle("active", currentGame === "2xko");
    $("btn-sf6").classList.toggle("active", currentGame === "sf6");
    document.body.setAttribute("data-game", currentGame);
}

function renderHeader(events) {
    const meta = GAME_META[currentGame];
    $("title-game").textContent = meta.title;
    $("subtitle").textContent = meta.subtitle;
}

function renderEventTabs(events) {
    const nav = $("event-tabs");
    nav.innerHTML = "";

    const geralBtn = document.createElement("button");
    geralBtn.className = `tab-btn${currentEventId === null ? " active" : ""}`;
    geralBtn.textContent = "Geral";
    geralBtn.addEventListener("click", () => selectEvent(null));
    nav.appendChild(geralBtn);

    events.forEach((event) => {
        const btn = document.createElement("button");
        btn.className = `tab-btn${currentEventId === event.id ? " active" : ""}`;
        btn.textContent = event.name;
        btn.addEventListener("click", () => selectEvent(event.id));
        nav.appendChild(btn);
    });
}

function getPlayerEtapaBreakdown(playerName, events) {
    return events.map((event) => {
        const player = event.players.find((p) => p.name === playerName);
        return {
            etapa: event.name,
            points: player ? player.points : 0,
        };
    });
}

function renderLeaderboard(ranking, events, limit = 10) {
    const container = $("leaderboard");
    container.innerHTML = "";

    const isGeral = !currentEventId;
    $("points-label").textContent = isGeral ? "Pontuação" : "Pontos";

    const displayRanking = limit ? ranking.slice(0, limit) : ranking;

    displayRanking.forEach((player) => {
        const wrapper = document.createElement("div");
        wrapper.className = "lb-wrapper";

        const row = document.createElement("div");
        row.className = `lb-row${player.rank <= 3 ? ` rank-${player.rank}` : ""}`;

        const rankClass =
            player.rank === 1 ? "r1" : player.rank === 2 ? "r2" : player.rank === 3 ? "r3" : "r-default";

        row.innerHTML = `
      <div class="lb-left">
        <span class="rank-badge ${rankClass}">${player.rank}º</span>
        <span class="player-name">${escapeHtml(player.name)}</span>
        ${isGeral ? '<span class="expand-arrow">▼</span>' : ''}
      </div>
      <div class="lb-right">
        <span class="points-value">${player.totalPoints}</span>
        <span class="points-unit">pts</span>
      </div>
    `;

        wrapper.appendChild(row);

        if (isGeral && events && events.length > 0) {
            const detail = document.createElement("div");
            detail.className = "player-detail";

            const breakdown = getPlayerEtapaBreakdown(player.name, events);
            const total = breakdown.reduce((s, b) => s + b.points, 0);

            let tableRows = breakdown
                .filter((b) => b.points > 0)
                .map((b) => `<tr><td>${escapeHtml(b.etapa)}</td><td>${b.points} pts</td></tr>`)
                .join("");

            detail.innerHTML = `
        <div class="detail-table">
          <table>
            <thead><tr><th>Etapa</th><th>Pontos</th></tr></thead>
            <tbody>
              ${tableRows}
              <tr class="detail-total"><td>Total</td><td>${total} pts</td></tr>
            </tbody>
          </table>
        </div>
      `;

            wrapper.appendChild(detail);

            row.addEventListener("click", () => {
                const isOpen = detail.classList.contains("open");
                container.querySelectorAll(".player-detail.open").forEach((d) => {
                    d.classList.remove("open");
                    d.previousElementSibling.classList.remove("expanded");
                });
                if (!isOpen) {
                    detail.classList.add("open");
                    row.classList.add("expanded");
                }
            });
        }

        container.appendChild(wrapper);
    });

    if (ranking.length > 10) {
        const btnWrapper = document.createElement("div");
        btnWrapper.className = "load-more-wrapper";
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "load-more-btn";

        if (limit) {
            toggleBtn.textContent = "Ver Todos os Jogadores";
            toggleBtn.addEventListener("click", () => renderLeaderboard(ranking, events, null));
        } else {
            toggleBtn.textContent = "Mostrar menos";
            toggleBtn.addEventListener("click", () => renderLeaderboard(ranking, events, 10));
        }

        btnWrapper.appendChild(toggleBtn);
        container.appendChild(btnWrapper);
    }

    $("leaderboard-section").style.display = "block";
}

function renderPhotoGallery(events, limit = 8) {
    const gallery = $("photo-gallery");
    const grid = $("gallery-grid");

    if (!currentEventId) {
        let allPhotos = [];
        events.forEach(event => {
            const photosPlayers = event.players.filter(p => p.photoUrl);
            photosPlayers.forEach(player => {
                allPhotos.push(player);
            });
        });

        if (allPhotos.length === 0) {
            gallery.style.display = "none";
            return;
        }

        $("gallery-title-text").textContent = "Fotos - Geral";
        grid.innerHTML = "";

        const displayPhotos = limit ? allPhotos.slice(0, limit) : allPhotos;

        displayPhotos.forEach((player) => {
            const card = document.createElement("button");
            card.className = "gallery-card";
            card.innerHTML = `
          <img src="${player.photoUrl}" alt="Foto de ${escapeHtml(player.name)}" loading="lazy" />
        `;
            card.addEventListener("click", () => openLightbox(player.photoUrl));
            grid.appendChild(card);
        });

        const existingWrap = gallery.querySelector('.load-more-wrapper');
        if (existingWrap) existingWrap.remove();

        if (allPhotos.length > 8) {
            const btnWrapper = document.createElement("div");
            btnWrapper.className = "load-more-wrapper";
            const toggleBtn = document.createElement("button");
            toggleBtn.className = "load-more-btn";

            if (limit) {
                toggleBtn.textContent = "Ver Todas as Fotos";
                toggleBtn.addEventListener("click", () => renderPhotoGallery(events, null));
            } else {
                toggleBtn.textContent = "Mostrar menos";
                toggleBtn.addEventListener("click", () => renderPhotoGallery(events, 8));
            }

            btnWrapper.appendChild(toggleBtn);
            grid.parentElement.appendChild(btnWrapper);
        }

        gallery.style.display = "block";
        return;
    }

    const event = events.find((e) => e.id === currentEventId);
    if (!event) {
        gallery.style.display = "none";
        return;
    }

    const photosPlayers = event.players.filter((p) => p.photoUrl);
    if (photosPlayers.length === 0) {
        gallery.style.display = "none";
        return;
    }

    $("gallery-title-text").textContent = `Fotos da ${event.sheetName}`;
    grid.innerHTML = "";

    const displayPhotos = limit ? photosPlayers.slice(0, limit) : photosPlayers;

    displayPhotos.forEach((player) => {
        const card = document.createElement("button");
        card.className = "gallery-card";
        card.innerHTML = `
      <img src="${player.photoUrl}" alt="Foto de ${escapeHtml(player.name)}" loading="lazy" />
    `;
        card.addEventListener("click", () => openLightbox(player.photoUrl));
        grid.appendChild(card);
    });

    const existingWrap = gallery.querySelector('.load-more-wrapper');
    if (existingWrap) existingWrap.remove();

    if (photosPlayers.length > 8) {
        const btnWrapper = document.createElement("div");
        btnWrapper.className = "load-more-wrapper";
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "load-more-btn";

        if (limit) {
            toggleBtn.textContent = "Ver Todas as Fotos";
            toggleBtn.addEventListener("click", () => renderPhotoGallery(events, null));
        } else {
            toggleBtn.textContent = "Mostrar menos";
            toggleBtn.addEventListener("click", () => renderPhotoGallery(events, 8));
        }

        btnWrapper.appendChild(toggleBtn);
        grid.parentElement.appendChild(btnWrapper);
    }

    gallery.style.display = "block";
}

function renderStatsFooter(events) {
    if (currentEventId) {
        $("stats-footer").style.display = "none";
        return;
    }

    const ranking = calculateRanking(events, null);
    const leaders = ranking.filter((p) => p.rank === 1).map((p) => p.name);
    const leadersText =
        leaders.length > 2 ? `${leaders[0]} & +${leaders.length - 1}` : leaders.join(" & ");

    $("leader-label").textContent = leaders.length > 1 ? "Co-Líderes" : "Líder";
    $("stat-leader").textContent = leadersText || "--";
    $("stat-etapas").textContent = `${events.length} CONCLUÍDAS`;

    $("stats-footer").style.display = "grid";
}

// ---- Lightbox ----
function openLightbox(url) {
    $("lightbox-img").src = url;
    $("lightbox").style.display = "flex";
}

function closeLightbox() {
    $("lightbox").style.display = "none";
    $("lightbox-img").src = "";
}

// ---- Utility ----
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ---- Main Flow ----

async function loadAndRender() {
    $("loading").style.display = "flex";
    $("error").style.display = "none";
    $("leaderboard-section").style.display = "none";
    $("photo-gallery").style.display = "none";
    $("stats-footer").style.display = "none";

    renderGameSelector();

    try {
        if (!eventsCache[currentGame]) {
            eventsCache[currentGame] = await fetchAllEvents(currentGame);
        }

        const events = eventsCache[currentGame];

        $("loading").style.display = "none";

        renderHeader(events);
        renderEventTabs(events);

        const ranking = calculateRanking(events, currentEventId);
        renderLeaderboard(ranking, events);
        renderPhotoGallery(events);
        renderStatsFooter(events);
    } catch (err) {
        console.error(err);
        $("loading").style.display = "none";
        $("error").style.display = "block";
    }
}

function selectGame(game) {
    currentGame = game;
    currentEventId = null;
    loadAndRender();
}

function selectEvent(eventId) {
    currentEventId = eventId;
    const events = eventsCache[currentGame] || [];
    renderEventTabs(events);
    const ranking = calculateRanking(events, currentEventId);
    renderLeaderboard(ranking, events);
    renderPhotoGallery(events);
    renderStatsFooter(events);
}

// ---- Event Listeners ----
document.addEventListener("DOMContentLoaded", () => {
    $("btn-2xko").addEventListener("click", () => selectGame("2xko"));
    $("btn-sf6").addEventListener("click", () => selectGame("sf6"));

    $("lightbox").addEventListener("click", closeLightbox);
    $("lightbox-close").addEventListener("click", closeLightbox);
    $("lightbox-img").addEventListener("click", (e) => e.stopPropagation());

    loadAndRender();
});
