// 📅 Vercel Serverless Booking API - Immediate Hour Deduction & Cloud Synchronization
import { getServerlessData, recordCloudBooking } from './login.js';

const FIREBASE_BASE_URL = "https://alkayan-groub-v2-default-rtdb.europe-west1.firebasedatabase.app";

function cleanDigits(str) {
  if (!str) return '';
  const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  return str.toString().replace(/[٠-٩]/g, d => arabicNumbers.indexOf(d)).trim();
}

function to12h(hour, minute) {
  const period = hour >= 12 ? 'م' : 'ص';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const minStr = String(minute).padStart(2, '0');
  const hStr = String(h12).padStart(2, '0');
  return `${hStr}:${minStr} ${period}`;
}

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
    const { clientId, date, time, duration, room, serviceType, notes } = body || {};

    if (!clientId || !date || !time || !duration) {
      return res.status(400).json({ success: false, message: 'بيانات الحجز غير مكتملة' });
    }

    const currentData = getServerlessData();
    const clients = currentData.clients || [];
    // 🚫 Check deleted_clients blacklist
    const delClients = currentData.deleted_clients || [];
    const delList = Array.isArray(delClients) ? delClients : Object.values(delClients);
    const checkId = clientId ? clientId.toString().trim().toLowerCase() : '';
    for (const dc of delList) {
      if (!dc) continue;
      const dcId = (dc.id || '').toString().trim().toLowerCase();
      if (checkId && dcId && dcId === checkId) {
        return res.status(401).json({
          success: false,
          code: 'CLIENT_PURGED_PERMANENTLY',
          message: 'تم حذف هذا الحساب نهائياً، لا يمكن إتمام الحجز.'
        });
      }
    }

    const targetClient = clients.find(c => c.id === clientId);

    if (!targetClient) {
      return res.status(401).json({ 
        success: false, 
        code: 'CLIENT_DELETED_OR_NOT_FOUND',
        message: 'العميل غير مسجل بالنظام أو تم حذفه نهائياً' 
      });
    }

    const durVal = parseFloat(cleanDigits(duration));
    if (isNaN(durVal) || durVal <= 0) {
      return res.status(400).json({ success: false, message: 'مدة الحجز غير صالحة' });
    }

    // Check balance for hourly subscriptions
    const isFullTime = targetClient.subscriptionType === 'fulltime' || targetClient.isFullTime === true;
    const oldBalance = parseFloat(targetClient.currentBalance || 0);

    if (!isFullTime && oldBalance < durVal) {
      return res.status(400).json({
        success: false,
        message: `⛔ رصيدك الحالي (${oldBalance}س) لا يكفي لحجز مدة (${durVal}س). يرجى شحن رصيد إضافي.`
      });
    }

    // Calculate time range
    const parts = (time || '12:00').split(':');
    const h = parseInt(cleanDigits(parts[0])) || 12;
    const m = parseInt(cleanDigits(parts[1] || '0')) || 0;
    const endH = (h + Math.floor(durVal)) % 24;
    const endM = m;

    const start12h = to12h(h, m);
    const end12h = to12h(endH, endM);
    const timeRangeStr = `من ${start12h} إلى ${end12h}`;
    const durStr = String(Math.floor(durVal));

    // Deduct balance immediately
    const newBalNum = Math.max(0, oldBalance - durVal);
    const newBalStr = newBalNum % 1 === 0 ? String(newBalNum) : String(newBalNum.toFixed(1));

    const updatedClient = {
      ...targetClient,
      currentBalance: newBalStr
    };

    const nowIso = new Date().toISOString();
    const bookingId = `b-mob-${Date.now()}`;
    const targetRoom = room || 'Master VIP Room';

    const fullBookingObj = {
      id: bookingId,
      clientId: targetClient.id,
      clientName: targetClient.name,
      clientPhone: targetClient.phone,
      date,
      time,
      startTime: start12h,
      endTime: end12h,
      timeRange: timeRangeStr,
      duration: durStr,
      durationHours: durStr,
      serviceType: serviceType || 'حجز ذاتي من الجوال',
      room: targetRoom,
      status: 'scheduled',
      bookedVia: 'mobile_app',
      isAutoDeducted: true,
      hoursDeducted: durStr,
      newBalanceAfterBooking: newBalStr,
      notes: notes || 'حجز تم بواسطة العميل عبر تطبيق الجوال',
      createdAt: nowIso
    };

    const attRecord = {
      id: `att-mob-${Date.now()}`,
      clientId: targetClient.id,
      clientName: targetClient.name,
      clientPhone: targetClient.phone,
      date,
      time,
      startTime: start12h,
      endTime: end12h,
      timeRange: timeRangeStr,
      hoursConsumed: durStr,
      oldBalance: String(oldBalance),
      newBalance: newBalStr,
      serviceType: `حجز قاعة (${targetRoom})`,
      notes: `خصم فوري لحجز ${targetRoom} (${timeRangeStr}) - المدة: ${durStr} ساعات`,
      source: 'mobile_app',
      createdAt: nowIso
    };

    // Register in serverless memory queue
    recordCloudBooking(fullBookingObj, updatedClient, attRecord);
    
    // Direct Cloud Push to Firebase V2
    try {
      // Push booking
      await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${bookingId}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullBookingObj)
      });
      // Push attendance
      if (attRecord) {
        await fetch(`${FIREBASE_BASE_URL}/alkayan_db/attendance/${attRecord.id}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attRecord)
        });
      }
      // Update client balance
      await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json`, {
        method: 'GET',
        headers: { 'cache': 'no-store' }
      }).then(res => res.json()).then(async rawClients => {
        if (rawClients) {
          let updated = false;
          if (Array.isArray(rawClients)) {
            for (let i=0; i<rawClients.length; i++) {
              if (rawClients[i] && rawClients[i].id === targetClient.id) {
                rawClients[i] = updatedClient;
                updated = true;
                break;
              }
            }
          } else {
            for (let key in rawClients) {
              if (rawClients[key] && rawClients[key].id === targetClient.id) {
                rawClients[key] = updatedClient;
                updated = true;
                break;
              }
            }
          }
          if (updated) {
            await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rawClients)
            });
          }
        }
      });
      
      // Notify Admin
      await fetch(`${FIREBASE_BASE_URL}/alkayan_db/latest_booking_update.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'book',
            bookingId: bookingId,
            room: targetRoom,
            date: date,
            clientId: targetClient.id,
            timestamp: Date.now()
        })
      });
    } catch (fbErr) {
      console.warn("Firebase direct push failed in API:", fbErr);
    }


    return res.status(200).json({
      success: true,
      message: `تم تأكيد حجز القاعة بنجاح (${timeRangeStr}) وخصم ${durStr} ساعات فورياً من رصيدك!`,
      client: updatedClient,
      booking: fullBookingObj,
      attendance: attRecord
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
