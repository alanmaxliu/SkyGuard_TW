/**
 * 民航局 (CAA) Drone GIS 即時空域圖資查詢與綜合空拍法規判定服務
 * 串接端點：https://dronegis.caa.gov.tw/server/rest/services/Hosted/
 */

import { FORTRESS_LIST, FORTRESS_LAW_INFO } from '../data/fortresses.js';
import { NATIONAL_PARK_RULES, COMMERCIAL_PORT_RULE, GENERAL_CAA_RULES } from '../data/regulations.js';
import {
  haversineDistance,
  calculateBearing,
  bearingToCompass,
  analyzePointToGeometry
} from '../utils/geo.js';

const CAA_BASE_URL = 'https://dronegis.caa.gov.tw/server/rest/services/Hosted';

const ENDPOINTS = {
  restrictedAirspace: `${CAA_BASE_URL}/UAV_fs/FeatureServer/3/query`,
  temporaryArea: `${CAA_BASE_URL}/Temporary_Area/FeatureServer/19/query`,
  nationalPark: `${CAA_BASE_URL}/National_Park_fs/FeatureServer/0/query`,
  commercialPort: `${CAA_BASE_URL}/Commercial_Port_fs/FeatureServer/4/query`
};

/**
 * 向 ArcGIS FeatureServer 查詢指定座標半徑內之 GeoJSON 圖徵
 */
async function queryArcGISRadius(endpointUrl, lat, lng, radiusMeters = 5000, timeoutMs = 8000) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(radiusMeters),
    units: 'esriSRUnit_Meter',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${endpointUrl}?${params.toString()}`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return data.features || [];
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[CAA API] 查詢失敗 (${endpointUrl}):`, err.message);
    return null; // 回傳 null 代表網路或端點異常
  }
}

/**
 * 解析單一民航局空域圖徵之風險等級與限高
 */
