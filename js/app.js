/**
 * 空拍即查通 - 主應用程式控制器
 * 支援：電腦／筆電自動以連網位置定位、手機使用 GPS 定位、台灣白話直覺式介面
 */

import { VERSION_INFO } from './version.js';
import { FORTRESS_LIST, FORTRESS_LAW_INFO } from './data/fortresses.js';
import {
  NATIONAL_PARK_RULES,
  COMMERCIAL_PORT_RULE,
  PRESET_LOCATIONS
} from './data/regulations.js';
import { calculateSunTimes } from './utils/sun.js';
import { formatDistance } from './utils/geo.js';
import { inspectLocationAirspace } from './services/caaApi.js';

/**
 * 判斷目前是否為手機／行動裝置
 */
function detectMobilePhone() {
  const ua = navigator.userAgent || '';
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const isCoarseTouch =
    navigator.maxTouchPoints > 1 &&
    window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches &&
    window.innerWidth <= 900;
  return isMobileUA || isCoarseTouch;
}

const state = {
  isMobile: detectMobilePhone(),
  lat: 25.0338,
  lng: 121.5645,
  map: null,
  userMarker: null,
  scanRadiusCircle: null,
  vectorLine: null,
  airspaceLayerGroup: null,
  fortressLayerGroup: null,
  lastReport: null,
  deferredPwaPrompt: null
};

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('mode-check');
  initVersionControlUI();
  initServiceWorker();
  initDeviceModeUI();
  initMap();
  initPresetSpots();
  initSubPages();
  bindUIEvents();

  // 1. 優先檢查網址是否帶有分享的座標 (?lat=...&lng=...)
  const params = new URLSearchParams(window.location.search);
  const urlLat = parseFloat(params.get('lat'));
  const urlLng = parseFloat(params.get('lng'));

  if (!isNaN(urlLat) && !isNaN(urlLng) && urlLat >= 18 && urlLat <= 27 && urlLng >= 116 && urlLng <= 123) {
    runCoordinateCheck(urlLat, urlLng, '分享連結位置', false);
    return;
  }

  // 2. 根據裝置類型自動執行定位：
  //    - 電腦／筆電：直接以連上的網路（IP／Wi-Fi 網路定位）自動定位
  //    - 手機：呼叫手機 GPS 定位（若尚未授權則先載入預設點，點大按鈕立即啟動 GPS）
  if (state.isMobile) {
    triggerMobileGpsLocate(true);
  } else {
    triggerComputerNetworkLocate();
  }
});

/**
 * 初始化版本號顯示與更新紀錄對話框
 */
function initVersionControlUI() {
  const btnVer = document.getElementById('btnVersionInfo');
  const txtFooterVer = document.getElementById('txtFooterVersion');
  const modalVer = document.getElementById('modalVersion');
  const bodyEl = document.getElementById('versionChangelogBody');

  if (btnVer) btnVer.textContent = VERSION_INFO.version;
  if (txtFooterVer) {
    txtFooterVer.textContent = `版號：${VERSION_INFO.version} (${VERSION_INFO.buildDate})`;
  }

  if (bodyEl) {
    bodyEl.innerHTML = VERSION_INFO.changelog
      .map(
        (log) => `
        <div class="ver-block">
          <div class="ver-block-head">
            <span>版本 ${log.version}</span>
            <span style="color:#94a3b8;font-weight:600;">${log.date}</span>
          </div>
          <ul>
            ${log.items.map((item) => `<li>${item}</li>`).join('')}
          </ul>
        </div>
      `
      )
      .join('');
  }

  if (btnVer && modalVer) {
    btnVer.addEventListener('click', () => modalVer.classList.remove('hidden'));
  }

  const btnClose = document.getElementById('btnCloseVersion');
  if (btnClose && modalVer) {
    btnClose.addEventListener('click', () => modalVer.classList.add('hidden'));
  }

  const btnForce = document.getElementById('btnForceRefresh');
  if (btnForce) {
    btnForce.addEventListener('click', async () => {
      showToast('🔄 正在清除舊版快取並載入最新版...');
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) {
            await r.unregister();
          }
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          for (const k of keys) {
            await caches.delete(k);
          }
        }
      } catch (_) {}
      window.location.href = `${window.location.pathname}?t=${Date.now()}`;
    });
  }
}

/**
 * 註冊 Service Worker 並強制更新舊版快取
 */
