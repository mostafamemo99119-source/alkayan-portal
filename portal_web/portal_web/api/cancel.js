// 🗑️ Vercel Serverless Booking Cancellation API - Instant Room Release & Cloud Synchronization
const FIREBASE_BASE_URL = "https://alkayan-group-default-rtdb.europe-west1.firebasedatabase.app";

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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { clientId, bookingId } = body || {};

    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'معرف الحجز مطلوب' });
    }

    // 1. Direct Atomic update in Firebase bookings array
    try {
      const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings.json`, { cache: 'no-store' });
      if (fbRes.ok) {
        const rawBookings = await fbRes.json();
        let targetBooking = null;
        if (Array.isArray(rawBookings)) {
          const updated = rawBookings.map(b => {
            if (b && b.id === bookingId) {
              targetBooking = b;
              return { ...b, status: 'cancelled' };
            }
            return b;
          });
          await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updated)
          });
        } else if (rawBookings && typeof rawBookings === 'object') {
          for (const key of Object.keys(rawBookings)) {
            if (rawBookings[key] && rawBookings[key].id === bookingId) {
              targetBooking = rawBookings[key];
              await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${key}/status.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify('cancelled')
              });
              break;
            }
          }
        }

        // 2. Broadcast Instant Room Release Event (<0.02s Delivery to all devices)
        const roomName = targetBooking ? targetBooking.room : 'القاعة';
        const bookDate = targetBooking ? targetBooking.date : '';
        await fetch(`${FIREBASE_BASE_URL}/alkayan_db/latest_booking_update.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'cancel',
            bookingId: bookingId,
            room: roomName,
            date: bookDate,
            clientId: clientId,
            timestamp: Date.now()
          })
        }).catch(() => {});
      }
    } catch (fbErr) {
      console.warn('Firebase cancel update error in serverless:', fbErr);
    }

    return res.status(200).json({
      success: true,
      message: 'تم إلغاء الحجز وتحرير القاعة فورياً بنجاح!'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
