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

  // FIX: Use live synced data (from /api/sync POST) instead of stale static JSON
  const currentData = getServerlessData();
  const clients = currentData.clients || [];
  const bookings = currentData.bookings || [];
  const attendance = currentData.attendance || [];
  const settings = currentData.settings || {};

  let targetClient = null;
  if (clientId) {
    targetClient = clients.find(c => c.id === clientId);
  } else if (username) {
    const uLow = username.toString().trim().toLowerCase();
    targetClient = clients.find(c => (c.username || '').toString().trim().toLowerCase() === uLow);
  }

  if (!targetClient) {
    return res.status(404).json({ success: false, message: 'العميل غير مسجل' });
  }

  const myBookings = bookings.filter(b => b.clientId === targetClient.id);
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
