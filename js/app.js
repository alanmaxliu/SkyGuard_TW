/**
 * 空拍即查通 v1.3.0 - 全螢幕地圖 ＋ 底部抽屜速查控制器
 */

import { VERSION_INFO } from './version.js';
import { FORTRESS_LIST } from './data/fortresses.js';
import {
  NATIONAL_PARK_RULES,
  COMMERCIAL_PORT_RULE,
  PRESET_LOCATIONS
} from './data/regulations.js';
import { calculateSunTimes } from './utils/sun.js';
import { formatDistance } from './utils/geo.js';
import { inspectLocationAirspace } from './services/caaApi.js';

function detectMobileDevice() {
  const ua = navigator.userAgent || '';
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const isCoarse =
    navigator.maxTouchPoints > 1 &&
    window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches &&
    window.innerWidth <= 960;
  return isMobileUA || isCoarse;
}

const state = {
  isMobile: detectMobileDevice(),
  lat: 22.6029,
  lng: 120.3030,
  map: null,
  userMarker: null,
  scanRadiusCircle: null,
  vectorLine: null,
  airspaceLayerGroup: null,
  fortressLayerGroup: null,
  sheetExpanded: false,
  lastReport: null,
  deferredPwaPrompt: null
};

document.addEventListener('DOMContentLoaded', () => {
  initVersionUI();
  initServiceWorker();
  initMap();
  initQuickSpots();
  initDirectories();
  bindEvents();

  // 設定定位按鈕文字
  const btnTxt = document.getElementById('txtLocateBtn');
  if (btnTxt) {
    btnTxt.textContent = state.isMobile ? '📍 手機 GPS 定位' : '💻 電腦網路定位';
  }

  // 1. 若網址有分享座標 (?lat=...&lng=...)，直接定位該點
  const params = new URLSearchParams(window.location.search);
  const urlLat = parseFloat(params.get('lat'));
  const urlLng = parseFloat(params.get('lng'));

  if (!isNaN(urlLat) && !isNaN(urlLng) && urlLat >= 18 && urlLat <= 27 && urlLng >= 116 && urlLng <= 123) {
    runCoordinateCheck(urlLat, urlLng, '分享座標位置', false);
    return;
  }

  // 2. 自動依裝置類型執行定位：
  //    - 手機：啟動手機硬體 GPS
  //    - 電腦／筆電：自動以連上的網路定位
  if (state.isMobile) {
    locateByMobileGPS(true);
  } else {
    locateByComputerNetwork();
  }
});

/**
 * 版本資訊與一鍵強制清除快取更新
 */
function initVersionUI() {
  const badge = document.getElementById('btnVersionBadge');
  const footerVer = document.getElementById('txtFooterVer');
  const modal = document.getElementById('modalVersion');
  const body = document.getElementById('versionChangelogBody');

  if (badge) badge.textContent = VERSION_INFO.version;
  if (footerVer) footerVer.textContent = `版號：${VERSION_INFO.version} (${VERSION_INFO.buildDate})`;

  if (body) {
    body.innerHTML = VERSION_INFO.changelog
      .map(
        (log) => `
        <div class="ver-block">
          <div class="ver-block-head">
            <span>${log.version}</span>
            <span style="color:#94a3b8;font-weight:600;">${log.date}</span>
          </div>
          <ul>
            ${log.items.map((i) => `<li>${i}</li>`).join('')}
          </ul>
        </div>
      `
      )
      .join('');
  }

  if (badge && modal) {
    badge.addEventListener('click', () => modal.classList.remove('hidden'));
  }

  document.getElementById('btnCloseVersion')?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  document.getElementById('btnForceRefresh')?.addEventListener('click', async () => {
    showToast('🔄 正在清除快取並載入最新版...');
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
      }
    } catch (_) {}
    window.location.href = `${window.location.pathname}?v=${Date.now()}`;
  });
}

/**
 * 註冊 Service Worker 並在檢測到新版時自動重新整理
 */
function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js?v=1.4.0')
      .then((reg) => {
        reg.update();
      })
      .catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPwaPrompt = e;
    document.getElementById('btnDirectInstall')?.classList.remove('hidden');
  });
}

/**
 * 【電腦／筆電】以連上的網路自動定位
 */
