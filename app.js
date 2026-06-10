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
const STATION_LIMIT = 40;
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const TILE_PROVIDERS = [
  {
    id: "osm",
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      subdomains: "abc",
      maxZoom: 19,
      maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  {
    id: "carto-light",
    label: "CARTO Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    options: {
      subdomains: "abcd",
      maxZoom: 19,
      maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  },
  {
    id: "carto-simple",
    label: "CARTO Simple",
    url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
    options: {
      subdomains: "abcd",
      maxZoom: 19,
      maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  },
];

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
  stationFetchStatus: "idle",
  stationFetchMessage: "",
  priceSeed: defaultPriceSeed(),
  priceSeedLoaded: false,
};

const el = {};
let map;
let homeMarker;
let baseLayer;
let baseLayerProviderIndex = 0;
let tileFallbackTimer = null;
let tileLoadToken = 0;
let loadedTileCount = 0;
let failedTileCount = 0;
let rangeCircle;
let stationLayer;
let stationMarkers = new Map();
let stationRequestToken = 0;

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
    "hudDate",
    "hudStationMetric",
    "hudLowMetric",
    "dockRegularPrice",
    "dockPremiumPrice",
    "dockDieselPrice",
    "sourceBadge",
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
  el.resourceNodes = [...document.querySelectorAll(".resource-node[data-grade]")];
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
    setGrade(el.gradeInput.value);
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

  el.resourceNodes.forEach((button) => {
    button.addEventListener("click", () => setGrade(button.dataset.grade));
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

function setGrade(grade) {
  if (!GRADE_LABELS[grade]) return;
  state.grade = grade;
  el.gradeInput.value = grade;
  saveState();
  renderAll();
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
    attributionControl: true,
  }).setView(
    [state.home?.lat ?? DEFAULT_VIEW.lat, state.home?.lng ?? DEFAULT_VIEW.lng],
    state.home ? 13 : DEFAULT_VIEW.zoom,
  );

  map.attributionControl.setPrefix("");
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
  state.stationFetchStatus = "loading";
  state.stationFetchMessage = "実在スタンドを検索しています...";
  state.stations = [];
  renderAll();
  setStatus(state.stationFetchMessage);
  updateHomeMarker();
  updateBaseLayer();
  map.setView([state.home.lat, state.home.lng], radiusToZoom(state.radius), { animate: false });

  const token = (stationRequestToken += 1);
  try {
    const stations = await fetchRealStations(state.home, state.radius);
    if (token !== stationRequestToken) return;

    state.stations = stations;
    state.stationFetchStatus = stations.length > 0 ? "ready" : "empty";
    state.stationFetchMessage =
      stations.length > 0
        ? `${stations.length} 件の実在スタンドを表示中`
        : "半径内の実在スタンドが見つかりません。距離を広げて再取得してください";
    renderAll();
    setStatus(state.stationFetchMessage);
  } catch {
    if (token !== stationRequestToken) return;

    state.stations = [];
    state.stationFetchStatus = "error";
    state.stationFetchMessage =
      "実在スタンドを取得できません。通信後に再取得するか距離を広げてください";
    renderAll();
    setStatus(state.stationFetchMessage);
  }
}

async function fetchRealStations(home, radius) {
  const primary = await fetchNominatimStations(home, radius, "amenity");
  if (primary.length > 0) return primary;
  return fetchNominatimStations(home, radius, "query");
}

async function fetchNominatimStations(home, radius, mode) {
  const params = new URLSearchParams({
    format: "jsonv2",
    bounded: "1",
    limit: String(STATION_LIMIT),
    viewbox: boundingBox(home.lat, home.lng, radius),
    addressdetails: "1",
    extratags: "1",
    namedetails: "1",
    "accept-language": "ja",
  });

  if (mode === "amenity") {
    params.set("amenity", "fuel");
  } else {
    params.set("q", "gas station");
  }

  const items = await fetchJsonWithTimeout(`${NOMINATIM_ENDPOINT}?${params.toString()}`, 9000);
  if (!Array.isArray(items)) return [];

  const unique = new Map();
  items.forEach((item) => {
    const station = normalizeNominatimStation(item, home, radius);
    if (station && !unique.has(station.id)) unique.set(station.id, station);
  });

  return [...unique.values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, STATION_LIMIT);
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`station search ${response.status}`);
    return response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeNominatimStation(item, home, radius) {
  const lat = Number(item?.lat);
  const lng = Number(item?.lon);
  if (!validCoords(lat, lng)) return null;

  const distance = distanceKm(home.lat, home.lng, lat, lng);
  if (distance * 1000 > radius + 60) return null;
  if (item.class && item.class !== "amenity") return null;
  if (item.type && item.type !== "fuel") return null;
  if (!isUsableFuelResult(item)) return null;

  const namedetails = item.namedetails || {};
  const extratags = item.extratags || {};
  const displayParts = String(item.display_name || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const brand =
    namedetails["brand:ja"] ||
    extratags["brand:ja"] ||
    extratags.brand ||
    namedetails.brand ||
    "";
  const operator =
    namedetails["operator:ja"] ||
    extratags["operator:ja"] ||
    extratags.operator ||
    namedetails.operator ||
    "";
  const name =
    namedetails["name:ja"] ||
    namedetails.name ||
    item.name ||
    brand ||
    operator ||
    displayParts[0] ||
    "ガソリンスタンド";
  const branch = extratags["branch:ja"] || extratags.branch || "";
  const displayName =
    branch && !name.includes(branch) && !normalizeName(name).includes(normalizeName(branch))
      ? `${name} ${branch}`
      : name;
  const formattedAddress = formatStationAddress(item, displayParts, displayName);
  const rawId = item.osm_type && item.osm_id ? `${item.osm_type}:${item.osm_id}` : item.place_id;

  return {
    id: `osm:${rawId}`,
    name: displayName,
    brand: brand && brand !== displayName ? brand : "",
    address: formattedAddress.text,
    addressQuality: formattedAddress.quality,
    addressNote: formattedAddress.note,
    coordinateLabel: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    osmRef: item.osm_type && item.osm_id ? `${item.osm_type} ${item.osm_id}` : "",
    lat,
    lng,
    distance,
    source: "osm",
  };
}

function isUsableFuelResult(item) {
  const tags = item.extratags || {};
  const namedetails = item.namedetails || {};
  const nameText = [
    item.name,
    namedetails.name,
    namedetails["name:ja"],
    tags.brand,
    tags["brand:ja"],
    tags.operator,
    tags.branch,
  ]
    .filter(Boolean)
    .join(" ");

  const inactiveKeys = [
    "abandoned",
    "abandoned:amenity",
    "abandoned:place",
    "construction",
    "demolished:amenity",
    "disused",
    "disused:amenity",
    "razed:amenity",
    "was:amenity",
  ];
  if (inactiveKeys.some((key) => truthyTag(tags[key]))) return false;
  if (String(tags.landuse || "").toLowerCase() === "construction") return false;

  const fuelKeys = Object.keys(tags).filter((key) => key.startsWith("fuel:") && truthyTag(tags[key]));
  const hasLiquidFuel = fuelKeys.some((key) =>
    /diesel|octane|gasoline|petrol|e10|e85|biodiesel/.test(key),
  );
  const lpgOnly =
    /astomos|オートガス|auto gas|lpg|lpガス|lp gas/i.test(nameText) ||
    (truthyTag(tags["fuel:lpg"]) &&
      !hasLiquidFuel &&
      (truthyTag(tags.industrial) || /ガス|gas/i.test(nameText)));

  return !lpgOnly;
}

function truthyTag(value) {
  if (value === true) return true;
  return ["yes", "true", "1", "designated"].includes(String(value || "").toLowerCase());
}

function boundingBox(lat, lng, radiusMeters) {
  const latOffset = radiusMeters / 111320;
  const lngOffset = radiusMeters / (111320 * Math.max(Math.cos(toRadians(lat)), 0.2));
  const left = lng - lngOffset;
  const right = lng + lngOffset;
  const top = lat + latOffset;
  const bottom = lat - latOffset;
  return [left, top, right, bottom].map((value) => value.toFixed(6)).join(",");
}

function formatStationAddress(item, displayParts, name) {
  const address = item.address || {};
  const tags = item.extratags || {};
  const postcode = normalizePostcode(address.postcode);
  const tagFullAddress = tags["addr:full"] || tags["addr:ja"] || tags["addr:full:ja"] || "";
  if (tagFullAddress) {
    return {
      text: String(tagFullAddress).trim(),
      quality: "登録住所",
      note: "地図登録住所",
    };
  }

  const tagHouseNumber = tags["addr:housenumber"] || address.house_number || "";
  const tagRoad =
    tags["addr:street"] || address.road || address.pedestrian || address.footway || "";
  const locality = uniqueAddressParts([
    postcode ? `〒${postcode}` : "",
    address.province || address.state || address.region || "",
    address.city || address.town || address.village || address.municipality || "",
    address.suburb || address.city_district || address.borough || "",
    address.neighbourhood || address.quarter || address.hamlet || "",
  ]);

  if (tagHouseNumber && tagRoad && locality.length >= 2) {
    return {
      text: uniqueAddressParts([...locality, tagRoad, tagHouseNumber]).join(" "),
      quality: "番地あり",
      note: "住所で確認済み",
    };
  }

  if (locality.length >= 3) {
    return {
      text: locality.join(" "),
      quality: "所在地目安",
      note: "位置は座標優先",
    };
  }

  return {
    text:
      displayParts
        .filter((part) => part && part !== name && part !== "日本")
        .slice(-3)
        .join(" ") || "住所未登録",
    quality: "座標のみ",
    note: "位置は座標優先",
  };
}

function normalizePostcode(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("〒") ? text.slice(1) : text;
}

function uniqueAddressParts(parts) {
  const seen = new Set();
  return parts
    .map((part) => String(part || "").trim())
    .filter((part) => {
      if (!part || part === "日本" || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
}

function renderAll() {
  renderDateControl();
  renderSourceBadge();
  renderMetrics();
  renderMarkers();
  renderList();
  renderGradeDock();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderDateControl() {
  const date = days[state.selectedDateIndex] || days[days.length - 1];
  el.dateLabel.textContent = displayDate(date);
  if (el.hudDate) el.hudDate.textContent = displayDate(date);
  el.dateRange.value = String(state.selectedDateIndex);
}

function renderSourceBadge() {
  if (state.priceMode === "imported" && state.importedMaps) {
    el.sourceBadge.textContent = "取込価格";
    return;
  }
  el.sourceBadge.textContent = state.priceSeedLoaded ? "毎日更新・推定" : "推定価格";
}

function renderMetrics() {
  const views = getStationViews();
  const summary = getDealSummary(views);
  const priced = summary.priced;

  if (priced.length === 0) {
    el.avgMetric.textContent = "--";
    el.lowMetric.textContent = "--";
    el.nearCheapMetric.textContent = "--";
    if (el.hudLowMetric) el.hudLowMetric.textContent = "--";
    renderDealCards(null, null);
    return;
  }

  const avg = priced.reduce((sum, view) => sum + view.price, 0) / priced.length;
  el.avgMetric.textContent = money(avg);
  el.lowMetric.textContent = money(summary.cheapest.price);
  if (el.hudLowMetric) el.hudLowMetric.textContent = money(summary.cheapest.price);
  el.nearCheapMetric.textContent = money(summary.nearCheap.price);
  renderDealCards(summary.cheapest, summary.nearCheap);
}

function renderGradeDock() {
  const views = getStationViews();
  const lows = {};

  PRICE_GRADES.forEach((grade) => {
    const prices = views
      .map((view) => view.prices[grade])
      .filter((price) => price !== null && !Number.isNaN(price));
    lows[grade] = prices.length > 0 ? Math.min(...prices) : null;
  });

  if (el.dockRegularPrice) el.dockRegularPrice.textContent = lows.regular === null ? "--" : money(lows.regular);
  if (el.dockPremiumPrice) el.dockPremiumPrice.textContent = lows.premium === null ? "--" : money(lows.premium);
  if (el.dockDieselPrice) el.dockDieselPrice.textContent = lows.diesel === null ? "--" : money(lows.diesel);

  el.resourceNodes.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.grade === state.grade);
  });
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
  if (el.hudStationMetric) el.hudStationMetric.textContent = `${views.length} ST`;

  if (views.length === 0) {
    const message =
      state.stationFetchMessage ||
      (state.home
        ? "半径内の実在スタンドを取得できませんでした"
        : "現在地を許可すると近くのスタンドを表示します");
    const showLocate = !state.home || state.stationFetchStatus === "idle";
    el.stationList.innerHTML = `
      <div class="empty-state ${state.stationFetchStatus === "loading" ? "is-loading" : ""}">
        <span>${escapeHtml(message)}</span>
        ${
          showLocate
            ? `<button type="button" data-action="locate">
                <i data-lucide="crosshair"></i>
                現在地
              </button>`
            : ""
        }
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
      const address = view.station.address
        ? `<span class="station-address">${escapeHtml(view.station.address)}</span>`
        : "";
      const addressMeta = `
        <span class="station-location-meta">
          <span>${escapeHtml(view.station.addressQuality || "地図登録住所")}</span>
          <span>${escapeHtml(view.station.addressNote || "位置は座標優先")}</span>
          <span>座標 ${escapeHtml(view.station.coordinateLabel || "")}</span>
        </span>
      `;
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
              ${address}
              ${addressMeta}
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
  if (source === "auto") return "推定";
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
  const mapEl = document.getElementById("map");
  if (baseLayer) return;
  addTileProvider(baseLayerProviderIndex, mapEl);
}

function addTileProvider(providerIndex, mapEl) {
  if (baseLayer) baseLayer.remove();
  if (tileFallbackTimer) window.clearTimeout(tileFallbackTimer);

  const provider = TILE_PROVIDERS[providerIndex];
  if (!provider) {
    baseLayer = null;
    mapEl?.classList.add("map-lite");
    setStatus("簡易マップで表示中。道路地図は読み込めませんでした");
    return;
  }

  mapEl?.classList.remove("map-lite");
  baseLayerProviderIndex = providerIndex;
  loadedTileCount = 0;
  failedTileCount = 0;
  const token = (tileLoadToken += 1);

  baseLayer = L.tileLayer(provider.url, {
    detectRetina: true,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 2,
    ...provider.options,
  });

  baseLayer.on("tileload", () => {
    if (token !== tileLoadToken) return;
    loadedTileCount += 1;
    if (loadedTileCount === 1) {
      setStatus(
        state.stationFetchStatus === "loading"
          ? state.stationFetchMessage
          : `${provider.label} で道路地図を表示中`,
      );
    }
  });

  baseLayer.on("tileerror", () => {
    if (token !== tileLoadToken) return;
    failedTileCount += 1;
    if (loadedTileCount === 0 && failedTileCount >= 4) {
      addTileProvider(providerIndex + 1, mapEl);
    }
  });

  baseLayer.addTo(map);
  tileFallbackTimer = window.setTimeout(() => {
    if (token === tileLoadToken && loadedTileCount === 0) {
      addTileProvider(providerIndex + 1, mapEl);
    }
  }, 4500);
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
      <div class="popup-row"><span>所在地</span><b>${escapeHtml(view.station.address || "--")}</b></div>
      <div class="popup-row"><span>住所扱い</span><b>${escapeHtml(view.station.addressQuality || "--")} · ${escapeHtml(
        view.station.addressNote || "位置は座標優先",
      )}</b></div>
      <div class="popup-row"><span>座標</span><b>${escapeHtml(view.station.coordinateLabel || "--")}</b></div>
      <div class="popup-row"><span>前日比</span><b>${change}</b></div>
      <div class="popup-row"><span>距離</span><b>${distanceLabel(view.station.distance)}</b></div>
      <div class="popup-row"><span>ソース</span><b>${source}</b></div>
      ${
        view.station.osmRef
          ? `<div class="popup-row"><span>OSM</span><b>${escapeHtml(view.station.osmRef)}</b></div>`
          : ""
      }
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