function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.update();
      })
      .catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPwaPrompt = e;
    const btn = document.getElementById('btnDirectInstall');
    if (btn) btn.classList.remove('hidden');
  });
}

/**
 * 依據手機或電腦設定頂部提示與定位按鈕文字
 */
function initDeviceModeUI() {
  const modeText = document.getElementById('deviceModeText');
  const btnLabel = document.getElementById('btnLocateLabel');

  if (state.isMobile) {
    modeText.textContent = '📱 手機模式：使用手機 GPS 精準定位';
    btnLabel.textContent = '點我定位目前位置（手機 GPS）';
  } else {
    modeText.textContent = '💻 電腦／筆電模式：自動使用連網位置定位';
    btnLabel.textContent = '重新定位目前位置（電腦連網定位）';
  }
}

/**
 * 【電腦／筆電專用】以連上的網路自動定位
 * 結合瀏覽器網路定位與免權限 HTTPS IP 地理定位，確保電腦打開網頁必定能自動定位
 */
async function triggerComputerNetworkLocate() {
  const btnLabel = document.getElementById('btnLocateLabel');
  btnLabel.textContent = '正在以電腦連線網路定位中...';

  // 先嘗試快速 IP 連網定位（無須等待彈窗，0.3 秒內完成）
  let ipLocated = false;
  try {
    const res = await fetch('https://ipwho.is/');
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.latitude && data.longitude) {
        ipLocated = true;
        const cityLabel = data.city ? `電腦連網定位 (${data.city})` : '電腦連網定位';
        runCoordinateCheck(Number(data.latitude), Number(data.longitude), cityLabel, false);
      }
    }
  } catch (_) {}

  if (!ipLocated) {
    try {
      const res2 = await fetch('https://get.geojs.io/v1/ip/geo.json');
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2 && data2.latitude && data2.longitude) {
          ipLocated = true;
          runCoordinateCheck(Number(data2.latitude), Number(data2.longitude), '電腦連網定位', false);
        }
      }
    } catch (_) {}
  }

  // 若瀏覽器本身也支援 Wi-Fi 網路定位，同步用低耗電網路模式更新更精確的座標
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btnLabel.textContent = '重新定位目前位置（電腦連網定位）';
        runCoordinateCheck(pos.coords.latitude, pos.coords.longitude, '電腦 Wi-Fi／網路定位', false);
      },
      () => {
        btnLabel.textContent = '重新定位目前位置（電腦連網定位）';
        if (!ipLocated) {
          runCoordinateCheck(25.0338, 121.5645, '預設位置（台北）', false);
        }
      },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
    );
  } else {
    btnLabel.textContent = '重新定位目前位置（電腦連網定位）';
    if (!ipLocated) {
      runCoordinateCheck(25.0338, 121.5645, '預設位置（台北）', false);
    }
  }
}

/**
 * 【手機專用】使用手機硬體 GPS 衛星定位
 */
function triggerMobileGpsLocate(isAutoStart = false) {
  const btnLabel = document.getElementById('btnLocateLabel');

  if (!navigator.geolocation) {
    showToast('您的手機瀏覽器不支援定位功能');
    if (isAutoStart) runCoordinateCheck(25.0338, 121.5645, '預設位置', false);
    return;
  }

  btnLabel.textContent = '📡 正在讀取手機 GPS 位置...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      btnLabel.textContent = '點我重新定位（手機 GPS）';
      const errM = accuracy ? `（誤差約 ${Math.round(accuracy)} 公尺）` : '';
      showToast(`✅ 手機 GPS 定位成功${errM}`);
      runCoordinateCheck(latitude, longitude, `手機 GPS 定位${errM}`, true);
    },
    (err) => {
      // 若戶外衛星訊號較弱逾時，備援使用手機基地台定位
      navigator.geolocation.getCurrentPosition(
        (pos2) => {
          btnLabel.textContent = '點我重新定位（手機 GPS）';
          showToast('✅ 已透過手機訊號定位成功');
          runCoordinateCheck(pos2.coords.latitude, pos2.coords.longitude, '手機基地台定位', true);
        },
        () => {
          btnLabel.textContent = '點我定位目前位置（手機 GPS）';
          if (!isAutoStart) {
            if (err.code === 1) {
              showToast('⚠️ 請在手機瀏覽器允許「位置」權限才能定位喔！');
            } else {
              showToast('⚠️ 暫時收不到 GPS，請確認手機已開啟定位功能');
            }
          } else {
            // 初次開啟尚未點允許前，先顯示預設示範點避免畫面空白
            runCoordinateCheck(25.0338, 121.5645, '請按上方藍色按鈕啟動手機 GPS', false);
          }
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 30000 }
      );
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
}

