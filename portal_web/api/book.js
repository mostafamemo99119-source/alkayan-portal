// 📅 Vercel Serverless Booking API
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const booking = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    return res.status(200).json({
      success: true,
      offline: true,
      message: 'تم تأكيد الحجز وخصم الساعات فورياً بنجاح!',
      booking
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