function classifyAirspaceFeature(feature, layerType) {
  const props = feature.properties || {};

  if (layerType === 'temporary') {
    return {
      layerType: 'temporary',
      categoryLabel: '臨時禁飛區 (NOTAM)',
      name: props['空域名稱'] || '臨時活動管制空域',
      colorZone: '紅區',
      severity: 'prohibited', // prohibited | restricted_60m | apply_required
      maxAltitudeMeters: 0,
      maxAltitudeFeet: 0,
      authority: props['主管機關名稱'] || props['會商機關名稱'] || '地方政府／民航局',
      contact: props['聯絡方式'] || '請洽民航局或公告機關',
      description: props['空域說明'] || '臨時公告禁止遙控無人機飛航活動區域',
      effectiveDate: `${props['有效日期起'] || '即日起'} ～ ${props['有效日期迄'] || '依公告'}`,
      penalty: props['罰則'] || '罰款 3 萬 - 15 萬元，得沒入遙控無人機'
    };
  }

  if (layerType === 'port') {
    const cond = props['條件'] || '管制';
    const isProhibited = cond.includes('禁止');
    return {
      layerType: 'port',
      categoryLabel: `商港區域（${cond}）`,
      name: props['名稱'] || props['name'] || '商港管制區',
      colorZone: isProhibited ? '紅區' : '橙區',
      severity: isProhibited ? 'prohibited' : 'port_restricted',
      maxAltitudeMeters: 0,
      maxAltitudeFeet: 0,
      authority: `${props['所在地_應公告之地方政府_'] || '交通部航港局'} / ${props['管理_及會商_機關'] || '臺灣港務股份有限公司'}`,
      contact: props['管理_及會商_機關聯絡方式'] || '臺灣港務股份有限公司各分公司',
      description: `${props['說明'] || '商港區域特定範圍'}。${COMMERCIAL_PORT_RULE.eligibility}`,
      advanceDays: COMMERCIAL_PORT_RULE.advanceDays,
      penalty: COMMERCIAL_PORT_RULE.penalty
    };
  }

  if (layerType === 'national_park') {
    const npName = props['name_full'] || '國家公園範圍';
    const rule = NATIONAL_PARK_RULES[npName] || {
      name: npName,
      agency: '內政部國家公園署各管理處',
      advanceDays: '拍攝日前 7 天提出申請',
      advanceDaysNum: 7,
      method: '線上申辦系統申請',
      applyUrl: props['相關規'] || 'https://www.nps.gov.tw/',
      phone: '請見國家公園官網',
      requiredDocs: '空拍申請書、拍攝計畫書',
      specialNotes: '國家公園區域內須事先申請核准始得空拍。'
    };
    return {
      layerType: 'national_park',
      categoryLabel: '國家公園管制區',
      name: npName,
      colorZone: '橙區（需申請）',
      severity: 'np_apply_required',
      maxAltitudeMeters: 120,
      maxAltitudeFeet: 400,
      authority: rule.agency,
      contact: rule.phone,
      description: `需於${rule.advanceDays}。${rule.specialNotes}`,
      npRule: {
        ...rule,
        officialRuleUrl: props['相關規'] || rule.applyUrl
      }
    };
  }

  // 主空域 (uav_restricted_airspace)
  const color = props['空域顏色'] || props['限制區'] || '';
  const condition = props['條件'] || '';
  const categoryName = props['空域類別名稱'] || '';
  const desc = props['空域說明'] || '';
  const name = props['空域名稱'] || categoryName || '管制空域';

  // 判斷是否為機場四周 200 呎 (60m) 限高黃區
  const isAirport200ft =
    categoryName.includes('200呎') ||
    desc.includes('200呎') ||
    name.includes('200呎') ||
    (color === '黃區' && categoryName.includes('機場'));

  if (color === '紅區' || condition === '禁止' || categoryName.includes('禁航區') || categoryName.includes('一定距離')) {
    return {
      layerType: 'airspace',
      categoryLabel: categoryName || '禁限航區（紅區）',
      name,
      colorZone: '紅區',
      severity: 'prohibited',
      maxAltitudeMeters: 0,
      maxAltitudeFeet: 0,
      authority: props['主管機關名稱'] || props['會商機關名稱'] || '交通部民航局／國防部',
      contact: props['聯絡方式'] || '交通部民用航空局',
      description: desc || '本區域全面禁止遙控無人機飛航活動。',
      penalty: props['罰則'] || '罰款 30 萬 - 150 萬元，並沒入遙控無人機'
    };
  }

  if (isAirport200ft) {
    return {
      layerType: 'airspace',
      categoryLabel: '機場四周限高區（黃區）',
      name,
      colorZone: '黃區（限高 60m）',
      severity: 'restricted_60m',
      maxAltitudeMeters: 60,
      maxAltitudeFeet: 200,
      authority: props['主管機關名稱'] || '交通部民用航空局',
      contact: props['聯絡方式'] || '交通部民用航空局',
      description: desc || '機場四周距地面或水面 200 呎（約 60 公尺）以下有條件開放施放；超過 200 呎禁止施放。',
      penalty: props['罰則'] || '逾越限高罰款 30 萬 - 150 萬元，並沒入遙控無人機'
    };
  }

  // 縣市政府公告黃區／有條件開放區
  return {
    layerType: 'airspace',
    categoryLabel: categoryName || '有條件限制區（黃區）',
    name,
    colorZone: '黃區（有條件限制）',
    severity: 'conditional_yellow',
    maxAltitudeMeters: 120,
    maxAltitudeFeet: 400,
    authority: props['主管機關名稱'] || props['會商機關名稱'] || '地方政府',
    contact: props['聯絡方式'] || '各縣市政府主管機關',
    description: desc || '有條件開放（如假日禁飛或須事先申請同意），請詳閱空域說明。',
    penalty: props['罰則'] || '罰款 3 萬 - 15 萬元，得沒入遙控無人機'
  };
}

/**
 * 檢查國防部公告 22 處要塞堡壘地帶距離與方位
 */