/**
 * 初始化 Leaflet 地圖
 */
function initMap() {
  const map = L.map('mapContainer', {
    center: [state.lat, state.lng],
    zoom: 13,
    zoomControl: true
  });

  const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  });

  const satLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: '&copy; Esri 衛星圖'
    }
  );

  streetLayer.addTo(map);
  L.control.layers({ '一般地圖': streetLayer, '衛星空拍圖': satLayer }, null, {
    position: 'topleft'
  }).addTo(map);

  state.airspaceLayerGroup = L.layerGroup().addTo(map);
  state.fortressLayerGroup = L.layerGroup().addTo(map);

  renderFortressesOnMap();

  // 點地圖任意位置直接查詢該處空拍規定
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    showToast('📍 已切換至地圖點選位置');
    runCoordinateCheck(lat, lng, '地圖點選位置', true);
  });

  state.map = map;
}

/**
 * 繪製國防部 22 處要塞在地圖上
 */
function renderFortressesOnMap() {
  state.fortressLayerGroup.clearLayers();

  FORTRESS_LIST.forEach((fort) => {
    L.circle([fort.lat, fort.lng], {
      radius: fort.alertRadius,
      color: '#a855f7',
      weight: 1.5,
      dashArray: '6, 6',
      fillColor: '#a855f7',
      fillOpacity: 0.05
    })
      .bindPopup(
        `<strong>🪖 ${fort.name}（外圍注意範圍）</strong><br/>管理單位：${fort.command}<br/>位置：${fort.landmark}<br/><span style="color:#f87171;">${fort.warning}</span>`
      )
      .addTo(state.fortressLayerGroup);

    L.circle([fort.lat, fort.lng], {
      radius: fort.coreRadius,
      color: '#d946ef',
      weight: 2.5,
      fillColor: '#a855f7',
      fillOpacity: 0.28
    })
      .bindPopup(
        `<strong>🚨 【要塞禁飛核心】${fort.name}</strong><br/>行政區：${fort.county}<br/>管理單位：${fort.command}<br/><span style="color:#ef4444;font-weight:bold;">依《要塞堡壘地帶法》嚴禁空拍與攝影！</span>`
      )
      .addTo(state.fortressLayerGroup);
  });
}

/**
 * 初始化快速切換地點選單
 */
function initPresetSpots() {
  const sel = document.getElementById('selectPresetSpot');
  PRESET_LOCATIONS.forEach((spot, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `📍 ${spot.name}`;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10);
    if (!isNaN(idx) && PRESET_LOCATIONS[idx]) {
      const s = PRESET_LOCATIONS[idx];
      runCoordinateCheck(s.lat, s.lng, s.name, true);
    }
  });
}

/**
 * 執行座標空拍規定完整查詢與畫面更新
 */
async function runCoordinateCheck(lat, lng, label = '目前定位', updateUrl = true) {
  state.lat = Number(lat.toFixed(6));
  state.lng = Number(lng.toFixed(6));

  document.getElementById('txtCoordInfo').textContent = `📍 ${label} (${state.lat.toFixed(4)}, ${state.lng.toFixed(4)})`;

  if (updateUrl) {
    const nextUrl = `${window.location.pathname}?lat=${state.lat.toFixed(5)}&lng=${state.lng.toFixed(5)}`;
    window.history.replaceState({ path: nextUrl }, '', nextUrl);
  }

  updateMapPin(state.lat, state.lng);

  // 1. 立即更新「今天幾點日落」
  renderSunsetBox(state.lat, state.lng);

  // 2. 查詢民航局圖資與 22 處要塞
  const statusEl = document.getElementById('txtDataStatus');
  statusEl.textContent = '讀取民航局圖資中...';

  const report = await inspectLocationAirspace(state.lat, state.lng, 5000);
  state.lastReport = report;

  statusEl.textContent = report.isOnline ? '✅ 民航局即時圖資' : '⚠️ 離線備援圖資';

  // 更新地圖多邊形與五大重點卡片
  renderMapPolygons(report.allAnalyzedFeatures);
  renderMainVerdict(report);
  renderFortressBox(report);
  renderParkAndPortBox(report);
  renderNearbyDirectionList(report);
}

/**
 * 更新地圖大頭針
 */
