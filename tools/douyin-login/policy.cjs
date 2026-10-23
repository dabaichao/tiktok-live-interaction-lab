// Shared pure policy: testable without launching Electron or using real cookies.
function isOfficialPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
  } catch { return false; }
}

function loginCookieHeader(cookies, now = Date.now() / 1000) {
  const values = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    // Export only cookies usable by the live origin, never passport-only cookies
    // or cookies from unrelated websites loaded in subframes.
    if (!['douyin.com', 'live.douyin.com'].includes(domain) || (cookie.path && cookie.path !== '/')) continue;
    if (cookie.expirationDate && cookie.expirationDate <= now) continue;
    if (!/^[\w-]+$/.test(cookie.name) || !/^[\x21-\x3a\x3c-\x7e]*$/.test(cookie.value)) continue;
    values.set(cookie.name, cookie.value);
  }
  if (!['sessionid', 'sessionid_ss', 'sid_tt'].some(name => values.get(name))) return '';
  const header = [...values].map(([name, value]) => `${name}=${value}`).join('; ');
  return header.length <= 16384 ? header : '';
}

// Session cookies have no declared expiry. Never invent a platform validity date.
function loginCookieExpiry(cookies, now = Date.now() / 1000) {
  const dates = cookies.filter(cookie => ['douyin.com', 'live.douyin.com'].includes(String(cookie.domain || '').replace(/^\./, '').toLowerCase()) &&
    (!cookie.path || cookie.path === '/') && ['sessionid','sessionid_ss','sid_tt'].includes(cookie.name) && cookie.value && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > now)
    .map(cookie => cookie.expirationDate * 1000);
  return dates.length ? Math.min(...dates) : undefined;
}
module.exports = { isOfficialPage, loginCookieHeader, loginCookieExpiry };