export function evaluateFortresses(lat, lng) {
  const evaluated = FORTRESS_LIST.map((fort) => {
    const centerDist = haversineDistance(lat, lng, fort.lat, fort.lng);
    const distToCoreEdge = Math.max(0, centerDist - fort.coreRadius);
    const distToAlertEdge = Math.max(0, centerDist - fort.alertRadius);
    const bearing = calculateBearing(lat, lng, fort.lat, fort.lng);
    const compass = bearingToCompass(bearing);

    const inCore = centerDist <= fort.coreRadius;
    const inAlert = !inCore && centerDist <= fort.alertRadius;

    return {
      ...fort,
      centerDistMeters: centerDist,
      distToCoreEdgeMeters: distToCoreEdge,
      distToAlertEdgeMeters: distToAlertEdge,
      bearing,
      compass,
      inCore,
      inAlert,
      status: inCore ? 'IN_CORE' : inAlert ? 'IN_ALERT' : 'CLEAR'
    };
  });

  evaluated.sort((a, b) => a.distToCoreEdgeMeters - b.distToCoreEdgeMeters);

  return {
    nearest: evaluated[0],
    nearbyWithin5km: evaluated.filter((f) => f.centerDistMeters <= 5500),
    all: evaluated,
    lawInfo: FORTRESS_LAW_INFO
  };
}

/**
 * 執行完整座標空拍規定掃描（整合民航局 4 大圖層 + 國防部 22 處要塞）
 */
