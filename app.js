const STORAGE_KEY = "nearby-fuel-map-local-v4";

const DEFAULT_VIEW = {
  lat: 0,
  lng: 0,
  zoom: 2,
};

const GRADE_LABELS = {
  regular: "レギュラー",
  premium: "ハイオク",
  diesel: "軽油",
};
const PRICE_GRADES = ["regular", "premium", "diesel"];
const NEAR_CHEAP_DELTA = 3;

const state = {
  home: null,
  radius: 2000,
  grade: "regular",
  sort: "price",
  priceMode: "demo",
  importedFeed: null,
  importedMaps: null,
  selectedDateIndex: 13,
  stations: [],
  selectedStationId: null,
  cheapestStationId: null,
  nearCheapStationId: null,
  hasRequestedLocation: false,
  priceSeed: defaultPriceSeed(),
  priceSeedLoaded: false,
};

const el = {};
let map;
let homeMarker;
let baseLayer;
let baseLayerType = "";
let tileFallbackArmed = false;
let rangeCircle;
let stationLayer;
let stationMarkers = new Map();

const days = makeDateRange(14);

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  restoreState();
  await loadDailyPriceSeed();
  hydrateControls();
  setupMap();
  bindEvents();
  renderDateControl();
  if (state.home) {
    refreshStations();
  } else {
    renderAll();
    setStatus("現在地を許可すると近くの価格を表示します");
    locateUser({ auto: true });
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
});

function cacheElements() {
  [
    "addressInput",
    "latInput",
    "lngInput",
    "locateButton",
    "demoButton",
    "refreshButton",
    "radiusInput",
    "gradeInput",
    "sortInput",
    "priceModeInput",
    "priceFile",
    "templateButton",
    "avgMetric",
    "lowMetric",
    "nearCheapMetric",
    "cheapestButton",
    "nearCheapButton",
    "cheapestName",
    "cheapestMeta",
    "nearCheapName",
    "nearCheapMeta",
    "cheapestGoogleLink",
    "cheapestAppleLink",
    "nearCheapGoogleLink",
    "nearCheapAppleLink",
    "stationCount",
    "stationList",
    "statusPill",
    "dateRange",
    "dateLabel",
    "sourceBadge",
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.home && validCoords(saved.home.lat, saved.home.lng)) {
      state.home = {
        label: saved.home.label || "自宅",
        lat: Number(saved.home.lat),
        lng: Number(saved.home.lng),
      };
    }
    if (saved.radius) state.radius = Number(saved.radius);
    if (saved.grade && GRADE_LABELS[saved.grade]) state.grade = saved.grade;
    if (saved.sort) state.sort = saved.sort;
  } catch {
    state.home = null;
  }

  const params = new URLSearchParams(window.location.search);
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  if (validCoords(lat, lng)) {
    state.home = {
      label: params.get("label") || "現在地",
      lat,
      lng,
    };
  }
}

function saveState() {
  if (!state.home) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        home: state.home,
        radius: state.radius,
        grade: state.grade,
        sort: state.sort,
      }),
    );
  } catch {
    // Local storage can be unavailable in strict browser privacy modes.
  }
}

function hydrateControls() {
  el.addressInput.value = state.home?.label || "";
  el.latInput.value = state.home ? state.home.lat.toFixed(6) : "";
  el.lngInput.value = state.home ? state.home.lng.toFixed(6) : "";
  el.radiusInput.value = String(state.radius);
  el.gradeInput.value = state.grade;
  el.sortInput.value = state.sort;
  el.priceModeInput.value = state.priceMode;
  el.dateRange.max = String(days.length - 1);
  el.dateRange.value = String(state.selectedDateIndex);
}