async function locateByComputerNetwork() {
  const btnTxt = document.getElementById('txtLocateBtn');
  if (btnTxt) btnTxt.textContent = '📡 網路定位中...';

  let located = false;
  try {
    const res = await fetch('https://ipwho.is/');
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.latitude && data.longitude) {
        located = true;
        const city = data.city ? `電腦連網 (${data.city})` : '電腦連網定位';
        runCoordinateCheck(Number(data.latitude), Number(data.longitude), city, false);
      }
    }
  } catch (_) {}

  if (!located) {
    try {
      const res2 = await fetch('https://get.geojs.io/v1/ip/geo.json');
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2 && data2.latitude && data2.longitude) {
          located = true;
          runCoordinateCheck(Number(data2.latitude), Number(data2.longitude), '電腦連網定位', false);
        }
      }
    } catch (_) {}
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (btnTxt) btnTxt.textContent = '💻 重新網路定位';
        runCoordinateCheck(pos.coords.latitude, pos.coords.longitude, '電腦 Wi-Fi 定位', false);
      },
      () => {
        if (btnTxt) btnTxt.textContent = '💻 重新網路定位';
        if (!located) runCoordinateCheck(25.0338, 121.5645, '預設位置', false);
      },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
    );
  } else {
    if (btnTxt) btnTxt.textContent = '💻 重新網路定位';
    if (!located) runCoordinateCheck(25.0338, 121.5645, '預設位置', false);
  }
}

/**
 * 【手機】使用手機 GPS 衛星定位
 */
function locateByMobileGPS(isAuto = false) {
  const btnTxt = document.getElementById('txtLocateBtn');
  if (!navigator.geolocation) {
    showToast('您的瀏覽器不支援 GPS 定位');
    if (isAuto) runCoordinateCheck(22.6029, 120.3030, '預設位置', false);
    return;
  }

  if (btnTxt) btnTxt.textContent = '📡 GPS 定位中...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (btnTxt) btnTxt.textContent = '📍 重新 GPS 定位';
      const acc = accuracy ? ` (±${Math.round(accuracy)}m)` : '';
      showToast(`✅ 手機 GPS 定位成功${acc}`);
      runCoordinateCheck(latitude, longitude, `手機 GPS${acc}`, true);
    },
    (err) => {
      navigator.geolocation.getCurrentPosition(
        (pos2) => {
          if (btnTxt) btnTxt.textContent = '📍 重新 GPS 定位';
          showToast('✅ 手機訊號定位成功');
          runCoordinateCheck(pos2.coords.latitude, pos2.coords.longitude, '手機定位', true);
        },
        () => {
          if (btnTxt) btnTxt.textContent = '📍 點此 GPS 定位';
          if (!isAuto) {
            showToast(err.code === 1 ? '⚠️ 請允許瀏覽器取用「位置」權限' : '⚠️ 請確認手機已開啟定位服務');
          } else {
            runCoordinateCheck(22.6029, 120.3030, '點上方「定位」取得您的位置', false);
          }
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 30000 }
      );
    },
    { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
  );
}

/**
 * 初始化全螢幕 Leaflet 地圖
 */
function initMap() {
  const map = L.map('mapContainer', {
    center: [state.lat, state.lng],
    zoom: 14,
    zoomControl: true
  });

  const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OSM'
  });

  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: '&copy; Esri'
    }
  );

  street.addTo(map);
  L.control.layers({ '一般地圖': street, '衛星地圖': satellite }, null, {
    position: 'topleft'
  }).addTo(map);

  state.airspaceLayerGroup = L.layerGroup().addTo(map);
  state.fortressLayerGroup = L.layerGroup().addTo(map);

  drawAllFortressesOnMap();

  // 點擊地圖上任何地方直接查詢該點
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    runCoordinateCheck(lat, lng, '地圖點選處', true);
  });

  state.map = map;
}

/**
 * 在地圖上畫出國防部 22 處要塞
 */
function drawAllFortressesOnMap() {
  state.fortressLayerGroup.clearLayers();

  FORTRESS_LIST.forEach((f) => {
    L.circle([f.lat, f.lng], {
      radius: f.alertRadius,
      color: '#a855f7',
      weight: 1.2,
      dashArray: '5, 5',
      fillColor: '#a855f7',
      fillOpacity: 0.04
    })
      .bindPopup(`<strong>🪖 ${f.name}（外圍注意區）</strong><br/>${f.warning}`)
      .addTo(state.fortressLayerGroup);

    L.circle([f.lat, f.lng], {
      radius: f.coreRadius,
      color: '#d946ef',
      weight: 2.5,
      fillColor: '#a855f7',
      fillOpacity: 0.28
    })
      .bindPopup(
        `<strong>🚨 【要塞禁飛區】${f.name}</strong><br/>管轄：${f.command}<br/><span style="color:#ef4444;font-weight:bold;">嚴禁空拍與攝影！</span>`
      )
      .addTo(state.fortressLayerGroup);
  });
}

