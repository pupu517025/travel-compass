(function (global) {
  const speedKmh = { 汽車:45, 摩托車:38, 腳踏車:15, 步行:4 };
  const mapModes = { 汽車:'driving', 摩托車:'driving', 腳踏車:'bicycling', 步行:'walking' };
  function estimateMinutes(from, to, transport, interCounty = false) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(to[0] - from[0]);
    const dLng = rad(to[1] - from[1]);
    const a = Math.sin(dLat/2)**2 + Math.cos(rad(from[0])) * Math.cos(rad(to[0])) * Math.sin(dLng/2)**2;
    let km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    if (interCounty) km *= 1.25;
    return Math.max(5, Math.round(km / (speedKmh[transport] || speedKmh.汽車) * 12) * 5);
  }
  global.EtaService = { estimateMinutes, mapMode: transport => mapModes[transport] || 'driving' };
})(window);