async function loadDailyPriceSeed() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`./data/daily-price-seed.json?v=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`price seed ${response.status}`);
    state.priceSeed = normalizeDailyPriceSeed(await response.json());
    state.priceSeedLoaded = true;
  } catch {
    state.priceSeed = defaultPriceSeed();
    state.priceSeedLoaded = false;
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeDailyPriceSeed(feed) {
  const fallback = defaultPriceSeed();
  const baselines = feed?.baselines || {};
  const updated =
    typeof feed?.updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(feed.updated)
      ? feed.updated
      : fallback.updated;

  return {
    updated,
    currency: "JPY",
    unit: "L",
    source: "daily-estimate",
    salt: String(feed?.salt || `${updated}-daily`),
    baselines: {
      regular: numericPrice(baselines.regular) ?? fallback.baselines.regular,
      premium: numericPrice(baselines.premium) ?? fallback.baselines.premium,
      diesel: numericPrice(baselines.diesel) ?? fallback.baselines.diesel,
    },
  };
}

function defaultPriceSeed() {
  const updated = toIsoDate(new Date());
  const seed = hashString(updated);
  const regular = 166 + (seed % 9);
  return {
    updated,
    currency: "JPY",
    unit: "L",
    source: "local-estimate",
    salt: `${updated}-${seed}`,
    baselines: {
      regular,
      premium: regular + 13,
      diesel: regular - 17,
    },
  };
}

function bindEvents() {
  el.locateButton.addEventListener("click", locateUser);
  el.demoButton.addEventListener("click", locateUser);

  el.refreshButton.addEventListener("click", () => {
    if (readControls()) refreshStations();
  });

  ["latInput", "lngInput", "radiusInput"].forEach((id) => {
    el[id].addEventListener("change", () => {
      if (readControls()) refreshStations();
    });
  });

  el.addressInput.addEventListener("change", () => {
    if (!state.home) return;
    if (readControls()) {
      saveState();
      updateHomeMarker();
    }
  });

  el.gradeInput.addEventListener("change", () => {
    state.grade = el.gradeInput.value;
    saveState();
    renderAll();
  });

  el.sortInput.addEventListener("change", () => {
    state.sort = el.sortInput.value;
    saveState();
    renderList();
  });

  el.priceModeInput.addEventListener("change", () => {
    state.priceMode = el.priceModeInput.value;
    renderAll();
  });

  el.dateRange.addEventListener("input", () => {
    state.selectedDateIndex = Number(el.dateRange.value);
    renderAll();
  });

  el.priceFile.addEventListener("change", handlePriceFile);
  el.templateButton.addEventListener("click", downloadTemplate);
  el.cheapestButton.addEventListener("click", () => {
    const stationId = el.cheapestButton.dataset.stationId || state.cheapestStationId;
    if (stationId) selectStation(stationId, true);
  });
  el.nearCheapButton.addEventListener("click", () => {
    const stationId = el.nearCheapButton.dataset.stationId || state.nearCheapStationId;
    if (stationId) selectStation(stationId, true);
  });

  el.stationList.addEventListener("click", (event) => {
    const locateAction = event.target.closest("[data-action='locate']");
    if (locateAction) {
      locateUser();
      return;
    }

    if (event.target.closest("a")) return;
    const card = event.target.closest(".station-card");
    if (!card) return;
    selectStation(card.dataset.stationId, true);
  });
}

function readControls() {
  const lat = Number(el.latInput.value);
  const lng = Number(el.lngInput.value);
  if (!validCoords(lat, lng)) {
    setStatus("有効な緯度と経度が必要です");
    return false;
  }

  state.home = {
    label: el.addressInput.value.trim() || "自宅",
    lat,
    lng,
  };
  state.radius = Number(el.radiusInput.value);
  state.grade = el.gradeInput.value;
  state.sort = el.sortInput.value;
  state.priceMode = el.priceModeInput.value;
  saveState();
  return true;
}

function setupMap() {
  map = L.map("map", {
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false,
    zoomControl: false,
    preferCanvas: true,
    updateWhenIdle: true,
    wheelDebounceTime: 60,
    attributionControl: false,
  }).setView(
    [state.home?.lat ?? DEFAULT_VIEW.lat, state.home?.lng ?? DEFAULT_VIEW.lng],
    state.home ? 13 : DEFAULT_VIEW.zoom,
  );

  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.control.scale({ imperial: false, metric: true, position: "bottomleft" }).addTo(map);
  updateBaseLayer();

  stationLayer = L.layerGroup().addTo(map);
  updateHomeMarker();
  setTimeout(() => map.invalidateSize(), 120);
}

async function locateUser(options = {}) {
  if (!navigator.geolocation) {
    setStatus("このブラウザでは現在地を取得できません");
    return;
  }

  state.hasRequestedLocation = true;
  setStatus("現在地を取得しています...");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const accuracy = Number(position.coords.accuracy);
      if (Number.isFinite(accuracy) && accuracy > 10000) {
        state.stations = [];
        renderAll();
        setStatus("現在地の精度が低すぎます。スマホのGPSを許可してください");
        return;
      }

      state.home = {
        label: el.addressInput.value.trim() || "現在地",
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      hydrateControls();
      saveState();
      refreshStations();
    },
    () => {
      state.stations = [];
      renderAll();
      setStatus(
        options.auto
          ? "現在地の許可が必要です。現在地ボタンを押してください"
          : "現在地を取得できませんでした",
      );
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

async function refreshStations() {
  if (!state.home || !validCoords(state.home.lat, state.home.lng)) {
    state.stations = [];
    state.selectedStationId = null;
    stationMarkers.forEach((marker) => marker.remove());
    stationMarkers.clear();
    renderAll();
    setStatus("現在地を設定してください");
    return;
  }

  state.selectedStationId = null;
  setStatus("安定モードで表示中");
  updateHomeMarker();
  updateBaseLayer();
  map.setView([state.home.lat, state.home.lng], radiusToZoom(state.radius), { animate: false });
  state.stations = makeFallbackStations(state.home, state.radius);
  renderAll();
}

function makeFallbackStations(home, radius = 2000) {
  const names = [
    "近くのセルフ 1",
    "近くの給油所 2",
    "近くのスタンド 3",
    "近くのエネルギー 4",
    "近くのサービス 5",
    "近くのフューエル 6",
    "近くのセルフ 7",
    "近くのスタンド 8",
  ];
  const offsets = [
    [520, -360],
    [-760, 430],
    [1100, 780],
    [-1220, -650],
    [1680, -210],
    [450, 1420],
    [-1540, 980],
    [1980, 760],
  ];
  const scale = clamp(radius / 2000, 0.6, 2.4);

  return names.map((name, index) => {
    const point = offsetCoordinate(
      home.lat,
      home.lng,
      offsets[index][0] * scale,
      offsets[index][1] * scale,
    );
    return {
      id: `demo:${index}:${home.lat.toFixed(3)}:${home.lng.toFixed(3)}`,
      name,
      brand: "推定",
      address: "現在地周辺",
      lat: point.lat,
      lng: point.lng,
      distance: distanceKm(home.lat, home.lng, point.lat, point.lng),
      source: "demo",
    };
  });
}

function renderAll() {
  renderDateControl();
  renderSourceBadge();
  renderMetrics();
  renderMarkers();
  renderList();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderDateControl() {
  const date = days[state.selectedDateIndex] || days[days.length - 1];
  el.dateLabel.textContent = displayDate(date);
  el.dateRange.value = String(state.selectedDateIndex);
}

function renderSourceBadge() {
  if (state.priceMode === "imported" && state.importedMaps) {
    el.sourceBadge.textContent = "取込価格";
    return;
  }
  el.sourceBadge.textContent = state.priceSeedLoaded ? "自動更新価格" : "推定価格";
}

function renderMetrics() {
  const views = getStationViews();
  const summary = getDealSummary(views);
  const priced = summary.priced;

  if (priced.length === 0) {
    el.avgMetric.textContent = "--";
    el.lowMetric.textContent = "--";
    el.nearCheapMetric.textContent = "--";
    renderDealCards(null, null);
    return;
  }

  const avg = priced.reduce((sum, view) => sum + view.price, 0) / priced.length;
  el.avgMetric.textContent = money(avg);
  el.lowMetric.textContent = money(summary.cheapest.price);
  el.nearCheapMetric.textContent = money(summary.nearCheap.price);
  renderDealCards(summary.cheapest, summary.nearCheap);
}

function renderDealCards(cheapest, nearCheap) {
  state.cheapestStationId = cheapest?.station.id || null;
  state.nearCheapStationId = nearCheap?.station.id || null;

  setDealCard(el.cheapestButton, el.cheapestName, el.cheapestMeta, cheapest);
  setDealCard(el.nearCheapButton, el.nearCheapName, el.nearCheapMeta, nearCheap);
  setQuickNav(el.cheapestGoogleLink, cheapest, "google");
  setQuickNav(el.cheapestAppleLink, cheapest, "apple");
  setQuickNav(el.nearCheapGoogleLink, nearCheap, "google");
  setQuickNav(el.nearCheapAppleLink, nearCheap, "apple");
}

function setDealCard(button, nameEl, metaEl, view) {
  if (!view) {
    button.disabled = true;
    delete button.dataset.stationId;
    nameEl.textContent = "--";
    metaEl.textContent = "--";
    return;
  }

  button.disabled = false;
  button.dataset.stationId = view.station.id;
  nameEl.textContent = view.station.name;
  metaEl.textContent = `${GRADE_LABELS[state.grade]} ${money(view.price)} · ${distanceLabel(
    view.station.distance,
  )}`;
}

function setQuickNav(link, view, kind) {
  if (!view) {
    link.href = "#";
    link.removeAttribute("target");
    link.removeAttribute("rel");
    link.setAttribute("aria-disabled", "true");
    link.classList.add("is-disabled");
    return;
  }

  configureMapLink(link, view.station, kind);
  link.removeAttribute("aria-disabled");
  link.classList.remove("is-disabled");
}

function renderMarkers() {
  const views = getStationViews();
  const summary = getDealSummary(views);
  const bestId = summary.cheapest?.station.id;
  const activeIds = new Set();

  views.forEach((view) => {
    activeIds.add(view.station.id);
    const isBest = view.station.id === bestId;
    const icon = fuelIcon(view.movement, isBest, view.price);
    const marker = stationMarkers.get(view.station.id);

    if (marker) {
      marker.setLatLng([view.station.lat, view.station.lng]);
      marker.setIcon(icon);
      marker.setPopupContent(popupHtml(view));
    } else {
      const created = L.marker([view.station.lat, view.station.lng], { icon })
        .addTo(stationLayer)
        .bindPopup(popupHtml(view));
      created.on("click", () => selectStation(view.station.id, false));
      stationMarkers.set(view.station.id, created);
    }
  });

  stationMarkers.forEach((marker, id) => {
    if (!activeIds.has(id)) {
      marker.remove();
      stationMarkers.delete(id);
    }
  });
}

function renderList() {
  const views = sortViews(getStationViews());
  el.stationCount.textContent = String(views.length);

  if (views.length === 0) {
    el.stationList.innerHTML = `
      <div class="empty-state">
        <span>現在地を許可すると近くのスタンドを表示します</span>
        <button type="button" data-action="locate">
          <i data-lucide="crosshair"></i>
          現在地
        </button>
      </div>
    `;
    return;
  }

  el.stationList.innerHTML = views
    .map((view) => {
      const selected = view.station.id === state.selectedStationId ? " is-selected" : "";
      const price = view.price === null ? "--" : money(view.price);
      const source = priceSourceLabel(view.priceSource);
      const brand = view.station.brand ? `<span>${escapeHtml(view.station.brand)}</span>` : "";
      const priceStrip = PRICE_GRADES.map((grade) => priceChip(view, grade)).join("");
      return `
        <article class="station-card${selected}" data-station-id="${escapeHtml(
          view.station.id,
        )}">
          <button class="station-pick" type="button" title="このスタンドを見る">
            <span class="station-main">
              <span class="station-name">${escapeHtml(view.station.name)}</span>
              <span class="station-meta">
                <span>${distanceLabel(view.station.distance)}</span>
                ${brand}
                <span>${source}</span>
              </span>
              <span class="price-strip">${priceStrip}</span>
            </span>
            <span class="station-price">
              <span class="price">${price}</span>
              <span class="change-pill ${view.movement}">${changeText(view.change)}</span>
            </span>
          </button>
          <nav class="nav-links" aria-label="${escapeHtml(view.station.name)} へのナビ">
            <a class="google-link" ${mapLinkAttrs(view.station, "google")}>
              <i data-lucide="navigation"></i>
              Google マップ
            </a>
            <a class="apple-link" ${mapLinkAttrs(view.station, "apple")}>
              <i data-lucide="map"></i>
              Apple マップ
            </a>
          </nav>
        </article>
      `;
    })
    .join("");
}

function priceChip(view, grade) {
  const selected = grade === state.grade ? " is-active" : "";
  return `
    <span class="price-chip${selected}">
      <span>${GRADE_LABELS[grade][0]}</span>
      <b>${money(view.prices[grade])}</b>
    </span>
  `;
}

function selectStation(stationId, panMap) {
  state.selectedStationId = stationId;
  const station = state.stations.find((item) => item.id === stationId);
  const marker = stationMarkers.get(stationId);
  renderList();

  if (station && panMap) {
    map.setView([station.lat, station.lng], Math.max(map.getZoom(), 15), { animate: false });
  }
  if (marker) {
    marker.openPopup();
  }
}

function getStationViews() {
  const date = days[state.selectedDateIndex];
  const previousDate = days[state.selectedDateIndex - 1];

  return state.stations.map((station) => {
    const pricedSeries = getSeries(station);
    const current = findPriceRow(pricedSeries.series, date);
    const previous = previousDate ? findPriceRow(pricedSeries.series, previousDate) : null;
    const prices = {};
    const changes = {};
    const movements = {};

    Object.keys(GRADE_LABELS).forEach((grade) => {
      const gradePrice = numericPrice(current?.[grade]);
      const previousGradePrice = numericPrice(previous?.[grade]);
      prices[grade] = gradePrice;
      changes[grade] =
        gradePrice !== null && previousGradePrice !== null
          ? roundMoney(gradePrice - previousGradePrice)
          : null;
      movements[grade] =
        changes[grade] === null
          ? "missing"
          : Math.abs(changes[grade]) < 0.005
            ? "flat"
            : changes[grade] < 0
              ? "down"
              : "up";
    });

    const price = prices[state.grade];
    const change = changes[state.grade];
    const movement = movements[state.grade];

    return {
      station,
      price,
      change,
      movement,
      prices,
      changes,
      movements,
      priceSource: pricedSeries.source,
      series: pricedSeries.series,
    };
  });
}

function sortViews(views) {
  const summary = getDealSummary(views);
  const low = summary.cheapest?.price ?? 999;

  return views.slice().sort((a, b) => {
    if (state.sort === "distance") return a.station.distance - b.station.distance;
    if (state.sort === "drop") return nullable(a.change, 99) - nullable(b.change, 99);
    if (state.sort === "nearCheap") {
      return nearCheapScore(a, low) - nearCheapScore(b, low);
    }
    return nullable(a.price, 999) - nullable(b.price, 999);
  });
}

function getDealSummary(views) {
  const priced = views.filter((view) => view.price !== null);
  if (priced.length === 0) {
    return { priced, cheapest: null, nearCheap: null };
  }

  const cheapest = priced
    .slice()
    .sort((a, b) => a.price - b.price || a.station.distance - b.station.distance)[0];
  const nearCheap = priced
    .filter((view) => view.price <= cheapest.price + NEAR_CHEAP_DELTA)
    .sort((a, b) => a.station.distance - b.station.distance || a.price - b.price)[0];

  return { priced, cheapest, nearCheap };
}

function nearCheapScore(view, low) {
  if (view.price === null) return 99999 + view.station.distance;
  if (view.price <= low + NEAR_CHEAP_DELTA) return view.station.distance;
  return 1000 + (view.price - low) * 100 + view.station.distance;
}

function getSeries(station) {
  if (state.priceMode === "imported" && state.importedMaps) {
    const imported = getImportedSeries(station);
    if (imported) {
      return { source: "imported", series: imported };
    }
  }
  return { source: state.priceSeedLoaded ? "auto" : "demo", series: makeDemoSeries(station) };
}

function getImportedSeries(station) {
  const byId = state.importedMaps.byId.get(station.id);
  if (byId) return byId;

  const byName = state.importedMaps.byName.get(normalizeName(station.name));
  if (byName) return byName;

  return null;
}

function makeDemoSeries(station) {
  const priceSeed = state.priceSeed || defaultPriceSeed();
  const seed = hashString(`${priceSeed.salt}:${station.id}:${station.name}`);
  const localOffset = (seed % 19) - 9;
  const running = {
    regular: baselineForGrade("regular", priceSeed) + localOffset,
    premium: baselineForGrade("premium", priceSeed) + localOffset,
    diesel: baselineForGrade("diesel", priceSeed) + localOffset,
  };

  return days.map((date, index) => {
    const row = { date };
    Object.keys(GRADE_LABELS).forEach((grade) => {
      const randomStep = seededUnit(seed + hashString(`${priceSeed.salt}:${date}:${grade}`)) - 0.5;
      const wave = Math.sin(index * 0.82 + (seed % 37)) * 0.9;
      running[grade] = clamp(running[grade] + randomStep * 2.4 + wave, 120, 260);
      row[grade] = roundMoney(running[grade]);
    });
    return row;
  });
}

function baselineForGrade(grade, priceSeed) {
  const regular = numericPrice(priceSeed?.baselines?.regular) ?? 168;
  const offsets = {
    regular: 0,
    premium: 13,
    diesel: -17,
  };
  return numericPrice(priceSeed?.baselines?.[grade]) ?? regular + offsets[grade];
}

function priceSourceLabel(source) {
  if (source === "imported") return "取込";
  if (source === "auto") return "自動";
  return "推定";
}

async function handlePriceFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const feed = JSON.parse(text);
    const maps = parseImportedFeed(feed);
    state.importedFeed = feed;
    state.importedMaps = maps;
    state.priceMode = "imported";
    el.priceModeInput.value = "imported";
    setStatus(`${maps.count} 件の価格データを取り込みました`);
    renderAll();
  } catch {
    state.importedFeed = null;
    state.importedMaps = null;
    state.priceMode = "demo";
    el.priceModeInput.value = "demo";
    setStatus("価格ファイルを読み込めません");
    renderAll();
  } finally {
    event.target.value = "";
  }
}

function parseImportedFeed(feed) {
  const entries = Array.isArray(feed) ? feed : Array.isArray(feed.stations) ? feed.stations : [];
  const byId = new Map();
  const byName = new Map();
  let count = 0;

  entries.forEach((entry) => {
    const rawSeries = Array.isArray(entry.prices)
      ? entry.prices
      : Array.isArray(entry.history)
        ? entry.history
        : [];
    const series = rawSeries
      .map((row) => normalizePriceRow(row))
      .filter((row) => row && days.includes(row.date));

    if (series.length === 0) return;
    if (entry.id) byId.set(String(entry.id), series);
    if (entry.osmId) byId.set(String(entry.osmId), series);
    if (entry.name) byName.set(normalizeName(entry.name), series);
    count += 1;
  });

  return { byId, byName, count };
}

function normalizePriceRow(row) {
  if (!row || !row.date) return null;
  const normalized = { date: String(row.date).slice(0, 10) };
  Object.keys(GRADE_LABELS).forEach((grade) => {
    const value = numericPrice(row[grade]);
    if (value !== null) normalized[grade] = value;
  });
  return normalized;
}

function downloadTemplate() {
  const template = {
    currency: "JPY",
    unit: "L",
    updated: days[days.length - 1],
    stations: [
      {
        id: "node:123456789",
        name: "サンプル給油所",
        prices: days.slice(-4).map((date, index) => ({
          date,
          regular: roundMoney(169 + index),
          premium: roundMoney(181 + index),
          diesel: roundMoney(151 - index),
        })),
      },
    ],
  };

  const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `fuel-price-template-${days[days.length - 1]}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function updateHomeMarker() {
  if (!map) return;
  if (!state.home || !validCoords(state.home.lat, state.home.lng)) {
    if (homeMarker) {
      homeMarker.remove();
      homeMarker = null;
    }
    if (rangeCircle) {
      rangeCircle.remove();
      rangeCircle = null;
    }
    return;
  }

  const icon = L.divIcon({
    className: "",
    html: '<div class="home-marker">家</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  if (!homeMarker) {
    homeMarker = L.marker([state.home.lat, state.home.lng], { icon, zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup(`<strong>${escapeHtml(state.home.label)}</strong>`);
  } else {
    homeMarker.setLatLng([state.home.lat, state.home.lng]);
    homeMarker.setIcon(icon);
    homeMarker.setPopupContent(`<strong>${escapeHtml(state.home.label)}</strong>`);
  }
  updateRangeCircle();
}

function updateRangeCircle() {
  if (!state.home || !validCoords(state.home.lat, state.home.lng)) return;
  if (!rangeCircle) {
    rangeCircle = L.circle([state.home.lat, state.home.lng], {
      radius: state.radius,
      color: "#0e8f63",
      weight: 2,
      opacity: 0.55,
      fillColor: "#0e8f63",
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(map);
    return;
  }

  rangeCircle.setLatLng([state.home.lat, state.home.lng]);
  rangeCircle.setRadius(state.radius);
}

function updateBaseLayer() {
  if (baseLayer) {
    baseLayer.remove();
    baseLayer = null;
  }

  baseLayerType = "lite";
  tileFallbackArmed = false;
  document.getElementById("map")?.classList.add("map-lite");
}

function isInJapan(lat, lng) {
  return lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154;
}

function fuelIcon(movement, isBest, price) {
  const label = price === null ? "--" : money(price);
  return L.divIcon({
    className: "",
    html: `<div class="fuel-marker ${movement}${isBest ? " best" : ""}">${label}</div>`,
    iconSize: [56, 34],
    iconAnchor: [28, 17],
    popupAnchor: [0, -16],
  });
}

function popupHtml(view) {
  const price = view.price === null ? "--" : money(view.price);
  const change = changeText(view.change);
  const source = priceSourceLabel(view.priceSource);
  const threePrices = PRICE_GRADES.map(
    (grade) => `
      <div class="popup-price ${grade === state.grade ? "is-active" : ""}">
        <span>${GRADE_LABELS[grade]}</span>
        <b>${money(view.prices[grade])}</b>
      </div>
    `,
  ).join("");
  return `
    <div class="popup">
      <strong>${escapeHtml(view.station.name)}</strong>
      <div class="popup-prices">${threePrices}</div>
      <div class="popup-row"><span>前日比</span><b>${change}</b></div>
      <div class="popup-row"><span>距離</span><b>${distanceLabel(view.station.distance)}</b></div>
      <div class="popup-row"><span>ソース</span><b>${source}</b></div>
      <div class="popup-actions">
        <a class="google-link" ${mapLinkAttrs(view.station, "google")}>Google マップ</a>
        <a class="apple-link" ${mapLinkAttrs(view.station, "apple")}>Apple マップ</a>
      </div>
    </div>
  `;
}

function configureMapLink(link, station, kind) {
  link.href = kind === "apple" ? appleMapsUrl(station) : googleMapsUrl(station);
  link.removeAttribute("target");
  link.removeAttribute("rel");
}

function mapLinkAttrs(station, kind) {
  const href = kind === "apple" ? appleMapsUrl(station) : googleMapsUrl(station);
  return `href="${escapeHtml(href)}"`;
}

function googleMapsUrl(station) {
  const destination = `${station.lat},${station.lng}`;
  const params = new URLSearchParams({
    api: "1",
    destination,
    travelmode: "driving",
    dir_action: "navigate",
    hl: "ja",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function appleMapsUrl(station) {
  const destination = `${station.lat},${station.lng}`;
  const params = new URLSearchParams({
    daddr: destination,
    q: station.name,
    dirflg: "d",
  });
  return `https://maps.apple.com/?${params.toString()}`;
}

function setStatus(message) {
  el.statusPill.querySelector("span").textContent = message;
}

function makeDateRange(count) {
  const dates = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    dates.push(toIsoDate(date));
  }
  return dates;
}

function toIsoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function displayDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(year, month - 1, day));
}

function findPriceRow(series, date) {
  return series.find((row) => row.date === date) || null;
}

function money(value) {
  if (value === null || Number.isNaN(value)) return "--";
  return `¥${Math.round(Number(value)).toLocaleString("ja-JP")}`;
}

function changeText(value) {
  if (value === null || Number.isNaN(value)) return "--";
  if (Math.abs(value) < 0.5) return "¥0";
  const prefix = value > 0 ? "+" : "-";
  return `${prefix}${money(Math.abs(value))}`;
}

function numericPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? roundMoney(number) : null;
}

function roundMoney(value) {
  return Math.round(value);
}

function nullable(value, fallback) {
  return value === null || Number.isNaN(value) ? fallback : value;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed) {
  const raw = Math.sin(seed) * 10000;
  return raw - Math.floor(raw);
}

function validCoords(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function radiusToZoom(radius) {
  if (radius <= 1200) return 15;
  if (radius <= 3200) return 13;
  if (radius <= 5500) return 12;
  return 11;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const earthKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceLabel(value) {
  if (value < 1) return `${Math.round(value * 1000)} m`;
  return `${value.toFixed(1)} km`;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function offsetCoordinate(lat, lng, northMeters, eastMeters) {
  const latOffset = northMeters / 111320;
  const lngOffset = eastMeters / (111320 * Math.cos(toRadians(lat)));
  return { lat: lat + latOffset, lng: lng + lngOffset };
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
