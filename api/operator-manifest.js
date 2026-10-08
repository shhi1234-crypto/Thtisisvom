// Each installation must reopen its own registration link, never another operator's.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') return res.status(405).end();
  const token = new URL(req.url, 'https://thisisvom.vercel.app').searchParams.get('t') || '';
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) return res.status(400).end();
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  return res.status(200).send(JSON.stringify({
    id: '/operator-alert/', name: 'VOM 운영', short_name: 'VOM 운영',
    start_url: '/operator-alert/?t=' + encodeURIComponent(token), scope: '/operator-alert/',
    display: 'standalone', background_color: '#f8f7fb', theme_color: '#7d68e8',
    icons: [{src: '/favicon.png?v=4', sizes: '512x512', type: 'image/png'}]
  }));
};
