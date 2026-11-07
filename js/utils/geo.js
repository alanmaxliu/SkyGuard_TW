/**
 * 空間幾何與方位角運算引擎 (Geo Spatial Engine)
 * 支援：Haversine 球面距離、方位角轉換、Ray-Casting 多邊形包含判定、點對多邊形邊界最短距離與方向計算
 */

const EARTH_RADIUS_M = 6371008.8;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * 計算兩組經緯度間之球面距離（單位：公尺）
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * 計算從起點 (lat1, lng1) 指向終點 (lat2, lng2) 之正北方位角 (0~360 度)
 */
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lng2 - lng1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

/**
 * 將方位角 (0~360) 轉為中文 8 方位與箭頭符號
 */
export function bearingToCompass(bearing) {
  const dirs8 = [
    { name: '北方', short: '北', arrow: '↑' },
    { name: '東北方', short: '東北', arrow: '↗' },
    { name: '東方', short: '東', arrow: '→' },
    { name: '東南方', short: '東南', arrow: '↘' },
    { name: '南方', short: '南', arrow: '↓' },
    { name: '西南方', short: '西南', arrow: '↙' },
    { name: '西方', short: '西', arrow: '←' },
    { name: '西北方', short: '西北', arrow: '↖' }
  ];
  const idx = Math.round(((bearing % 360) / 45)) % 8;
  return {
    ...dirs8[idx],
    degree: Math.round(bearing)
  };
}

/**
 * 格式化距離顯示（公尺 / 公里）
 */
export function formatDistance(meters) {
  if (meters <= 0) return '0 公尺（位於區域內）';
  if (meters < 1000) {
    return `${Math.round(meters)} 公尺`;
  }
  return `${(meters / 1000).toFixed(2)} 公里`;
}

/**
 * Ray-casting 判斷點 [lng, lat] 是否在單一線性環 (Ring) 內
 */
function isPointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 判斷點 (lat, lng) 是否位於 Polygon 座標陣列內（考慮外環與內孔洞）
 */
function isPointInPolygonCoords(lng, lat, polygonCoords) {
  if (!polygonCoords || polygonCoords.length === 0) return false;
  // 先檢查外環
  if (!isPointInRing(lng, lat, polygonCoords[0])) return false;
  // 若在內環（孔洞）內，則視為不在多邊形內
  for (let k = 1; k < polygonCoords.length; k++) {
    if (isPointInRing(lng, lat, polygonCoords[k])) return false;
  }
  return true;
}

/**
 * 判斷點 (lat, lng) 是否位於 GeoJSON Geometry (Polygon 或 MultiPolygon) 內部
 */
export function isPointInGeometry(lat, lng, geometry) {
  if (!geometry || !geometry.type || !geometry.coordinates) return false;
  if (geometry.type === 'Polygon') {
    return isPointInPolygonCoords(lng, lat, geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      if (isPointInPolygonCoords(lng, lat, poly)) return true;
    }
  }
  return false;
}

/**
 * 計算點 P(lat, lng) 到線段 AB(latA, lngA)-(latB, lngB) 的最近點座標
 * 使用局部平面投影近似（在台灣緯度範圍內誤差小於 0.1%）
 */
function closestPointOnSegment(latP, lngP, latA, lngA, latB, lngB) {
  const cosLat = Math.cos(toRad(latP));
  const px = lngP * cosLat;
  const py = latP;
  const ax = lngA * cosLat;
  const ay = latA;
  const bx = lngB * cosLat;
  const by = latB;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return { lat: latA, lng: lngA };
  }

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const nearLng = (ax + t * dx) / cosLat;
  const nearLat = ay + t * dy;
  return { lat: nearLat, lng: nearLng };
}

/**
 * 計算使用者座標 (lat, lng) 到 GeoJSON Geometry (Polygon / MultiPolygon) 的：
 * 1. 是否在區域內 (inside: boolean)
 * 2. 距離最近邊界的距離 (distanceMeters: number)
 * 3. 最近邊界點座標 (nearestPoint: {lat, lng})
 * 4. 指向該最近邊界點的方位角 (bearing: number) 與中文方位
 */
export function analyzePointToGeometry(lat, lng, geometry) {
  const inside = isPointInGeometry(lat, lng, geometry);
  if (inside) {
    return {
      inside: true,
      distanceMeters: 0,
      nearestPoint: { lat, lng },
      bearing: 0,
      compass: { name: '當前位置上方', short: '所在地', arrow: '◎', degree: 0 }
    };
  }

  let minDistance = Infinity;
  let bestPoint = { lat, lng };

  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : [];

  for (const poly of polygons) {
    if (!poly || !poly[0]) continue;
    const outerRing = poly[0];
    // 為兼顧大型多邊形效能，若頂點過多仍逐段檢查外環線段
    for (let i = 0; i < outerRing.length - 1; i++) {
      const lngA = outerRing[i][0], latA = outerRing[i][1];
      const lngB = outerRing[i + 1][0], latB = outerRing[i + 1][1];
      const candidate = closestPointOnSegment(lat, lng, latA, lngA, latB, lngB);
      const dist = haversineDistance(lat, lng, candidate.lat, candidate.lng);
      if (dist < minDistance) {
        minDistance = dist;
        bestPoint = candidate;
      }
    }
  }

  const bearing = calculateBearing(lat, lng, bestPoint.lat, bestPoint.lng);
  const compass = bearingToCompass(bearing);

  return {
    inside: false,
    distanceMeters: minDistance,
    nearestPoint: bestPoint,
    bearing,
    compass
  };
}