export async function inspectLocationAirspace(lat, lng, radiusMeters = 5000) {
  const [airspaceRaw, tempRaw, npRaw, portRaw] = await Promise.all([
    queryArcGISRadius(ENDPOINTS.restrictedAirspace, lat, lng, radiusMeters),
    queryArcGISRadius(ENDPOINTS.temporaryArea, lat, lng, radiusMeters),
    queryArcGISRadius(ENDPOINTS.nationalPark, lat, lng, radiusMeters),
    queryArcGISRadius(ENDPOINTS.commercialPort, lat, lng, radiusMeters)
  ]);

  const isOnline =
    airspaceRaw !== null || tempRaw !== null || npRaw !== null || portRaw !== null;

  const allAnalyzedFeatures = [];

  function processLayer(features, layerType) {
    if (!features) return;
    for (const feat of features) {
      if (!feat.geometry) continue;
      const spatial = analyzePointToGeometry(lat, lng, feat.geometry);
      const info = classifyAirspaceFeature(feat, layerType);
      allAnalyzedFeatures.push({
        feature: feat,
        layerType,
        info,
        spatial
      });
    }
  }

  processLayer(tempRaw, 'temporary');
  processLayer(airspaceRaw, 'airspace');
  processLayer(portRaw, 'port');
  processLayer(npRaw, 'national_park');

  // 評估 22 處要塞堡壘
  const fortressReport = evaluateFortresses(lat, lng);

  // 分離「目前所在位置正下方命中」與「周邊鄰近（不在區域內）」之管制區
  const activeZonesHere = allAnalyzedFeatures.filter((item) => item.spatial.inside);
  const nearbyZones = allAnalyzedFeatures
    .filter((item) => !item.spatial.inside && item.spatial.distanceMeters <= radiusMeters)
    .sort((a, b) => a.spatial.distanceMeters - b.spatial.distanceMeters);

  // 綜合判定：這裡能不能飛？最高飛多高？
  let overallVerdict = {
    canFly: true,
    statusCode: 'GREEN_SAFE', // RED_NO_FLY | ORANGE_RESTRICTED | YELLOW_60M | GREEN_SAFE
    badgeText: '綠區・合法空域（免申請）',
    maxAltitudeMeters: GENERAL_CAA_RULES.maxAltitudeGreen,
    maxAltitudeFeet: 400,
    headline: '此座標可合法起飛（限高 120 公尺 / 400 呎）',
    subHeadline: '未命中民航局禁限航區、商港或要塞核心區。請遵守日落前降落與目視飛行規定。',
    reasons: []
  };

  const inFortressCore = fortressReport.nearest && fortressReport.nearest.inCore;
  const inFortressAlert = fortressReport.nearest && fortressReport.nearest.inAlert;

  // 檢查是否有紅區或要塞核心區命中
  const redHits = activeZonesHere.filter((z) => z.info.severity === 'prohibited');
  const portHits = activeZonesHere.filter((z) => z.info.layerType === 'port');
  const npHits = activeZonesHere.filter((z) => z.info.layerType === 'national_park');
  const yellow60Hits = activeZonesHere.filter((z) => z.info.severity === 'restricted_60m');
  const conditionalYellowHits = activeZonesHere.filter(
    (z) => z.info.severity === 'conditional_yellow'
  );

  if (redHits.length > 0 || inFortressCore) {
    const names = [
      ...redHits.map((r) => r.info.name),
      ...(inFortressCore ? [`${fortressReport.nearest.name}（要塞核心區）`] : [])
    ];
    overallVerdict = {
      canFly: false,
      statusCode: 'RED_NO_FLY',
      badgeText: '紅區・嚴禁飛行（禁航／要塞）',
      maxAltitudeMeters: 0,
      maxAltitudeFeet: 0,
      headline: '禁止起飛！最高限高 0 公尺',
      subHeadline: `您目前位於「${names.join('、')}」管制範圍內，未經專案核准嚴禁施放空拍機。`,
      reasons: names
    };
  } else if (portHits.length > 0) {
    const portNames = portHits.map((p) => p.info.name);
    overallVerdict = {
      canFly: false,
      statusCode: 'RED_NO_FLY',
      badgeText: '商港管制區・一般玩家禁飛',
      maxAltitudeMeters: 0,
      maxAltitudeFeet: 0,
      headline: '商港管制區！一般個人無法申請飛行',
      subHeadline: `位於「${portNames.join('、')}」，僅限政府、學校或法人於 7 日前申請核准；一般玩家擅飛可罰 30 萬～150 萬元。`,
      reasons: portNames
    };
  } else if (npHits.length > 0 || conditionalYellowHits.length > 0) {
    const limitAlt = yellow60Hits.length > 0 ? 60 : 120;
    const limitFt = yellow60Hits.length > 0 ? 200 : 400;
    const zoneNames = [
      ...npHits.map((n) => n.info.name),
      ...conditionalYellowHits.map((c) => c.info.name)
    ];
    overallVerdict = {
      canFly: 'CONDITIONAL',
      statusCode: 'ORANGE_RESTRICTED',
      badgeText: '條件限制區・需事先申請或注意時段',
      maxAltitudeMeters: limitAlt,
      maxAltitudeFeet: limitFt,
      headline: `需確認申請／條件！核准後限高 ${limitAlt} 公尺 (${limitFt} 呎)`,
      subHeadline: `位於「${zoneNames.join('、')}」，須依主管機關規定提前申請或遵守例假日／時段限制。`,
      reasons: zoneNames
    };
  } else if (yellow60Hits.length > 0) {
    const names = yellow60Hits.map((y) => y.info.name);
    overallVerdict = {
      canFly: true,
      statusCode: 'YELLOW_60M',
      badgeText: '黃區・機場周邊限高 60 公尺 (200 呎)',
      maxAltitudeMeters: 60,
      maxAltitudeFeet: 200,
      headline: '有條件可飛！最高限高 60 公尺 (200 呎)',
      subHeadline: `位於「${names.join('、')}」，距地面或水面 200 呎（60 公尺）以下免申請可飛，嚴禁超高！`,
      reasons: names
    };
  }

  // 若在要塞外圍警戒區 (Zone 2)，附加戰術提醒
  if (inFortressAlert && overallVerdict.statusCode !== 'RED_NO_FLY') {
    overallVerdict.subHeadline += ` ⚠️ 注意：距離「${fortressReport.nearest.name}」僅 ${(
      fortressReport.nearest.centerDistMeters / 1000
    ).toFixed(2)} 公里，鏡頭嚴禁對準軍事營區或陣地拍攝！`;
  }

  return {
    timestamp: new Date().toISOString(),
    isOnline,
    coordinates: { lat, lng },
    radiusMeters,
    overallVerdict,
    activeZonesHere,
    nearbyZones,
    npHits,
    portHits,
    fortressReport,
    allAnalyzedFeatures
  };
}