function updateMapPin(lat, lng) {
  if (!state.map) return;

  if (state.userMarker) state.map.removeLayer(state.userMarker);
  if (state.scanRadiusCircle) state.map.removeLayer(state.scanRadiusCircle);
  if (state.vectorLine) state.map.removeLayer(state.vectorLine);

  const pinIcon = L.divIcon({
    className: 'user-pin',
    html: `<div style="width:22px;height:22px;background:#0ea5e9;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(2,132,199,0.9);"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  state.userMarker = L.marker([lat, lng], { icon: pinIcon })
    .addTo(state.map)
    .bindPopup(`<strong>📍 目前查詢位置</strong><br/>${lat.toFixed(5)}, ${lng.toFixed(5)}`);

  state.scanRadiusCircle = L.circle([lat, lng], {
    radius: 5000,
    color: '#38bdf8',
    weight: 1,
    dashArray: '4, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.02,
    interactive: false
  }).addTo(state.map);

  state.map.setView([lat, lng], 14);
}

/**
 * 繪製地圖上的禁限航區、國家公園、商港多邊形
 */
function renderMapPolygons(features) {
  state.airspaceLayerGroup.clearLayers();
  if (!features) return;

  features.forEach((item) => {
    const { feature, info, spatial } = item;
    let color = '#ef4444';
    let fillOpacity = 0.22;

    if (info.severity === 'restricted_60m' || info.severity === 'conditional_yellow') {
      color = '#f59e0b';
      fillOpacity = 0.16;
    } else if (info.layerType === 'national_park' || info.layerType === 'port') {
      color = '#f97316';
      fillOpacity = 0.18;
    }

    const posNote = spatial.inside
      ? '<span style="color:#ef4444;font-weight:bold;">您目前在這個區域內</span>'
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
        `<div style="font-size:13px;line-height:1.5;">
          <strong>[${info.colorZone}] ${info.name}</strong><br/>
          <span>位置：${posNote}</span><br/>
          <span>管理單位：${info.authority}</span><br/>
          <hr style="margin:5px 0;border:0;border-top:1px solid #cbd5e1;"/>
          <div style="max-height:110px;overflow-y:auto;font-size:12px;">${(info.description || '').replace(/\n/g, '<br/>')}</div>
        </div>`
      )
      .addTo(state.airspaceLayerGroup);
  });
}

/**
 * 渲染【重點 1：這裡能不能飛？最高飛多高？】（使用最清楚的台灣白話）
 */
function renderMainVerdict(report) {
  const { overallVerdict, activeZonesHere, fortressReport } = report;
  const hero = document.getElementById('heroVerdictCard');
  hero.className = `summary-hero hero-${overallVerdict.statusCode}`;

  const badgeEl = document.getElementById('txtZoneBadge');
  const titleEl = document.getElementById('txtMainVerdict');
  const descEl = document.getElementById('txtVerdictDesc');
  const heightNumEl = document.getElementById('txtHeightLimit');
  const heightSubEl = document.getElementById('txtHeightFeet');

  // 同步更新地圖底部浮動條
  const mapBarBadge = document.getElementById('mapBarBadge');
  const mapBarTitle = document.getElementById('mapBarTitle');

  if (overallVerdict.statusCode === 'GREEN_SAFE') {
    badgeEl.textContent = '🟢 綠區・正常可飛';
    titleEl.textContent = '這裡可以飛！最高 120 公尺';
    descEl.textContent = '目前位置不在禁飛區、國家公園或軍事要塞內。請注意保持目視範圍，並在日落前降落。';
    heightNumEl.textContent = '120m';
    heightSubEl.textContent = '約 400 呎';

    mapBarBadge.style.background = '#10b981';
    mapBarBadge.style.color = '#042f2e';
    mapBarBadge.textContent = '可飛 120m';
    mapBarTitle.textContent = '綠區：這裡可以合法起飛';
  } else if (overallVerdict.statusCode === 'YELLOW_60M') {
    badgeEl.textContent = '🟡 黃區・注意高度限制';
    titleEl.textContent = '可以飛，但最高只能飛 60 公尺！';
    descEl.textContent = overallVerdict.subHeadline;
    heightNumEl.textContent = '60m';
    heightSubEl.textContent = '機場周邊 200 呎';

    mapBarBadge.style.background = '#f59e0b';
    mapBarBadge.style.color = '#1e1b4b';
    mapBarBadge.textContent = '限高 60m';
    mapBarTitle.textContent = '黃區：最高只能飛 60 公尺';
  } else if (overallVerdict.statusCode === 'ORANGE_RESTRICTED') {
    badgeEl.textContent = '🟠 管制區・需先確認或申請';
    titleEl.textContent = `要先申請才能飛！（核准後限高 ${overallVerdict.maxAltitudeMeters}m）`;
    descEl.textContent = overallVerdict.subHeadline;
    heightNumEl.textContent = `${overallVerdict.maxAltitudeMeters}m`;
    heightSubEl.textContent = '需先獲准';

    mapBarBadge.style.background = '#f97316';
    mapBarBadge.style.color = '#fff';
    mapBarBadge.textContent = '需先申請';
    mapBarTitle.textContent = overallVerdict.reasons.join('、');
  } else {
    badgeEl.textContent = '🔴 紅區・禁止起飛';
    titleEl.textContent = '這裡不能飛！（禁飛區）';
    descEl.textContent = overallVerdict.subHeadline;
    heightNumEl.textContent = '0m';
    heightSubEl.textContent = '全面禁飛';

    mapBarBadge.style.background = '#ef4444';
    mapBarBadge.style.color = '#fff';
    mapBarBadge.textContent = '禁止起飛';
    mapBarTitle.textContent = overallVerdict.reasons.join('、');
  }

  // 列出所在地點重疊的具體管制項目
  const wrap = document.getElementById('hitZonesList');
  wrap.innerHTML = '';

  if (fortressReport.nearest && fortressReport.nearest.inCore) {
    const f = fortressReport.nearest;
    const d = document.createElement('div');
    d.className = 'hit-tag-card tag-purple';
    d.innerHTML = `<strong>🪖 位於國防部公告要塞：${f.name}</strong><br/>${f.warning}`;
    wrap.appendChild(d);
  }

  activeZonesHere.forEach((item) => {
    const { info } = item;
    let cls = '';
    if (info.severity === 'restricted_60m' || info.severity === 'conditional_yellow') cls = 'tag-yellow';
    if (info.layerType === 'national_park' || info.layerType === 'port') cls = 'tag-orange';

    const d = document.createElement('div');
    d.className = `hit-tag-card ${cls}`;
    d.innerHTML = `
      <strong>[${info.colorZone}] ${info.name}</strong>（管理機關：${info.authority}）<br/>
      <span style="color:#cbd5e1;">${info.description}</span>
    `;
    wrap.appendChild(d);
  });
}

/**
 * 渲染【重點 2：今天幾點日落（日落後不能飛）】
 */
function renderSunsetBox(lat, lng) {
  const sun = calculateSunTimes(lat, lng, new Date());

  document.getElementById('txtSunsetVal').textContent = `${sun.sunsetTime} 日落`;
  document.getElementById('txtSunriseCaption').textContent = `今日日出 ${sun.sunriseTime}（日出後～日落前可飛）`;

  const pill = document.getElementById('txtSunRemainBadge');
  if (sun.statusLevel === 'safe') {
    const hrs = Math.floor(sun.minutesToSunset / 60);
    const mins = sun.minutesToSunset % 60;
    pill.className = 'sun-status-pill sun-ok';
    pill.innerHTML = `☀️ 現在是白天<br/>還可飛 ${hrs > 0 ? hrs + ' 小時 ' : ''}${mins} 分`;
  } else if (sun.statusLevel === 'warning') {
    pill.className = 'sun-status-pill sun-soon';
    pill.innerHTML = `⚠️ 快日落了！<br/>剩 ${sun.minutesToSunset} 分鐘請準備降落`;
  } else {
    pill.className = 'sun-status-pill sun-night';
    pill.innerHTML = `🌙 目前已日落<br/>夜間禁止空拍飛行`;
  }
}

/**
 * 渲染【重點 3：附近有沒有要塞（國防部 22 處要塞）】
 */
function renderFortressBox(report) {
  const box = document.getElementById('boxFortressQuick');
  const nearest = report.fortressReport.nearest;
  if (!nearest) return;

  if (nearest.inCore) {
    box.innerHTML = `
      <div class="highlight-alert danger">
        <strong style="color:#f87171;font-size:1rem;">🚨 您正位於「${nearest.name}」管制範圍內！</strong>
        <p style="margin-top:4px;">管理單位：${nearest.command}（${nearest.county}）</p>
        <p style="color:#fca5a5;margin-top:4px;">${nearest.warning}</p>
      </div>
    `;
  } else if (nearest.inAlert) {
    box.innerHTML = `
      <div class="highlight-alert fort">
        <strong style="color:#d8b4fe;font-size:0.98rem;">⚠️ 很靠近要塞！「${nearest.name}」在您的${nearest.compass.name} ${formatDistance(nearest.distToCoreEdgeMeters)}</strong>
        <p style="margin-top:4px;">涵蓋地標：${nearest.landmark}</p>
        <p style="color:#fca5a5;margin-top:4px;">提醒：空拍鏡頭切勿朝向軍事營區、雷達站或陣地拍攝，以免觸犯《要塞堡壘地帶法》。</p>
      </div>
    `;
  } else {
    box.innerHTML = `
      <div class="highlight-alert">
        <strong style="color:#34d399;">✅ 附近沒有軍事要塞</strong>
        <p style="margin-top:4px;">距離最近的要塞是「<strong>${nearest.name}</strong>」，在您的<strong>${nearest.compass.name} ${(nearest.distToCoreEdgeMeters / 1000).toFixed(1)} 公里</strong>外，可以放心。</p>
      </div>
    `;
  }
}

/**
 * 渲染【重點 4：是不是國家公園或商港？去哪申請？要提前幾天？】
 */
function renderParkAndPortBox(report) {
  const box = document.getElementById('boxParkPortQuick');
  const { npHits, portHits, nearbyZones } = report;

  const nearbyNp = nearbyZones.filter((z) => z.info.layerType === 'national_park');
  const nearbyPort = nearbyZones.filter((z) => z.info.layerType === 'port');

  let html = '';

  if (npHits.length > 0) {
    npHits.forEach((hit) => {
      const r = hit.info.npRule;
      html += `
        <div class="highlight-alert warn">
          <strong style="color:#fb923c;font-size:1.02rem;">🏞️ 是！這裡是【${r.name}】</strong>
          <p style="margin-top:6px;"><strong>📅 要提前幾天申請：</strong><span style="color:#fde047;font-weight:800;">${r.advanceDays}</span></p>
          <p><strong>🏢 申請單位：</strong>${r.agency}（電話：${r.phone}）</p>
          <p><strong>📄 準備資料：</strong>${r.requiredDocs}</p>
          <p style="color:#fca5a5;margin-top:4px;"><strong>⚠️ 注意：</strong>${r.specialNotes}</p>
          <a href="${r.applyUrl}" target="_blank" rel="noopener" class="btn-action-link">
            👉 點這裡去 ${r.name} 網站線上申請
          </a>
        </div>
      `;
    });
  } else {
    html += `
      <div class="highlight-alert">
        <strong style="color:#34d399;">✅ 這裡不是國家公園（不用向國家公園申請）</strong>
        <p style="margin-top:4px;">
          ${
            nearbyNp.length > 0
              ? `提醒：距離最近的「${nearbyNp[0].info.name}」邊界在您的<strong>${nearbyNp[0].spatial.compass.name} ${formatDistance(nearbyNp[0].spatial.distanceMeters)}</strong>，不要飛進去喔（飛進去需提前 7 天申請）。`
              : '周邊 5 公里內都沒有國家公園管制區。'
          }
        </p>
      </div>
    `;
  }

  if (portHits.length > 0) {
    const p = portHits[0].info;
    html += `
      <div class="highlight-alert danger">
        <strong style="color:#f87171;font-size:1.02rem;">⚓ 注意！這裡是【${p.name}】商港管制區</strong>
        <p style="margin-top:6px;color:#fca5a5;"><strong>🚫 一般玩家不能申請：</strong>商港規定只有「政府機關、學校或公司法人」才能在 <strong>7 天前</strong>申請；一般個人空拍玩家不能飛，擅自起飛會重罰 30 萬～150 萬元！</p>
      </div>
    `;
  } else if (nearbyPort.length > 0) {
    html += `
      <div class="highlight-alert warn">
        <strong style="color:#fbbf24;">⚓ 小心靠近商港：「${nearbyPort[0].info.name}」在您的${nearbyPort[0].spatial.compass.name} ${formatDistance(nearbyPort[0].spatial.distanceMeters)}</strong>
        <p style="margin-top:4px;">商港範圍一般玩家無法申請進入，飛行時請勿往港區方向飛。</p>
      </div>
    `;
  }

  box.innerHTML = html;
}

/**
 * 渲染【重點 5：附近哪個方向、多遠有禁飛區？】
 */
function renderNearbyDirectionList(report) {
  const { activeZonesHere, nearbyZones, fortressReport } = report;
  const banner = document.getElementById('txtNearestAlert');
  const listEl = document.getElementById('listNearbyZones');
  listEl.innerHTML = '';

  const combined = [];

  nearbyZones.forEach((z) => {
    combined.push({
      title: z.info.name,
      sub: `${z.info.colorZone}・${z.info.categoryLabel}`,
      distanceMeters: z.spatial.distanceMeters,
      compass: z.spatial.compass,
      nearestPoint: z.spatial.nearestPoint
    });
  });

  fortressReport.nearbyWithin5km.forEach((f) => {
    if (!f.inCore) {
      combined.push({
        title: `🪖 ${f.name}（軍事要塞）`,
        sub: `國防部要塞・${f.command}`,
        distanceMeters: f.distToCoreEdgeMeters,
        compass: f.compass,
        nearestPoint: { lat: f.lat, lng: f.lng }
      });
    }
  });

  combined.sort((a, b) => a.distanceMeters - b.distanceMeters);

  if (activeZonesHere.length > 0 || (fortressReport.nearest && fortressReport.nearest.inCore)) {
    banner.style.borderColor = '#ef4444';
    banner.style.color = '#fca5a5';
    banner.textContent = `🚨 您現在的位置已經在管制區裡面了！另外周邊還有 ${combined.length} 個禁限航區：`;
  } else if (combined.length > 0) {
    const first = combined[0];
    banner.style.borderColor = '#f59e0b';
    banner.style.color = '#fde68a';
    banner.textContent = `⚠️ 離您最近的禁飛／管制區在【${first.compass.name} ${first.compass.arrow}】約 ${formatDistance(first.distanceMeters)}（${first.title}）`;
  } else {
    banner.style.borderColor = '#10b981';
    banner.style.color = '#6ee7b7';
    banner.textContent = '✅ 方圓 5 公里內完全沒有禁飛區或要塞，空域非常乾淨！';
  }

  combined.slice(0, 10).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'nearby-row';
    row.innerHTML = `
      <div>
        <div class="nearby-name">${item.title}</div>
        <div class="nearby-type">${item.sub}</div>
      </div>
      <div class="nearby-dir-box">
        <span class="compass-pill">${item.compass.arrow} ${item.compass.name}</span>
        <span class="dist-num">${formatDistance(item.distanceMeters)}</span>
      </div>
    `;

    row.addEventListener('click', () => {
      switchView('view-map');
      showDirectionLineOnMap(item);
    });

    listEl.appendChild(row);
  });
}

/**
 * 在地圖上畫出目前位置到禁飛區最近邊界的方向線
 */
function showDirectionLineOnMap(item) {
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
      `<strong>🎯 ${item.title}</strong><br/>方向：在您的${item.compass.name}<br/>最短邊界距離：${formatDistance(item.distanceMeters)}`
    )
    .openPopup();

  state.map.fitBounds(L.latLngBounds([p1, p2]).pad(0.35));
}

/**
 * 初始化「國家公園申請」與「22 處要塞」子頁面
 */
function initSubPages() {
  const portBox = document.getElementById('boxPortRuleFull');
  portBox.innerHTML = `
    <h3 style="color:#fca5a5;margin-bottom:6px;">⚓ 商港區域空拍規定（基隆港、高雄港、臺中港、花蓮港等）</h3>
    <p><strong>要提前幾天：</strong><span style="color:#fde047;font-weight:800;">至少 7 天前</span></p>
    <p><strong>誰可以申請：</strong>只開放「政府機關、學校或公司法人」因公務或研究申請；<strong>一般個人玩家不能申請、也不能飛！</strong></p>
    <p><strong>違規罰則：</strong>擅自在商港空拍可處 30 萬～150 萬元罰鍰並沒收空拍機。</p>
  `;

  const parksGrid = document.getElementById('gridAllParks');
  Object.values(NATIONAL_PARK_RULES).forEach((np) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div>
        <div class="item-card-head">
          <span class="item-card-title">🏞️ ${np.name}</span>
          <span class="item-card-badge">提前 ${np.advanceDaysNum} 天</span>
        </div>
        <div class="item-card-body" style="margin-top:8px;">
          <div><strong>📅 提前天數：</strong><span style="color:#fde047;">${np.advanceDays}</span></div>
          <div><strong>🏢 申請單位：</strong>${np.agency}</div>
          <div><strong>📞 聯絡電話：</strong>${np.phone}</div>
          <div><strong>📄 必備文件：</strong>${np.requiredDocs}</div>
          <div style="color:#fca5a5;"><strong>⚠️ 注意事項：</strong>${np.specialNotes}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <a href="${np.applyUrl}" target="_blank" rel="noopener" class="btn-action-link" style="margin-top:0;flex:1;">👉 線上申請網站</a>
        <button class="btn-card-locate" style="flex:1;" data-lat="${np.lat}" data-lng="${np.lng}" data-name="${np.name}" type="button">📍 看此處規定</button>
      </div>
    `;
    parksGrid.appendChild(card);
  });

  parksGrid.querySelectorAll('.btn-card-locate').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView('view-check');
      runCoordinateCheck(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng), btn.dataset.name, true);
    });
  });

  renderFortressCards('all');

  document.querySelectorAll('.region-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.region-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderFortressCards(chip.dataset.region);
    });
  });
}

