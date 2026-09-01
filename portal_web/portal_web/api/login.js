// 🔐 Vercel Serverless Login API - Multi-Identifier Smart Match
import portalDataFallback from '../portal_data.json';

// Global cache for warm serverless instances
let liveCachedData = null;
let pendingCloudBookings = [];

export function updateServerlessData(newData) {
  liveCachedData = newData;
}

export function getServerlessData() {
  return liveCachedData || portalDataFallback;
}

export function recordCloudBooking(bookingObj, updatedClient, attRecord) {
  const current = getServerlessData();
  const clients = current.clients || [];
  const bookings = current.bookings || [];
  const attendance = current.attendance || [];

  // Update target client in clients list
  const idx = clients.findIndex(c => c.id === updatedClient.id);
  if (idx !== -1) {
    clients[idx] = updatedClient;
  }

  // Insert booking & attendance
  if (!bookings.some(b => b.id === bookingObj.id)) {
    bookings.unshift(bookingObj);
  }
  if (attRecord && !attendance.some(a => a.id === attRecord.id)) {
    attendance.unshift(attRecord);
  }

  liveCachedData = {
    ...current,
    clients,
    bookings,
    attendance,
    updatedAt: new Date().toISOString()
  };

  // Add to pending queue for desktop retrieval
  if (!pendingCloudBookings.some(b => b.id === bookingObj.id)) {
    pendingCloudBookings.push({
      booking: bookingObj,
      client: updatedClient,
      attendance: attRecord
    });
  }

  return liveCachedData;
}

export function getPendingCloudBookings() {
  return pendingCloudBookings;
}

export function clearPendingCloudBookings(ackIds = []) {
  if (ackIds.length === 0) {
    pendingCloudBookings = [];
  } else {
    pendingCloudBookings = pendingCloudBookings.filter(p => !ackIds.includes(p.booking?.id));
  }
}

function cleanDigits(str) {
  if (!str) return '';
  const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  return str.toString().replace(/[٠-٩]/g, d => arabicNumbers.indexOf(d)).trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { username, password } = body || {};

    if (!username) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم أو رقم الهاتف' });
    }

    const cleanUser = cleanDigits(username).toLowerCase();
    const cleanPass = cleanDigits(password);

    const currentData = getServerlessData();
    const clients = currentData.clients || [];
    const bookings = currentData.bookings || [];
    const attendance = currentData.attendance || [];
    const settings = currentData.settings || {};

    let targetClient = null;
    for (const c of clients) {
      const uName = cleanDigits(c.username || '').toLowerCase();
      const phone = cleanDigits(c.phone || '');
      const phoneLocal = phone.replace(/^\+?\d{1,3}/, ''); // Strip country code for easy matching
      const name = (c.name || '').toString().trim().toLowerCase();
      const cId = (c.id || '').toString().trim().toLowerCase();

      const isMatch = (uName && uName === cleanUser) ||
                      (phone && (phone === cleanUser || phoneLocal === cleanUser || cleanUser.endsWith(phoneLocal))) ||
                      (name && name === cleanUser) ||
                      (cId && cId === cleanUser);

      if (isMatch) {
        targetClient = c;
        break;
      }
    }

    if (!targetClient) {
      return res.status(401).json({
        success: false,
        message: 'اسم المستخدم أو رقم الهاتف غير مسجل بالنظام'
      });
    }

    const correctPass = cleanDigits(targetClient.password || '');
    if (correctPass && cleanPass && correctPass !== cleanPass) {
      return res.status(401).json({
        success: false,
        message: 'كلمة المرور غير صحيحة'
      });
    }

    const myBookings = bookings.filter(b => b.clientId === targetClient.id);
    const myAttendance = attendance.filter(a => a.clientId === targetClient.id);

    return res.status(200).json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح',
      client: targetClient,
      myBookings,
      allBookings: bookings,
      myAttendance,
      notifications: [],
      settings
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