/**
 * 切換熱門地點下拉選單
 */
function initQuickSpots() {
  const sel = document.getElementById('selectQuickSpot');
  PRESET_LOCATIONS.forEach((spot, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = spot.name;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10);
    if (!isNaN(idx) && PRESET_LOCATIONS[idx]) {
      const s = PRESET_LOCATIONS[idx];
      toggleSheet(false);
      runCoordinateCheck(s.lat, s.lng, s.name, true);
    }
  });
}

/**
 * 執行座標查詢並更新地圖與底部抽屜卡
 */
async function runCoordinateCheck(lat, lng, label = '目前位置', updateUrl = true) {
  state.lat = Number(lat.toFixed(6));
  state.lng = Number(lng.toFixed(6));

  if (updateUrl) {
    const u = `${window.location.pathname}?lat=${state.lat.toFixed(5)}&lng=${state.lng.toFixed(5)}`;
    window.history.replaceState({ path: u }, '', u);
  }

  updateMapUserMarker(state.lat, state.lng);

  // 1. 立即計算並顯示日出日落時間
  const sun = calculateSunTimes(state.lat, state.lng, new Date());
  renderSunInfo(sun);

  // 2. 顯示讀取狀態
  document.getElementById('txtCoordSub').textContent = `${label} (${state.lat.toFixed(4)}, ${state.lng.toFixed(4)})・讀取民航局圖資中...`;

  // 3. 查詢民航局 GIS 圖資與 22 處要塞
  const report = await inspectLocationAirspace(state.lat, state.lng, 5000);
  state.lastReport = report;

  const onlineTag = report.isOnline ? '✅ 圖資已同步' : '離線備援';
  document.getElementById('txtCoordSub').textContent = `${label} (${state.lat.toFixed(4)}, ${state.lng.toFixed(4)})・${onlineTag}`;

  // 4. 繪製地圖多邊形與最近禁飛區導引線
  renderMapAirspacePolygons(report.allAnalyzedFeatures);
  renderSheetVerdict(report);
  renderNearbyInfo(report);
  renderParkPortInfo(report);
  renderFortressInfo(report);
}

/**
 * 更新地圖上的目前位置藍點
 */
