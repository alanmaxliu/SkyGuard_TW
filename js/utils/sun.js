/**
 * 高精度天文日出日落與民航局夜間禁飛倒數計時引擎
 * 採用 NOAA Solar Calculator 天文演算法（純前端運算、免網路也可精準計算當地日出日落）
 */

function degToRad(deg) {
  return (deg * Math.PI) / 180.0;
}

function radToDeg(rad) {
  return (rad * 180.0) / Math.PI;
}

/**
 * 計算指定日期與經緯度之日出、日落與民用暮光時間（以台灣時間 UTC+8 回傳）
 * @param {number} lat 緯度
 * @param {number} lng 經度
 * @param {Date} date 目標日期（預設今日）
 */
export function calculateSunTimes(lat, lng, date = new Date()) {
  // 取得台灣時區 (UTC+8) 的年月日
  const twOffsetMinutes = 8 * 60;
  const localMs = date.getTime() + (date.getTimezoneOffset() + twOffsetMinutes) * 60000;
  const twDate = new Date(localMs);

  const year = twDate.getFullYear();
  const month = twDate.getMonth() + 1;
  const day = twDate.getDate();

  // 計算當日是一年中的第幾天 (Day of Year)
  const startOfYear = new Date(year, 0, 0);
  const diff = new Date(year, month - 1, day) - startOfYear;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));

  // 分數年 (Fractional year gamma, in radians)
  const gamma = ((2 * Math.PI) / 365.0) * (dayOfYear - 1);

  // 均時差 (Equation of time, in minutes)
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // 太陽赤緯 (Solar declination angle, in radians)
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latRad = degToRad(lat);

  // 計算特定天頂角 (zenith) 對應的時角
  function getHourAngle(zenithDeg) {
    const zenithRad = degToRad(zenithDeg);
    const cosHA =
      Math.cos(zenithRad) / (Math.cos(latRad) * Math.cos(decl)) -
      Math.tan(latRad) * Math.tan(decl);
    const clamped = Math.max(-1, Math.min(1, cosHA));
    return radToDeg(Math.acos(clamped));
  }

  // 官方日出日落天頂角：90.833 度（含大氣折射與太陽視半徑）
  const haOfficial = getHourAngle(90.833);
  // 民用曙暮光天頂角：96.0 度
  const haCivil = getHourAngle(96.0);

  // 計算 UTC 分鐘數，再加上台灣時區 (+480 分鐘)
  const solarNoonMin = 720 - 4 * lng - eqTime + twOffsetMinutes;
  const sunriseMin = solarNoonMin - haOfficial * 4;
  const sunsetMin = solarNoonMin + haOfficial * 4;
  const civilDawnMin = solarNoonMin - haCivil * 4;
  const civilDuskMin = solarNoonMin + haCivil * 4;

  function minToDateObj(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.floor(totalMinutes % 60);
    const s = Math.round((totalMinutes - Math.floor(totalMinutes)) * 60);
    return new Date(year, month - 1, day, h, m, s);
  }

  function formatHHMM(d) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  const sunriseDate = minToDateObj(sunriseMin);
  const sunsetDate = minToDateObj(sunsetMin);
  const civilDawnDate = minToDateObj(civilDawnMin);
  const civilDuskDate = minToDateObj(civilDuskMin);
  const now = new Date();

  const isDaylight = now >= sunriseDate && now <= sunsetDate;
  const isBeforeSunrise = now < sunriseDate;
  const isAfterSunset = now > sunsetDate;

  // 計算距離日落（或明日日出）之分鐘數
  const minutesToSunset = Math.round((sunsetDate - now) / 60000);
  const minutesToSunrise = Math.round((sunriseDate - now) / 60000);

  let statusText = '';
  let statusLevel = 'safe'; // safe | warning | prohibited
  let countdownText = '';

  if (isBeforeSunrise) {
    statusLevel = 'prohibited';
    statusText = '日出前禁飛時段（夜間禁飛）';
    const hrs = Math.floor(minutesToSunrise / 60);
    const mins = minutesToSunrise % 60;
    countdownText = `距離今日日出還有 ${hrs > 0 ? hrs + ' 小時 ' : ''}${mins} 分鐘`;
  } else if (isAfterSunset) {
    statusLevel = 'prohibited';
    statusText = '已日落（依法禁止夜間飛行）';
    const passedMin = Math.abs(minutesToSunset);
    const hrs = Math.floor(passedMin / 60);
    const mins = passedMin % 60;
    countdownText = `今日已日落 ${hrs > 0 ? hrs + ' 小時 ' : ''}${mins} 分鐘（日落後嚴禁未經專案核准飛行）`;
  } else {
    const hrs = Math.floor(minutesToSunset / 60);
    const mins = minutesToSunset % 60;
    countdownText = `距離日落剩餘 ${hrs > 0 ? hrs + ' 小時 ' : ''}${mins} 分鐘`;
    if (minutesToSunset <= 30) {
      statusLevel = 'warning';
      statusText = '即將日落！請準備返航降落';
    } else {
      statusLevel = 'safe';
      statusText = '日間合法可飛時段（日出後～日落前）';
    }
  }

  return {
    sunriseTime: formatHHMM(sunriseDate),
    sunsetTime: formatHHMM(sunsetDate),
    civilDawnTime: formatHHMM(civilDawnDate),
    civilDuskTime: formatHHMM(civilDuskDate),
    sunriseDate,
    sunsetDate,
    isDaylight,
    isAfterSunset,
    isBeforeSunrise,
    minutesToSunset,
    statusLevel,
    statusText,
    countdownText
  };
}

