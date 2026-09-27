// 📊 Vercel Serverless Client Data API - Uses live in-memory data from /api/sync
import portalDataFallback from '../portal_data.json';
import { getServerlessData } from './login.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { clientId, username } = req.query || {};

  let currentData = null;
  try {
    const fbRes = await fetch('https://alkayan-groub-v2-default-rtdb.europe-west1.firebasedatabase.app/alkayan_db.json', { cache: 'no-store' });
    if (fbRes.ok) {
      const fbJson = await fbRes.json();
      if (fbJson && fbJson.clients) {
        const fbClients = Array.isArray(fbJson.clients) ? fbJson.clients : Object.values(fbJson.clients);
        currentData = { 
          ...fbJson, 
          clients: fbClients,
          deleted_clients: fbJson.deleted_clients || []
        };
        updateServerlessData(currentData);
      }
    }
  } catch (fbErr) {}

  if (!currentData) {
    currentData = getServerlessData();
  }

  const clients = currentData.clients || [];
  const bookings = currentData.bookings || [];
  const attendance = currentData.attendance || [];
  const settings = currentData.settings || {};

  // 🚫 Check deleted_clients blacklist
  const delClients = currentData.deleted_clients || [];
  const delList = Array.isArray(delClients) ? delClients : Object.values(delClients);
  const checkId = clientId ? clientId.toString().trim().toLowerCase() : '';
  const checkUser = username ? username.toString().trim().toLowerCase() : '';
  for (const dc of delList) {
    if (!dc) continue;
    const dcId = (dc.id || '').toString().trim().toLowerCase();
    const dcUser = (dc.username || '').toString().trim().toLowerCase();
    if ((checkId && dcId && dcId === checkId) || (checkUser && dcUser && dcUser === checkUser)) {
      return res.status(401).json({
        success: false,
        code: 'CLIENT_PURGED_PERMANENTLY',
        message: 'تم حذف هذا الحساب نهائياً من قبل الإدارة العامة للمجموعة.'
      });
    }
  }

  let targetClient = null;
  if (clientId) {
    targetClient = clients.find(c => c.id === clientId);
  } else if (username) {
    const uLow = username.toString().trim().toLowerCase();
    targetClient = clients.find(c => (c.username || '').toString().trim().toLowerCase() === uLow);
  }

  if (!targetClient) {
    return res.status(401).json({ 
      success: false, 
      code: 'CLIENT_DELETED_OR_NOT_FOUND',
      message: 'العميل غير مسجل بالنظام أو تم حذفه نهائياً' 
    });
  }

  const rawBookings = bookings.filter(b => b.clientId === targetClient.id);
  const seenB = new Set();
  const myBookings = [];
  for (const b of rawBookings) {
    if (!b) continue;
    const bid = String(b.id || b.booking_id || '').trim();
    if (!bid || seenB.has(bid)) continue;
    seenB.add(bid);
    myBookings.push(b);
  }
  const myAttendance = attendance.filter(a => a.clientId === targetClient.id);

  return res.status(200).json({
    success: true,
    client: targetClient,
    myBookings,
    allBookings: bookings,
    myAttendance,
    notifications: [],
    settings
  });
}