function updateMapUserMarker(lat, lng) {
  if (!state.map) return;

  if (state.userMarker) state.map.removeLayer(state.userMarker);
  if (state.scanRadiusCircle) state.map.removeLayer(state.scanRadiusCircle);
  if (state.vectorLine) state.map.removeLayer(state.vectorLine);

  const icon = L.divIcon({
    className: 'pin-me',
    html: `<div style="width:20px;height:20px;background:#0ea5e9;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(2,132,199,0.95);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  state.userMarker = L.marker([lat, lng], { icon })
    .addTo(state.map)
    .bindPopup(`<strong>📍 查詢位置</strong><br/>${lat.toFixed(5)}, ${lng.toFixed(5)}`);

  state.map.setView([lat, lng], 14);
}

/**
 * 繪製地圖上的禁飛區、限高區、國家公園與商港範圍
 */
function renderMapAirspacePolygons(features) {
  state.airspaceLayerGroup.clearLayers();
  if (!features) return;

  features.forEach((item) => {
    const { feature, info, spatial } = item;
    let color = '#ef4444';
    let fillOpacity = 0.24;

    if (info.severity === 'restricted_60m' || info.severity === 'conditional_yellow') {
      color = '#f59e0b';
      fillOpacity = 0.16;
    } else if (info.layerType === 'national_park' || info.layerType === 'port') {
      color = '#f97316';
      fillOpacity = 0.18;
    }

    const distNote = spatial.inside
      ? '<span style="color:#ef4444;font-weight:bold;">您在此區域內</span>'
      : `距離您：${spatial.compass.name} ${formatDistance(spatial.distanceMeters)}`;

    L.geoJSON(feature, {
      style: {
        color,
        weight: spatial.inside ? 2.5 : 1.5,
        fillColor: color,
        fillOpacity
      }
    })
      .bindPopup(
        `<div style="font-size:13px;line-height:1.45;">
          <strong>[${info.colorZone}] ${info.name}</strong><br/>
          <span>位置：${distNote}</span><br/>
          <span>機關：${info.authority}</span><br/>
          <hr style="margin:4px 0;border:0;border-top:1px solid #cbd5e1;"/>
          <div style="max-height:100px;overflow-y:auto;font-size:12px;">${(info.description || '').replace(/\n/g, '<br/>')}</div>
        </div>`
      )
      .addTo(state.airspaceLayerGroup);
  });
}

/**
 * 更新底部抽屜卡【1. 這裡能不能飛？最高飛多高？】
 */
function renderSheetVerdict(report) {
  const { overallVerdict, activeZonesHere, fortressReport } = report;
  const sheet = document.getElementById('bottomSheet');
  const expandedClass = state.sheetExpanded ? 'expanded' : '';
  sheet.className = `bottom-sheet sheet-${overallVerdict.statusCode} ${expandedClass}`;

  const pillStatus = document.getElementById('pillZoneStatus');
  const headline = document.getElementById('txtSummaryTitle');
  const altNum = document.getElementById('txtSummaryAlt');
  const detailDesc = document.getElementById('txtDetailVerdictDesc');

  if (overallVerdict.statusCode === 'GREEN_SAFE') {
    pillStatus.textContent = '🟢 可以飛';
    headline.textContent = '這裡可以飛！最高 120 公尺';
    altNum.textContent = '120m';
    detailDesc.textContent = '此座標不在禁航區、國家公園或軍事要塞內，日間可合法飛行（最高 120 公尺／400 呎）。';
  } else if (overallVerdict.statusCode === 'YELLOW_60M') {
    pillStatus.textContent = '🟡 限高 60m';
    headline.textContent = '可飛・最高限高 60 公尺 (機場周邊)';
    altNum.textContent = '60m';
    detailDesc.textContent = overallVerdict.subHeadline;
  } else if (overallVerdict.statusCode === 'ORANGE_RESTRICTED') {
    pillStatus.textContent = '🟠 需先申請';
    headline.textContent = `需先申請！（核准後限高 ${overallVerdict.maxAltitudeMeters}m）`;
    altNum.textContent = `${overallVerdict.maxAltitudeMeters}m`;
    detailDesc.textContent = overallVerdict.subHeadline;
  } else {
    pillStatus.textContent = '🔴 禁止起飛';
    headline.textContent = `禁止起飛！（${overallVerdict.reasons[0] || '禁飛區'}）`;
    altNum.textContent = '0m';
    detailDesc.textContent = overallVerdict.subHeadline;
  }

  const hitList = document.getElementById('listActiveHitZones');
  hitList.innerHTML = '';

  if (fortressReport.nearest && fortressReport.nearest.inCore) {
    const f = fortressReport.nearest;
    const d = document.createElement('div');
    d.className = 'hit-box purple';
    d.innerHTML = `<strong>🪖 位於國防部要塞：${f.name}</strong><br/>${f.warning}`;
    hitList.appendChild(d);
  }

  activeZonesHere.forEach((z) => {
    const { info } = z;
    let cls = '';
    if (info.severity === 'restricted_60m' || info.severity === 'conditional_yellow') cls = 'yellow';
    if (info.layerType === 'national_park' || info.layerType === 'port') cls = 'orange';

    const d = document.createElement('div');
    d.className = `hit-box ${cls}`;
    d.innerHTML = `<strong>[${info.colorZone}] ${info.name}</strong>（${info.authority}）<br/>${info.description}`;
    hitList.appendChild(d);
  });
}

/**
 * 更新【2. 附近哪個方向、多遠有禁飛區？】並在地图標示最近邊界
 */
function renderNearbyInfo(report) {
  const { nearbyZones, fortressReport } = report;
  const quickEl = document.getElementById('txtQuickNearby');
  const detailBanner = document.getElementById('txtDetailNearestBanner');
  const listEl = document.getElementById('listDetailNearby');
  listEl.innerHTML = '';

  const combined = [];

  nearbyZones.forEach((z) => {
    combined.push({
      title: z.info.name,
      sub: `${z.info.colorZone}・${z.info.categoryLabel}`,
      distanceMeters: z.spatial.distanceMeters,
      compass: z.spatial.compass,
      nearestPoint: z.spatial.nearestPoint,
      severity: z.info.severity
    });
  });

  fortressReport.nearbyWithin5km.forEach((f) => {
    if (!f.inCore) {
      combined.push({
        title: `🪖 ${f.name}`,
        sub: `國防部要塞・${f.command}`,
        distanceMeters: f.distToCoreEdgeMeters,
        compass: f.compass,
        nearestPoint: { lat: f.lat, lng: f.lng },
        severity: 'fortress'
      });
    }
  });

  combined.sort((a, b) => a.distanceMeters - b.distanceMeters);

  // 優先抓最近的「紅區禁飛區或要塞」顯示在快速小卡
  const nearestRed = combined.find((c) => c.severity === 'prohibited' || c.severity === 'fortress') || combined[0];

  if (nearestRed) {
    const distShort =
      nearestRed.distanceMeters < 1000
        ? `${Math.round(nearestRed.distanceMeters)}m`
        : `${(nearestRed.distanceMeters / 1000).toFixed(1)}km`;
    quickEl.style.color = nearestRed.distanceMeters < 500 ? '#f87171' : '#fde047';
    quickEl.textContent = `${nearestRed.compass.arrow}${nearestRed.compass.short} ${distShort}`;
    detailBanner.textContent = `⚠️ 最近禁飛邊界在您的【${nearestRed.compass.name} ${nearestRed.compass.arrow}】約 ${formatDistance(nearestRed.distanceMeters)}（${nearestRed.title}）`;

    // 自動在地圖畫出指向最近禁飛區的藍色虛線，但不強制縮放地圖以免干擾瀏覽
    drawDirectionLine(nearestRed, false);
  } else {
    quickEl.style.color = '#34d399';
    quickEl.textContent = '5km內無禁飛';
    detailBanner.textContent = '✅ 周邊 5 公里內無其他禁飛區或要塞。';
  }

  combined.slice(0, 10).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'nearby-item-row';
    row.innerHTML = `
      <div>
        <div class="nb-title">${item.title}</div>
        <div class="nb-sub">${item.sub}</div>
      </div>
      <div class="nb-right">
        <span class="nb-dir">${item.compass.arrow} ${item.compass.name}</span>
        <span class="nb-dist">${formatDistance(item.distanceMeters)}</span>
      </div>
    `;
    row.addEventListener('click', () => {
      toggleSheet(false);
      drawDirectionLine(item, true);
    });
    listEl.appendChild(row);
  });
}

/**
 * 在地圖上畫出目前位置到目標禁飛區邊界的方向虛線
 */
function drawDirectionLine(item, fitAndPopup = true) {
  if (!state.map || !item.nearestPoint) return;
  if (state.vectorLine) state.map.removeLayer(state.vectorLine);

  const p1 = [state.lat, state.lng];
  const p2 = [item.nearestPoint.lat, item.nearestPoint.lng];

  state.vectorLine = L.polyline([p1, p2], {
    color: '#38bdf8',
    weight: 3,
    dashArray: '6, 6'
  })
    .addTo(state.map)
    .bindPopup(
      `<strong>🎯 最近管制區邊界</strong><br/>名稱：${item.title}<br/>方向：${item.compass.name}<br/>距離：${formatDistance(item.distanceMeters)}`
    );

  if (fitAndPopup) {
    state.vectorLine.openPopup();
    state.map.fitBounds(L.latLngBounds([p1, p2]).pad(0.35));
  }
}

/**
 * 更新【3. 是不是國家公園或商港？去哪申請？要提前幾天？】
 */
function renderParkPortInfo(report) {
  const quickEl = document.getElementById('txtQuickPark');
  const detailBox = document.getElementById('boxDetailParkPort');
  const { npHits, portHits, nearbyZones } = report;

  if (npHits.length > 0) {
    const r = npHits[0].info.npRule;
    quickEl.style.color = '#fb923c';
    quickEl.textContent = `${r.name.replace('國家公園', '')}・前${r.advanceDaysNum}天`;
    detailBox.innerHTML = `
      <div class="hit-box orange">
        <strong style="color:#fb923c;">🏞️ 位於【${r.name}】範圍內</strong><br/>
        <strong>提前天數：</strong><span style="color:#fde047;">${r.advanceDays}</span><br/>
        <strong>受理單位：</strong>${r.agency}（${r.phone}）<br/>
        <strong>注意事項：</strong>${r.specialNotes}<br/>
        <a href="${r.applyUrl}" target="_blank" rel="noopener" class="btn-link-cta">👉 點此前往 ${r.name} 線上申請</a>
      </div>
    `;
  } else if (portHits.length > 0) {
    const p = portHits[0].info;
    quickEl.style.color = '#f87171';
    quickEl.textContent = '商港區(玩家禁飛)';
    detailBox.innerHTML = `
      <div class="hit-box">
        <strong style="color:#f87171;">⚓ 位於【${p.name}】商港管制區</strong><br/>
        商港僅開放政府、學校或公司法人於 <strong>7 天前</strong>申請；<strong>一般個人玩家無法申請且嚴禁飛行</strong>（違者罰 30 萬～150 萬元）。
      </div>
    `;
  } else {
    const nearNp = nearbyZones.find((z) => z.info.layerType === 'national_park');
    const nearPort = nearbyZones.find((z) => z.info.layerType === 'port');
    quickEl.style.color = '#34d399';
    quickEl.textContent = '非國家公園/商港';
    detailBox.innerHTML = `
      <div class="hit-box" style="border-left-color:#10b981;">
        <strong style="color:#34d399;">✅ 目前不在國家公園或商港範圍內</strong><br/>
        ${nearNp ? `提醒：距離「${nearNp.info.name}」約 ${formatDistance(nearNp.spatial.distanceMeters)}（位於${nearNp.spatial.compass.name}，飛入需提前 7 天申請）。<br/>` : ''}
        ${nearPort ? `提醒：距離「${nearPort.info.name}」約 ${formatDistance(nearPort.spatial.distanceMeters)}（位於${nearPort.spatial.compass.name}，一般玩家勿飛入港區）。` : ''}
      </div>
    `;
  }
}

/**
 * 更新【4. 附近有沒有要塞／軍事營區（國防部 22 處要塞＋軍事營區條例）】
 */
function renderFortressInfo(report) {
  const quickEl = document.getElementById('txtQuickFortress');
  const detailBox = document.getElementById('boxDetailFortress');
  const nearest = report.fortressReport.nearest;
  const milHit = report.osmMilitaryHit;

  if (milHit) {
    const campName = milHit.info.name.replace('（軍事管制紅區）', '');
    quickEl.style.color = '#f87171';
    quickEl.textContent = `🚨 ${campName}`;
    detailBox.innerHTML = `
      <div class="hit-box purple">
        <strong style="color:#f87171;">🚨 位於【${campName}】軍事營區／訓練中心範圍內！</strong><br/>
        ${milHit.info.description}<br/>
        <span style="color:#fca5a5;">罰則：${milHit.info.penalty}</span>
      </div>
    `;
    return;
  }

  if (!nearest) return;

  if (nearest.inCore) {
    quickEl.style.color = '#f87171';
    quickEl.textContent = `🚨 ${nearest.name}`;
    detailBox.innerHTML = `
      <div class="hit-box purple">
        <strong style="color:#f87171;">🚨 位於【${nearest.name}】要塞核心區內！</strong><br/>
        管轄：${nearest.command}｜${nearest.warning}
      </div>
    `;
  } else if (nearest.inAlert) {
    quickEl.style.color = '#d8b4fe';
    quickEl.textContent = `⚠️ 近${nearest.name.replace('要塞', '')}`;
    detailBox.innerHTML = `
      <div class="hit-box purple">
        <strong style="color:#d8b4fe;">⚠️ 鄰近【${nearest.name}】（在${nearest.compass.name} ${formatDistance(nearest.distToCoreEdgeMeters)}）</strong><br/>
        ${nearest.warning}
      </div>
    `;
  } else {
    const km = (nearest.distToCoreEdgeMeters / 1000).toFixed(1);
    quickEl.style.color = '#34d399';
    quickEl.textContent = `安全 (最近${km}km)`;
    detailBox.innerHTML = `
      <div class="hit-box" style="border-left-color:#10b981;">
        <strong style="color:#34d399;">✅ 附近無軍事要塞</strong><br/>
        距離最近的要塞為「${nearest.name}」，在您的${nearest.compass.name} ${km} 公里外。
      </div>
    `;
  }
}

/**
 * 更新【5. 今天幾點日落】
 */
function renderSunInfo(sun) {
  const quickEl = document.getElementById('txtQuickSunset');
  const detailBox = document.getElementById('boxDetailSun');

  if (sun.statusLevel === 'safe') {
    quickEl.style.color = '#34d399';
    quickEl.textContent = `${sun.sunsetTime} (可飛)`;
  } else if (sun.statusLevel === 'warning') {
    quickEl.style.color = '#fbbf24';
    quickEl.textContent = `${sun.sunsetTime} (快日落)`;
  } else {
    quickEl.style.color = '#f87171';
    quickEl.textContent = `${sun.sunsetTime} (已日落)`;
  }

  detailBox.innerHTML = `
    <div>🌅 今日日出：<strong>${sun.sunriseTime}</strong> ｜ 🌇 今日日落：<strong style="color:#fbbf24;">${sun.sunsetTime}</strong></div>
    <div style="margin-top:4px;color:${sun.statusLevel === 'prohibited' ? '#f87171' : '#34d399'};font-weight:800;">
      ${sun.statusText}（${sun.countdownText}）
    </div>
  `;
}

/**
 * 初始化「國家公園申請」與「22 處要塞」清單
 */
function initDirectories() {
  document.getElementById('boxAllPortRule').innerHTML = `
    <strong style="color:#f87171;">⚓ 商港區域空拍規定（基隆港、高雄港、臺中港、花蓮港等）</strong><br/>
    須於活動日 <strong>7 天前</strong>申請，且<strong>僅限政府機關、學校或公司法人</strong>申請；一般個人玩家無法申請，違規可罰 30 萬～150 萬元。
  `;

  const parksEl = document.getElementById('listAllParks');
  Object.values(NATIONAL_PARK_RULES).forEach((np) => {
    const d = document.createElement('div');
    d.className = 'dir-item-card';
    d.innerHTML = `
      <div class="dir-item-head">
        <span>🏞️ ${np.name}</span>
        <span style="color:#fb923c;">提前 ${np.advanceDaysNum} 天</span>
      </div>
      <div><strong>提前天數：</strong><span style="color:#fde047;">${np.advanceDays}</span></div>
      <div><strong>受理機關：</strong>${np.agency}（${np.phone}）</div>
      <div style="color:#fca5a5;"><strong>注意：</strong>${np.specialNotes}</div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <a href="${np.applyUrl}" target="_blank" rel="noopener" class="btn-link-cta" style="margin-top:0;flex:1;">👉 線上申請網站</a>
        <button class="btn-jump-spot" style="margin-top:0;flex:1;" data-lat="${np.lat}" data-lng="${np.lng}" data-name="${np.name}" type="button">📍 看地圖位置</button>
      </div>
    `;
    parksEl.appendChild(d);
  });

  parksEl.querySelectorAll('.btn-jump-spot').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleSheet(false);
      runCoordinateCheck(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng), btn.dataset.name, true);
    });
  });

  renderFortressList('all');

  document.querySelectorAll('.fort-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.fort-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderFortressList(chip.dataset.region);
    });
  });
}

function renderFortressList(region) {
  const el = document.getElementById('listAllForts');
  el.innerHTML = '';

  FORTRESS_LIST.filter((f) => region === 'all' || f.region.includes(region)).forEach((f) => {
    const d = document.createElement('div');
    d.className = 'dir-item-card';
    d.innerHTML = `
      <div class="dir-item-head">
        <span>🪖 ${f.name}</span>
        <span style="color:#d8b4fe;">${f.county}</span>
      </div>
      <div><strong>管轄單位：</strong>${f.command}</div>
      <div><strong>涵蓋地標：</strong>${f.landmark}</div>
      <div style="color:#fca5a5;"><strong>警示：</strong>${f.warning}</div>
      <button class="btn-jump-spot" data-lat="${f.lat}" data-lng="${f.lng}" data-name="${f.name}" type="button">
        📍 在地圖查看 ${f.name} 範圍
      </button>
    `;
    el.appendChild(d);
  });

  el.querySelectorAll('.btn-jump-spot').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleSheet(false);
      runCoordinateCheck(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng), btn.dataset.name, true);
    });
  });
}

/**
 * 展開或收合底部抽屜卡
 */
function toggleSheet(expand) {
  state.sheetExpanded = typeof expand === 'boolean' ? expand : !state.sheetExpanded;
  const sheet = document.getElementById('bottomSheet');
  const btn = document.getElementById('btnToggleSheet');

  sheet.classList.toggle('expanded', state.sheetExpanded);
  if (btn) {
    btn.textContent = state.sheetExpanded ? '▼ 收合' : '▲ 詳情';
  }
}

function switchSheetTab(tabId) {
  document.querySelectorAll('.sheet-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });
  document.querySelectorAll('.sheet-tab-content').forEach((c) => {
    c.classList.toggle('active', c.id === tabId);
  });
}

/**
 * 綁定互動事件
 */
function bindEvents() {
  // 定位按鈕
  document.getElementById('btnLocateMe').addEventListener('click', () => {
    toggleSheet(false);
    if (state.isMobile) {
      locateByMobileGPS(false);
    } else {
      locateByComputerNetwork();
    }
  });

  // 回到目前位置
  document.getElementById('btnRecenterMap').addEventListener('click', () => {
    if (state.map) state.map.setView([state.lat, state.lng], 14);
  });

  // 展開／收合底部抽屜
  document.getElementById('btnToggleSheet').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet();
  });

  document.getElementById('sheetSummaryHeader').addEventListener('click', () => {
    toggleSheet();
  });

  document.getElementById('btnCollapseSheet').addEventListener('click', () => {
    toggleSheet(false);
  });

  // 點四格小卡直接打開對應分頁或在地圖標示最近禁飛區
  document.getElementById('pillNearbyZone').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.vectorLine && state.map) {
      toggleSheet(false);
      state.vectorLine.openPopup();
      state.map.fitBounds(state.vectorLine.getBounds().pad(0.35));
    } else {
      toggleSheet(true);
      switchSheetTab('tab-current');
    }
  });

  document.getElementById('pillPark').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet(true);
    switchSheetTab('tab-parks');
  });

  document.getElementById('pillFortress').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet(true);
    switchSheetTab('tab-forts');
  });

  // 抽屜內分頁按鈕
  document.querySelectorAll('.sheet-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchSheetTab(tab.dataset.tab));
  });

  // 輸入座標彈窗
  const modalCoord = document.getElementById('modalCoord');
  document.getElementById('btnInputCoord').addEventListener('click', () => {
    document.getElementById('inputLat').value = state.lat;
    document.getElementById('inputLng').value = state.lng;
    modalCoord.classList.remove('hidden');
  });
  document.getElementById('btnCloseCoord').addEventListener('click', () => {
    modalCoord.classList.add('hidden');
  });
  document.getElementById('inputPasteCoord').addEventListener('input', (e) => {
    const nums = e.target.value.split(/[,，\s]+/).filter(Boolean);
    if (nums.length >= 2) {
      const a = parseFloat(nums[0]);
      const b = parseFloat(nums[1]);
      if (!isNaN(a) && !isNaN(b)) {
        document.getElementById('inputLat').value = a;
        document.getElementById('inputLng').value = b;
      }
    }
  });
  document.getElementById('btnConfirmCoord').addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('inputLat').value);
    const lng = parseFloat(document.getElementById('inputLng').value);
    if (isNaN(lat) || isNaN(lng)) {
      showToast('請輸入正確的經緯度數字');
      return;
    }
    modalCoord.classList.add('hidden');
    toggleSheet(false);
    runCoordinateCheck(lat, lng, '手動輸入座標', true);
  });

  // 分享連結
  document.getElementById('btnShare').addEventListener('click', async () => {
    const url = `${window.location.origin}${window.location.pathname}?lat=${state.lat.toFixed(5)}&lng=${state.lng.toFixed(5)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: '空拍即查通｜空拍規定查詢', url });
        return;
      } catch (_) {}
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('✅ 已複製目前位置連結');
    } catch (_) {
      showToast(url);
    }
  });

  // 加到桌面教學彈窗
  const modalHome = document.getElementById('modalAddHome');
  document.getElementById('btnAddDesktop').addEventListener('click', () => {
    modalHome.classList.remove('hidden');
  });
  document.getElementById('btnCloseAddHome').addEventListener('click', () => {
    modalHome.classList.add('hidden');
  });
  document.getElementById('btnGotItAddHome').addEventListener('click', () => {
    modalHome.classList.add('hidden');
  });
  document.getElementById('btnDirectInstall').addEventListener('click', async () => {
    if (state.deferredPwaPrompt) {
      state.deferredPwaPrompt.prompt();
      await state.deferredPwaPrompt.userChoice;
      state.deferredPwaPrompt = null;
      modalHome.classList.add('hidden');
    }
  });
}

function showToast(msg) {
  const el = document.getElementById('toastMsg');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.classList.add('hidden');
  }, 3000);
}