function renderFortressCards(region) {
  const grid = document.getElementById('gridAllFortresses');
  grid.innerHTML = '';

  const list = FORTRESS_LIST.filter((f) => region === 'all' || f.region.includes(region));

  list.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div>
        <div class="item-card-head">
          <span class="item-card-title">🪖 ${f.name}</span>
          <span class="item-card-badge" style="background:rgba(168,85,247,0.2);color:#d8b4fe;">${f.region}</span>
        </div>
        <div class="item-card-body" style="margin-top:8px;">
          <div><strong>📍 所在地區：</strong>${f.county}</div>
          <div><strong>🛡️ 管轄單位：</strong>${f.command}</div>
          <div><strong>🗺️ 附近地標：</strong>${f.landmark}</div>
          <div style="color:#fca5a5;"><strong>⚠️ 空拍提醒：</strong>${f.warning}</div>
        </div>
      </div>
      <button class="btn-card-locate" data-lat="${f.lat}" data-lng="${f.lng}" data-name="${f.name}" type="button">
        📍 切換到這個要塞位置查看
      </button>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.btn-card-locate').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView('view-check');
      runCoordinateCheck(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng), btn.dataset.name, true);
    });
  });
}

/**
 * 切換手機底部導航分頁
 */
function switchView(viewId) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === viewId);
  });

  document.body.className = '';
  if (viewId === 'view-check') document.body.classList.add('mode-check');
  if (viewId === 'view-map') document.body.classList.add('mode-map');
  if (viewId === 'view-parks') document.body.classList.add('mode-parks');
  if (viewId === 'view-fortresses') document.body.classList.add('mode-fortresses');

  if (state.map && (viewId === 'view-map' || viewId === 'view-check')) {
    setTimeout(() => {
      state.map.invalidateSize();
    }, 100);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * 綁定所有按鈕事件
 */
function bindUIEvents() {
  // 底部導航列切換
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // 主定位按鈕：手機走 GPS、電腦走連網定位
  document.getElementById('btnLocateNow').addEventListener('click', () => {
    if (state.isMobile) {
      triggerMobileGpsLocate(false);
    } else {
      triggerComputerNetworkLocate();
    }
  });

  // 手機快速切換看地圖與返回詳細規定
  document.getElementById('btnJumpMap').addEventListener('click', () => switchView('view-map'));
  document.getElementById('btnMapToDetail').addEventListener('click', () => switchView('view-check'));
  document.getElementById('btnMapBackToMe').addEventListener('click', () => {
    if (state.map) state.map.setView([state.lat, state.lng], 14);
  });

  // 手動輸入座標彈窗
  const modalCoord = document.getElementById('modalCoord');
  document.getElementById('btnOpenCoordModal').addEventListener('click', () => {
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
    runCoordinateCheck(lat, lng, '手動輸入座標', true);
  });

  // 分享目前位置連結
  document.getElementById('btnShareLink').addEventListener('click', async () => {
    const url = `${window.location.origin}${window.location.pathname}?lat=${state.lat.toFixed(5)}&lng=${state.lng.toFixed(5)}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: '空拍即查通｜現場空拍規定查詢',
          url
        });
        return;
      } catch (_) {}
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('✅ 已複製目前位置連結！可直接貼給朋友');
    } catch (_) {
      showToast(`連結：${url}`);
    }
  });

  // 加到主畫面教學彈窗
  const modalHome = document.getElementById('modalAddHome');
  document.getElementById('btnAddHome').addEventListener('click', () => {
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
  }, 3200);
}
