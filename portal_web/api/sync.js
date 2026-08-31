// 🚀 Vercel Serverless Sync API - Live Bridge for AL KAYAN GROUP
import { updateServerlessData, getServerlessData, getPendingCloudBookings, clearPendingCloudBookings } from './login.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // POST: Receive new client & balance data from Desktop App + Acknowledge pending bookings
  if (req.method === 'POST') {
    try {
      const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (data) {
        // Clear acknowledged bookings if provided by desktop sync
        if (Array.isArray(data.ackBookingIds) && data.ackBookingIds.length > 0) {
          clearPendingCloudBookings(data.ackBookingIds);
        }

        if (Array.isArray(data.clients) || data.clients) {
          const payload = {
            ...data,
            updatedAt: new Date().toISOString()
          };
          updateServerlessData(payload);
          return res.status(200).json({
            success: true,
            message: 'تم تحديث بيانات السحاب بنجاح في سيرفر Vercel',
            clientsCount: (data.clients || []).length,
            updatedAt: payload.updatedAt,
            pendingBookings: getPendingCloudBookings()
          });
        }
      }
      return res.status(400).json({ success: false, message: 'بيانات غير صالحة' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // GET: Fetch current in-memory cloud data + any pending cloud bookings made while desktop was off
  return res.status(200).json({
    success: true,
    data: getServerlessData(),
    pendingBookings: getPendingCloudBookings()
  });
}
