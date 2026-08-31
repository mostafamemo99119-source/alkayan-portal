"use strict";

const {
  useState,
  useEffect,
  useRef,
  useMemo
} = React;
const INITIAL_ROOMS = ['Master VIP Room', 'MaxRoom'];

// Convert Arabic/Persian digits to standard digits
function toStandardDigits(str) {
  if (!str) return '';
  const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return str.toString().replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[۰-۹]/g, d => persianDigits.indexOf(d));
}

// ====================================================
// 🕒 Time Parsing & Real-Time Interval Conflict Helpers
// ====================================================
function parseArabicTimeToDecimal(timeStr) {
  if (!timeStr) return 10.0;
  const str = timeStr.trim();
  const isPM = str.includes('م') || str.toLowerCase().includes('pm');
  const isAM = str.includes('ص') || str.toLowerCase().includes('am');
  const clean = str.replace(/[^\d:]/g, '');
  const parts = clean.split(':');
  let hours = parseInt(parts[0], 10) || 0;
  const minutes = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  return hours + minutes / 60;
}
function decimalToTimeStr(decimal) {
  let hours = Math.floor(decimal);
  const minutes = Math.round((decimal - hours) * 60);
  const isPM = hours >= 12;
  let displayHour = hours % 12;
  if (displayHour === 0) displayHour = 12;
  const displayMin = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const period = isPM ? 'م' : 'ص';
  return `${displayHour}:${displayMin} ${period}`;
}
function checkRoomConflict(candRoom, candDate, candTimeStr, candDuration, allBookings) {
  let ignoreBookingId = arguments.length > 5 && arguments[5] !== undefined ? arguments[5] : null;
  if (!candRoom || !candDate || !candTimeStr) return {
    hasConflict: false
  };
  const candStart = parseArabicTimeToDecimal(candTimeStr);
  const candEnd = candStart + (parseFloat(candDuration) || 1);
  for (const b of allBookings) {
    if (ignoreBookingId && b.id === ignoreBookingId) continue;
    if (b.status !== 'scheduled') continue; // Only active upcoming bookings occupy rooms
    if (b.room === candRoom && b.date === candDate) {
      const bStart = parseArabicTimeToDecimal(b.time);
      const bEnd = bStart + (parseFloat(b.duration) || 1);

      // Overlap condition: startA < endB && endA > startB
      if (candStart < bEnd && candEnd > bStart) {
        return {
          hasConflict: true,
          conflictingBooking: b,
          conflictTime: `${decimalToTimeStr(bStart)} - ${decimalToTimeStr(bEnd)}`
        };
      }
    }
  }
  return {
    hasConflict: false
  };
}
function getClientContractStatus(client) {
  if (!client) return {
    isExpired: false,
    daysLeft: null,
    label: 'غير مسجل',
    badgeText: 'غير محدد'
  };
  const isFT = client.subscriptionType === 'fulltime' || client.isFullTime;
  const todayStr = new Date().toISOString().split('T')[0];
  const today = new Date(todayStr);
  let daysLeft = null;
  let isExpired = false;
  let reason = '';
  if (client.expiryDate) {
    const exp = new Date(client.expiryDate);
    const diffTime = exp.getTime() - today.getTime();
    daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) {
      isExpired = true;
      reason = `انتهت صلاحية العقد منذ ${Math.abs(daysLeft)} يوم (تاريخ الانتهاء: ${client.expiryDate})`;
    }
  }
  if (!isFT && (client.currentBalance || 0) <= 0) {
    isExpired = true;
    reason = reason ? `${reason} ونفاد رصيد الساعات` : 'نفاد رصيد الساعات المخصصة';
  }
  const badgeText = isExpired ? 'منتهي الصلاحية ⛔' : daysLeft !== null ? daysLeft <= 7 ? `قارب على الانتهاء (${daysLeft} يوم) ⚠️` : 'ساري ونشط 🟢' : 'ساري 🟢';
  return {
    isFullTime: isFT,
    isExpired,
    daysLeft,
    reason,
    badgeText,
    label: isExpired ? 'منتهي الصلاحية' : 'ساري'
  };
}
function getTomorrowDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// ====================================================
// 📱 Mobile Application Component
// ====================================================
function MobileApp() {
  const [client, setClient] = useState(null);
  // PWA Install Prompt Handler (لتثبيت التطبيق على الشاشة الرئيسية للعمل 24/7 دون اتصال)
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  useEffect(() => {
    const handleBeforeInstall = e => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);
  const handleInstallApp = async () => {
    if (!deferredPrompt) {
      alert('📱 لتثبيت التطبيق: افتح خيارات المتصفح (⋮) في أعلى الصفحة ثم اختر "إضافة إلى الشاشة الرئيسية" (Add to Home screen) ليعمل معك 24/7 دائماً.');
      return;
    }
    deferredPrompt.prompt();
    const {
      outcome
    } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowInstallBanner(false);
      setDeferredPrompt(null);
    }
  };
  const [activeTab, setActiveTab] = useState('home'); // 'home' | 'book' | 'mybookings' | 'history' | 'notifications'

  // Auth Form State
  const [loginForm, setLoginForm] = useState({
    username: '',
    password: ''
  });
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // App Master Data
  const [allBookings, setAllBookings] = useState([]);
  const [myBookings, setMyBookings] = useState([]);
  const [myAttendance, setMyAttendance] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [settings, setSettings] = useState({
    companyName: 'مجموعة الكيان | AL KAYAN GROUP',
    companyPhone: '+966501234567',
    rooms: INITIAL_ROOMS
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState('');
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);

  // Booking Form State
  const tomorrowStr = getTomorrowDateStr();
  const [bookingForm, setBookingForm] = useState({
    date: tomorrowStr,
    time: '10:00 ص',
    duration: '1',
    room: 'Master VIP Room',
    serviceType: 'جلسة عمل / اجتماع',
    notes: ''
  });
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const [bookingSuccessModal, setBookingSuccessModal] = useState(null);
  const [bookingFilter, setBookingFilter] = useState('all'); // all | upcoming | completed | cancelled

  // Toast State
  const [toast, setToast] = useState(null);
  const triggerToast = function (title, message) {
    let type = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 'info';
    setToast({
      title,
      message,
      type
    });
    setTimeout(() => setToast(null), 4000);
  };

  // 1. Check saved session on load
  useEffect(() => {
    try {
      const savedUser = localStorage.getItem('KAYAN_MOBILE_USER');
      if (savedUser) {
        const parsed = JSON.parse(savedUser);
        if (parsed && parsed.username && parsed.password) {
          executeLogin(parsed.username, parsed.password, true);
        }
      }
    } catch (e) {}
  }, []);

  // 2. Fetch Full Data from Server

  // Sync pending offline bookings when connection is restored
  const syncPendingBookings = async () => {
    try {
      const syncQueue = JSON.parse(localStorage.getItem('al_kayan_pending_sync') || '[]');
      if (!Array.isArray(syncQueue) || syncQueue.length === 0) return;
      for (let i = 0; i < syncQueue.length; i++) {
        const item = syncQueue[i];
        try {
          const res = await fetch('/api/client/book', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(item)
          });
          const json = await res.json();
          if (json && json.success) {
            syncQueue.splice(i, 1);
            i--;
            localStorage.setItem('al_kayan_pending_sync', JSON.stringify(syncQueue));
          }
        } catch (err) {}
      }
    } catch (e) {}
  };
  const fetchClientData = async function () {
    let currentClient = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : client;
    syncPendingBookings();
    if (!currentClient) return;
    try {
      setIsSyncing(true);
      const res = await fetch(`/api/client/data?clientId=${encodeURIComponent(currentClient.id)}&username=${encodeURIComponent(currentClient.username || '')}`);
      const json = await res.json();
      if (json && json.success) {
        if (json.client) {
          // Check for hours deduction or balance change
          if (client && client.currentBalance !== json.client.currentBalance) {
            const diff = (client.currentBalance - json.client.currentBalance).toFixed(1);
            if (diff > 0) {
              triggerToast('⚡ تم خصم ساعات', `تم خصم ${diff} ساعة من رصيدك في السيستم الرئيسي. الرصيد الجديد: ${json.client.currentBalance}س`, 'warning');
            }
          }
          setClient(json.client);
        }
        if (Array.isArray(json.myBookings)) setMyBookings(json.myBookings);
        if (Array.isArray(json.allBookings)) setAllBookings(json.allBookings);
        if (Array.isArray(json.myAttendance)) setMyAttendance(json.myAttendance);
        if (Array.isArray(json.notifications)) setNotifications(json.notifications);
        if (json.settings) {
          setSettings(prev => ({
            ...prev,
            ...json.settings
          }));
          if (!bookingForm.room && json.settings.rooms && json.settings.rooms.length > 0) {
            setBookingForm(b => ({
              ...b,
              room: json.settings.rooms[0]
            }));
          }
        }
        setLastSyncTime(new Date().toLocaleTimeString('ar-SA', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }));
      }
    } catch (e) {
      console.warn('Sync error:', e);
    } finally {
      setIsSyncing(false);
    }
  };

  // 3. Periodic Live Polling Engine (Every 3.5 seconds)
  useEffect(() => {
    if (!client) return;
    fetchClientData();
    const interval = setInterval(() => {
      fetchClientData();
    }, 3500);
    return () => clearInterval(interval);
  }, [client?.id]);

  // Execute Login
  // Helper to lookup client in live cloud sources (Firebase Realtime DB -> Vercel Serverless -> Static Snapshot)
  const lookupInCloudSnapshot = async (cleanUser, cleanPass) => {
    let portalData = window.ALKAYAN_PORTAL_DATA;

    // 1. Try Firebase Realtime Database if configured (Google Cloud 0.05s Live Sync)
    const fbUrl = settings?.firebaseSyncUrl || portalData?.settings?.firebaseSyncUrl || localStorage.getItem('al_kayan_firebase_url');
    if (fbUrl && fbUrl.startsWith('https://')) {
      try {
        let fetchUrl = fbUrl.trim();
        if (!fetchUrl.endsWith('.json')) fetchUrl = fetchUrl.replace(/\/+$/, '') + '/alkayan_db.json';
        const fbRes = await fetch(fetchUrl, {
          cache: 'no-store'
        });
        if (fbRes.ok) {
          const fbJson = await fbRes.json();
          if (fbJson && Array.isArray(fbJson.clients) && fbJson.clients.length > 0) {
            portalData = fbJson;
            window.ALKAYAN_PORTAL_DATA = fbJson;
            localStorage.setItem('al_kayan_firebase_url', fbUrl);
          }
        }
      } catch (fbErr) {
        console.log('Firebase fetch note:', fbErr);
      }
    }

    // 2. ALWAYS fetch fresh data from Vercel Serverless /api/sync
    // Fix: Do NOT skip this even if portalData already has clients (old static data!)
    try {
      const sRes = await fetch('/api/sync?t=' + Date.now(), {
        cache: 'no-store'
      });
      if (sRes.ok) {
        const sJson = await sRes.json();
        if (sJson && sJson.data && Array.isArray(sJson.data.clients) && sJson.data.clients.length > 0) {
          // Always override portalData with freshest server data
          portalData = sJson.data;
          window.ALKAYAN_PORTAL_DATA = portalData;
        }
      }
    } catch (sErr) {
      console.log('Could not reach /api/sync, falling back to cached data');
    }

    // 3. Fallback to portal_data.json
    if (!portalData) {
      try {
        const pRes = await fetch('./portal_data.json?t=' + Date.now(), {
          cache: 'no-store'
        });
        if (pRes.ok) {
          portalData = await pRes.json();
          window.ALKAYAN_PORTAL_DATA = portalData;
        }
      } catch (err) {}
    }
    if (!portalData || !Array.isArray(portalData.clients)) return null;
    const uLow = cleanUser.toLowerCase();
    const cleanUserDigitsOnly = cleanUser.replace(/\D/g, '');
    for (const c of portalData.clients) {
      const cUser = (c.username || '').toString().trim().toLowerCase();
      const cPhone = toStandardDigits(c.phone || '').trim();
      const cPhoneDigitsOnly = cPhone.replace(/\D/g, '');
      const cName = (c.name || '').toString().trim().toLowerCase();
      const cPass = (c.password || '').toString().trim();
      const cId = (c.id || '').toString().trim().toLowerCase();

      // Multi-Identifier Match: username, phone with or without country code, full name, ID
      const userMatch = cUser && cUser === uLow || cPhone && cPhone === cleanUser || cleanUserDigitsOnly && cPhoneDigitsOnly && (cPhoneDigitsOnly.endsWith(cleanUserDigitsOnly) || cleanUserDigitsOnly.endsWith(cPhoneDigitsOnly)) || cName && cName === uLow || cId && cId === uLow;
      if (userMatch) {
        // Verify password
        if (cPass === cleanPass || !cPass || !cleanPass) {
          const myB = (portalData.bookings || []).filter(b => b.clientId === c.id);
          const myA = (portalData.attendance || []).filter(a => a.clientId === c.id);
          return {
            client: c,
            myBookings: myB,
            myAttendance: myA,
            allBookings: portalData.bookings || [],
            notifications: [],
            settings: portalData.settings || {}
          };
        }
      }
    }
    return 'INVALID_CREDENTIALS';
  };

  // Execute Login with 3-Layer Authentication (Server API -> Cloud Portal Snapshot -> Local Device Registry)
  const executeLogin = async function (username, password) {
    let isAuto = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    setLoginError('');
    setIsLoggingIn(true);
    const cleanUser = toStandardDigits(username).trim();
    const cleanPass = toStandardDigits(password).trim();
    if (!cleanUser || !cleanPass) {
      setLoginError('يرجى إدخال اسم المستخدم وكلمة المرور');
      setIsLoggingIn(false);
      return;
    }

    // 1. Try Online Server API
    try {
      const res = await fetch('/api/client/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: cleanUser,
          password: cleanPass
        })
      });
      if (res.ok) {
        const json = await res.json();
        if (json && json.success) {
          setClient(json.client);
          setMyBookings(json.myBookings || []);
          setAllBookings(json.allBookings || []);
          setMyAttendance(json.myAttendance || []);
          setNotifications(json.notifications || []);
          if (json.settings) setSettings(prev => ({
            ...prev,
            ...json.settings
          }));
          const sessionObj = {
            client: json.client,
            myBookings: json.myBookings || [],
            myAttendance: json.myAttendance || [],
            notifications: json.notifications || [],
            settings: json.settings || {},
            credentials: {
              username: cleanUser,
              password: cleanPass
            },
            savedAt: new Date().toISOString()
          };
          localStorage.setItem('al_kayan_client_session', JSON.stringify(sessionObj));
          const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
          registry[cleanUser.toLowerCase()] = sessionObj;
          localStorage.setItem('al_kayan_client_registry', JSON.stringify(registry));
          triggerToast('مرحباً بك 🌟', `تم تسجيل الدخول بنجاح يا ${json.client.name}`, 'success');
          setIsLoggingIn(false);
          return;
        } else if (json && !json.success) {
          // FIX: If server says "wrong password" explicitly, stop here.
          // But if user not found (server may have cold-start / stale data), proceed to cloud snapshot.
          const isWrongPass = json.message && (json.message.includes('كلمة المرور') || json.message.includes('password'));
          if (isWrongPass) {
            setLoginError(json.message || 'كلمة المرور غير صحيحة');
            setIsLoggingIn(false);
            return;
          }
          // Otherwise (user not found): fall through to Cloud Snapshot which always hits /api/sync fresh
          console.log('Server login returned not-found, trying cloud snapshot with fresh sync...');
        }
      }
    } catch (netErr) {
      console.log('Server login endpoint unavailable, proceeding to Cloud Snapshot & Local Registry...');
    }

    // 2. Try Cloud Snapshot (for Vercel / Netlify / GitHub Pages / Static Hosting)
    try {
      const cloudResult = await lookupInCloudSnapshot(cleanUser, cleanPass);
      if (cloudResult && typeof cloudResult === 'object') {
        setClient(cloudResult.client);
        setMyBookings(cloudResult.myBookings || []);
        setAllBookings(cloudResult.allBookings || []);
        setMyAttendance(cloudResult.myAttendance || []);
        setNotifications(cloudResult.notifications || []);
        if (cloudResult.settings) setSettings(prev => ({
          ...prev,
          ...cloudResult.settings
        }));
        const sessionObj = {
          client: cloudResult.client,
          myBookings: cloudResult.myBookings || [],
          myAttendance: cloudResult.myAttendance || [],
          notifications: cloudResult.notifications || [],
          settings: cloudResult.settings || {},
          credentials: {
            username: cleanUser,
            password: cleanPass
          },
          savedAt: new Date().toISOString()
        };
        localStorage.setItem('al_kayan_client_session', JSON.stringify(sessionObj));
        const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
        registry[cleanUser.toLowerCase()] = sessionObj;
        localStorage.setItem('al_kayan_client_registry', JSON.stringify(registry));
        triggerToast('مرحباً بك 🌟', `تم الدخول بنجاح يا ${cloudResult.client.name} (بوابة السحاب 24/7)`, 'success');
        setIsLoggingIn(false);
        return;
      } else if (cloudResult === 'INVALID_CREDENTIALS') {
        setLoginError('اسم المستخدم أو كلمة المرور غير صحيحة. يرجى التأكد من البيانات المسجلة بالسيستم.');
        setIsLoggingIn(false);
        return;
      }
    } catch (snapErr) {
      console.warn('Snapshot lookup error:', snapErr);
    }

    // 3. Try Local Device Cache Registry (Offline Multi-Account)
    try {
      const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
      const offlineMatch = registry[cleanUser.toLowerCase()];
      const currentCached = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
      let targetSession = null;
      if (offlineMatch && (!cleanPass || offlineMatch.credentials?.password === cleanPass)) {
        targetSession = offlineMatch;
      } else if (currentCached.client && (currentCached.credentials?.username?.toLowerCase() === cleanUser.toLowerCase() || currentCached.client?.username?.toLowerCase() === cleanUser.toLowerCase())) {
        targetSession = currentCached;
      }
      if (targetSession && targetSession.client) {
        setClient(targetSession.client);
        setMyBookings(targetSession.myBookings || []);
        setMyAttendance(targetSession.myAttendance || []);
        setNotifications(targetSession.notifications || []);
        if (targetSession.settings) setSettings(prev => ({
          ...prev,
          ...targetSession.settings
        }));
        triggerToast('تشغيل 24/7 الذاتي 📱', `أهلاً بك ${targetSession.client.name} (الوضع الذاتي المستمر)`, 'info');
      } else {
        setLoginError('اسم المستخدم أو كلمة المرور غير صحيحة. يرجى التأكد من بيانات حسابك.');
      }
    } catch (cacheErr) {
      setLoginError('اسم المستخدم أو كلمة المرور غير صحيحة.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem('KAYAN_MOBILE_USER');
    setClient(null);
    setLoginForm({
      username: '',
      password: ''
    });
    setActiveTab('home');
    triggerToast('تم تسجيل الخروج', 'تم تسجيل الخروج من حسابك بأمان.', 'info');
  };

  // Real-Time Room Conflict Check for Current Booking Form
  const conflictCheck = useMemo(() => {
    if (!bookingForm.room || !bookingForm.date || !bookingForm.time) {
      return {
        hasConflict: false
      };
    }
    return checkRoomConflict(bookingForm.room, bookingForm.date, bookingForm.time, bookingForm.duration, allBookings);
  }, [bookingForm.room, bookingForm.date, bookingForm.time, bookingForm.duration, allBookings]);

  // Client Contract Details
  const contractStatus = useMemo(() => {
    return getClientContractStatus(client);
  }, [client]);

  // Handle Client Booking Submission
  const handleExecuteBooking = async e => {
    if (e) e.preventDefault();
    if (!client) return;

    // 1. Strict Date Validation (Must be tomorrow or later)
    const todayStr = new Date().toISOString().split('T')[0];
    if (bookingForm.date <= todayStr) {
      alert('⛔ وفقاً لشروط النظام: لا يمكن حجز قاعة في نفس اليوم!\nيجب أن يكون تاريخ الموعد غداً على الأقل (ابتداءً من تاريخ ' + tomorrowStr + ').');
      return;
    }

    // 2. Strict Duration Validation (Integer Hours Only)
    const durNum = parseFloat(bookingForm.duration);
    if (isNaN(durNum) || durNum <= 0 || !Number.isInteger(durNum)) {
      alert('⛔ وفقاً لشروط النظام: لا يمكن حجز نصف ساعة!\nيمكنك حجز ساعات كاملة فقط (ساعة، ساعتين، 3 ساعات، وهكذا).');
      return;
    }

    // 3. Contract Validity Check
    if (contractStatus.isExpired) {
      alert(`⛔ لا يمكنك حجز قاعة لأن اشتراكك منتهي الصلاحية!\nالسبب: ${contractStatus.reason}.\n\nيرجى التواصل مع إدارة مجموعة الكيان لتجديد الباقة.`);
      return;
    }

    // 4. Hours Balance Check (for hourly clients)
    if (!contractStatus.isFullTime && (client.currentBalance || 0) < durNum) {
      alert(`⛔ رصيدك الحالي (${client.currentBalance} ساعة) لا يكفي لحجز مدة (${durNum} ساعة)!\n\nيرجى شحن رصيد ساعات إضافي من إدارة الكيان.`);
      return;
    }

    // 5. Room Conflict Validation
    if (conflictCheck.hasConflict) {
      alert(`⚠️ القاعة "${bookingForm.room}" مشغولة في هذا التوقيت (${conflictCheck.conflictTime}) بحجز آخر!\n\nيرجى اختيار قاعة أخرى أو توقيت بديل.`);
      return;
    }

    // Submit Booking to Backend & Firebase Cloud Bridge (Immediate Hour Deduction & 24/7 Sync)
    setBookingSubmitting(true);

    // Calculate 12-Hour Time Range
    const durVal = parseFloat(bookingForm.duration) || 1;
    const parts = (bookingForm.time || '12:00').split(':');
    const h = parseInt(toStandardDigits(parts[0])) || 12;
    const m = parseInt(toStandardDigits(parts[1] || '0')) || 0;
    const endH = (h + Math.floor(durVal)) % 24;
    const endM = m;
    const to12h = (hour, minute) => {
      const period = hour >= 12 ? 'م' : 'ص';
      const h12 = hour % 12 === 0 ? 12 : hour % 12;
      const minStr = String(minute).padStart(2, '0');
      const hStr = String(h12).padStart(2, '0');
      return `${hStr}:${minStr} ${period}`;
    };
    const start12h = to12h(h, m);
    const end12h = to12h(endH, endM);
    const timeRangeStr = `من ${start12h} إلى ${end12h}`;
    const durStr = String(Math.floor(durVal));
    const nowIso = new Date().toISOString();
    const bookingId = `b-mob-${Date.now()}`;
    const targetRoom = bookingForm.room || settings.rooms && settings.rooms[0] || 'Master VIP Room';

    // Immediate hour deduction
    const oldBalNum = parseFloat(client.currentBalance || 0);
    const newBalNum = Math.max(0, oldBalNum - durVal);
    const newBalStr = newBalNum % 1 === 0 ? String(newBalNum) : String(newBalNum.toFixed(1));
    const updatedClient = {
      ...client,
      currentBalance: newBalStr
    };
    const fullBookingObj = {
      id: bookingId,
      clientId: client.id,
      clientName: client.name,
      clientPhone: client.phone,
      username: client.username,
      date: bookingForm.date,
      time: bookingForm.time,
      startTime: start12h,
      endTime: end12h,
      timeRange: timeRangeStr,
      duration: durStr,
      durationHours: durStr,
      serviceType: bookingForm.serviceType || 'حجز ذاتي من الجوال',
      room: targetRoom,
      status: 'scheduled',
      bookedVia: 'mobile_app',
      isAutoDeducted: true,
      hoursDeducted: durStr,
      newBalanceAfterBooking: newBalStr,
      notes: bookingForm.notes || 'حجز تم بواسطة العميل عبر تطبيق الجوال',
      createdAt: nowIso
    };
    const attItem = {
      id: `att-mob-${Date.now()}`,
      clientId: client.id,
      clientName: client.name,
      clientPhone: client.phone,
      date: bookingForm.date,
      time: bookingForm.time,
      startTime: start12h,
      endTime: end12h,
      timeRange: timeRangeStr,
      hoursConsumed: durStr,
      oldBalance: String(oldBalNum),
      newBalance: newBalStr,
      serviceType: `حجز قاعة (${targetRoom})`,
      notes: `خصم فوري لحجز ${targetRoom} (${timeRangeStr}) - المدة: ${durStr} ساعات`,
      source: 'mobile_app',
      createdAt: nowIso
    };

    // 1. Direct Firebase Realtime Cloud Sync (Google Cloud 0.05s Sync)
    const fbBase = 'https://alkayan-group-default-rtdb.europe-west1.firebasedatabase.app';
    try {
      // Push booking to Firebase
      fetch(`${fbBase}/alkayan_db/bookings/${bookingId}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullBookingObj)
      }).catch(() => {});

      // Update client balance in Firebase
      fetch(`${fbBase}/alkayan_db/clients.json`).then(r => r.json()).then(fbClients => {
        if (Array.isArray(fbClients)) {
          const idx = fbClients.findIndex(c => c && (c.id === client.id || c.username === client.username));
          if (idx !== -1) {
            fbClients[idx] = updatedClient;
            fetch(`${fbBase}/alkayan_db/clients.json`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(fbClients)
            }).catch(() => {});
          }
        }
      }).catch(() => {});
    } catch (fbErr) {
      console.warn('Firebase direct booking warning:', fbErr);
    }

    // 2. Also send to Backend API
    try {
      fetch('/api/client/book', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullBookingObj)
      }).catch(() => {});
    } catch (e) {}

    // 3. Immediately Update UI State & Local Storage
    setClient(updatedClient);
    setMyBookings(prev => [fullBookingObj, ...prev.filter(b => b.id !== fullBookingObj.id)]);
    setAllBookings(prev => [fullBookingObj, ...prev.filter(b => b.id !== fullBookingObj.id)]);
    setMyAttendance(prev => [attItem, ...prev]);
    try {
      const sessionObj = {
        client: updatedClient,
        myBookings: [fullBookingObj, ...myBookings],
        myAttendance: [attItem, ...myAttendance],
        notifications: notifications || [],
        settings: settings || {},
        credentials: {
          username: client.username,
          password: client.password
        },
        savedAt: nowIso
      };
      localStorage.setItem('al_kayan_client_session', JSON.stringify(sessionObj));
      const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
      if (client.username) {
        registry[client.username.toLowerCase()] = sessionObj;
        localStorage.setItem('al_kayan_client_registry', JSON.stringify(registry));
      }
    } catch (e) {}
    setBookingSuccessModal(fullBookingObj);
    triggerToast('تم الحجز وخصم الساعات 🎉', `تم تأكيد حجز ${targetRoom} (${timeRangeStr}) وخصم (${durStr}س) فورياً من رصيدك.`, 'success');
    setBookingSubmitting(false);
    return;
  };

  // Handle Cancel Booking
  const handleCancelBooking = async bookingId => {
    if (!window.confirm('هل أنت متأكد من رغبتك في إلغاء هذا الحجز؟ سيتم تحرير القاعة فوراً.')) return;
    try {
      const res = await fetch('/api/client/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          clientId: client.id,
          bookingId: bookingId
        })
      });
      const json = await res.json();
      if (json && json.success) {
        triggerToast('تم إلغاء الحجز 🗑️', 'تم إلغاء الحجز بنجاح وإتاحة القاعة.', 'info');
        fetchClientData();
      } else {
        alert(json.message || 'تعذر إلغاء الحجز.');
      }
    } catch (e) {
      alert('تعذر الاتصال بالخادم.');
    }
  };

  // Next Upcoming Booking
  const nextBooking = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const upcomings = myBookings.filter(b => b.status === 'scheduled' && b.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return upcomings.length > 0 ? upcomings[0] : null;
  }, [myBookings]);

  // ====================================================
  // 🔐 1. LOGIN SCREEN (إذا لم يكن العميل مسجل دخوله)
  // ====================================================
  if (!client) {
    return /*#__PURE__*/React.createElement("div", {
      className: "min-h-screen flex flex-col justify-between p-4 sm:p-6 max-w-md mx-auto"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pt-8 text-center space-y-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 p-0.5 shadow-2xl animate-pulse-gold flex items-center justify-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-full h-full bg-stone-950 rounded-[22px] flex items-center justify-center"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-3xl"
    }, "\uD83C\uDFDB\uFE0F"))), /*#__PURE__*/React.createElement("h1", {
      className: "text-2xl font-black text-white"
    }, "\u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646"), /*#__PURE__*/React.createElement("p", {
      className: "text-xs text-amber-300 font-bold"
    }, "\u0628\u0648\u0627\u0628\u0629 \u0627\u0644\u0639\u0645\u064A\u0644 \u0627\u0644\u0630\u0643\u064A\u0629 \u0648\u062A\u0637\u0628\u064A\u0642 \u0627\u0644\u062C\u0648\u0627\u0644 \uD83D\uDCF1"), /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] text-stone-400"
    }, "\u0627\u0644\u0643\u064A\u0627\u0646 \u064A\u0628\u062F\u0623 \u0645\u0646 \u0643\u064A\u0627\u0646 \u0644\u0647 \u0643\u064A\u0627\u0646")), /*#__PURE__*/React.createElement("div", {
      className: "glass-card p-6 rounded-3xl border-2 border-amber-500/30 shadow-2xl space-y-5 my-6"
    }, /*#__PURE__*/React.createElement("div", {
      className: "border-b border-amber-500/20 pb-3 text-center"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "text-base font-black text-white"
    }, "\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u062F\u062E\u0648\u0644 \u0625\u0644\u0649 \u062D\u0633\u0627\u0628\u0643"), /*#__PURE__*/React.createElement("p", {
      className: "text-xs text-stone-300 mt-0.5"
    }, "\u0623\u062F\u062E\u0644 \u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 \u0648\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u0645\u0633\u062C\u0644\u064A\u0646 \u0628\u0627\u0644\u0633\u064A\u0633\u062A\u0645")), loginError && /*#__PURE__*/React.createElement("div", {
      className: "p-3 bg-rose-950/80 border border-rose-500/50 rounded-2xl text-rose-300 text-xs font-bold flex items-center gap-2"
    }, /*#__PURE__*/React.createElement("span", null, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("span", null, loginError)), /*#__PURE__*/React.createElement("form", {
      onSubmit: e => {
        e.preventDefault();
        executeLogin(loginForm.username, loginForm.password);
      },
      className: "space-y-4"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-xs font-black text-amber-300 mb-1.5"
    }, "\u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 \u0623\u0648 \u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641:"), /*#__PURE__*/React.createElement("div", {
      className: "relative"
    }, /*#__PURE__*/React.createElement("input", {
      required: true,
      type: "text",
      value: loginForm.username,
      onChange: e => setLoginForm(prev => ({
        ...prev,
        username: e.target.value
      })),
      placeholder: "\u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 \u0623\u0648 \u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641 \u0627\u0644\u0645\u0633\u062C\u0644...",
      className: "w-full bg-stone-900 border border-amber-500/40 text-white font-mono rounded-2xl p-3.5 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none placeholder-stone-500"
    }), /*#__PURE__*/React.createElement("span", {
      className: "absolute left-3.5 top-3.5 text-stone-400 text-sm"
    }, "\uD83D\uDC64"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-xs font-black text-amber-300 mb-1.5"
    }, "\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 (Password):"), /*#__PURE__*/React.createElement("div", {
      className: "relative"
    }, /*#__PURE__*/React.createElement("input", {
      required: true,
      type: showPassword ? 'text' : 'password',
      value: loginForm.password,
      onChange: e => setLoginForm(prev => ({
        ...prev,
        password: e.target.value
      })),
      placeholder: "\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062E\u0627\u0635\u0629 \u0628\u0643",
      className: "w-full bg-stone-900 border border-amber-500/40 text-white font-mono rounded-2xl p-3.5 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none placeholder-stone-500"
    }), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setShowPassword(!showPassword),
      className: "absolute left-3.5 top-3 text-stone-400 hover:text-amber-300 text-sm font-bold"
    }, showPassword ? '🙈' : '👁️'))), /*#__PURE__*/React.createElement("button", {
      type: "submit",
      disabled: isLoggingIn,
      className: "w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-2xl text-sm shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
    }, isLoggingIn ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "w-4 h-4 border-2 border-stone-950 border-t-transparent rounded-full animate-spin"
    }), /*#__PURE__*/React.createElement("span", null, "\u062C\u0627\u0631\u064A \u0627\u0644\u062A\u062D\u0642\u0642 \u0648\u0627\u0644\u062F\u062E\u0648\u0644...")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD10 \u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u062F\u062E\u0648\u0644 \u0625\u0644\u0649 \u062D\u0633\u0627\u0628\u064A")))), /*#__PURE__*/React.createElement("div", {
      className: "p-3 bg-stone-900/80 border border-amber-500/20 rounded-2xl text-[11px] text-stone-300 text-center leading-relaxed"
    }, "\uD83D\uDCA1 \u064A\u062A\u0645 \u062A\u0632\u0648\u064A\u062F\u0643 \u0628\u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 \u0648\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0645\u0646 \u0625\u062F\u0627\u0631\u0629 ", /*#__PURE__*/React.createElement("b", null, "\u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646"), " \u0639\u0646\u062F \u062A\u0641\u0639\u064A\u0644 \u0627\u0644\u0628\u0627\u0642\u0629.")), /*#__PURE__*/React.createElement("div", {
      className: "text-center text-[10px] text-stone-500 pb-4"
    }, "\u062C\u0645\u064A\u0639 \u0627\u0644\u062D\u0642\u0648\u0642 \u0645\u062D\u0641\u0648\u0638\u0629 \xA9 \u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646 | AL KAYAN GROUP"));
  }

  // ====================================================
  // 📱 2. AUTHENTICATED MOBILE APP SHELL
  // ====================================================
  return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen max-w-md mx-auto flex flex-col justify-between pb-safe"
  }, toast && /*#__PURE__*/React.createElement("div", {
    className: "fixed top-4 inset-x-4 z-50 max-w-md mx-auto animate-in slide-in-from-top-4 duration-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: `p-4 rounded-2xl shadow-2xl border flex items-start gap-3 ${toast.type === 'success' ? 'bg-emerald-950 border-emerald-500/80 text-emerald-200' : toast.type === 'warning' ? 'bg-amber-950 border-amber-500/80 text-amber-200' : 'bg-stone-900 border-amber-500/50 text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xl"
  }, toast.type === 'success' ? '✅' : toast.type === 'warning' ? '⚠️' : 'ℹ️'), /*#__PURE__*/React.createElement("div", {
    className: "flex-1"
  }, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-black"
  }, toast.title), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] mt-0.5 opacity-90"
  }, toast.message)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setToast(null),
    className: "text-xs font-bold opacity-60 hover:opacity-100"
  }, "\xD7"))), /*#__PURE__*/React.createElement("header", {
    className: "sticky top-0 z-40 bg-stone-950/90 backdrop-blur-xl border-b border-amber-500/25 px-4 py-3 flex items-center justify-between shadow-lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-9 h-9 rounded-2xl bg-amber-500/20 border border-amber-500/40 text-amber-300 flex items-center justify-center font-black text-sm shadow"
  }, client.name ? client.name.charAt(0) : '🏛️'), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-xs font-black text-white truncate max-w-[150px]"
  }, client.name), /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-1 text-[9px] bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 px-1.5 py-0.5 rounded-full font-bold"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"
  }), /*#__PURE__*/React.createElement("span", null, "24/7 \u0646\u0634\u0637"))), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-300/90 font-mono font-bold"
  }, client.phone))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, isSyncing && /*#__PURE__*/React.createElement("div", {
    className: "w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin",
    title: "\u062C\u0627\u0631\u064A \u0627\u0644\u062A\u0632\u0627\u0645\u0646 \u0645\u0639 \u0627\u0644\u0633\u064A\u0633\u062A\u0645"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleLogout,
    className: "text-[11px] bg-stone-900 hover:bg-rose-950 text-stone-300 hover:text-rose-300 border border-amber-500/20 hover:border-rose-500/40 px-2.5 py-1.5 rounded-xl font-bold transition-all flex items-center gap-1"
  }, /*#__PURE__*/React.createElement("span", null, "\u062E\u0631\u0648\u062C"), /*#__PURE__*/React.createElement("span", null, "\uD83D\uDEAA")))), /*#__PURE__*/React.createElement("main", {
    className: "p-4 space-y-4 flex-1"
  }, activeTab === 'home' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-3.5 rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-950/40 via-stone-900 to-amber-950/40 flex items-center justify-between gap-3 shadow-lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-2xl"
  }, "\uD83D\uDCF2"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-black text-white"
  }, "\u062A\u062B\u0628\u064A\u062A \u0627\u0644\u062A\u0637\u0628\u064A\u0642 \u0639\u0644\u0649 \u0647\u0627\u062A\u0641\u0643"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-200 mt-0.5"
  }, "\u064A\u0639\u0645\u0644 \u0645\u0639\u0643 24/7 \u062F\u0648\u0646 \u0627\u0646\u0642\u0637\u0627\u0639 \u062D\u062A\u0649 \u0644\u0648 \u0643\u0627\u0646 \u0627\u0644\u0643\u0645\u0628\u064A\u0648\u062A\u0631 \u0645\u063A\u0644\u0642\u0627\u064B"))), /*#__PURE__*/React.createElement("button", {
    onClick: handleInstallApp,
    className: "gold-gradient-btn text-stone-950 font-black text-[11px] px-3 py-1.5 rounded-xl whitespace-nowrap shadow active:scale-95 transition-all"
  }, "\u062A\u062B\u0628\u064A\u062A \u0627\u0644\u0622\u0646 \uD83D\uDCE5")), /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-5 rounded-3xl border-2 border-amber-500/30 shadow-xl space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-start"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold text-amber-300"
  }, "\u0646\u0648\u0639 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643 \u0648\u0627\u0644\u0628\u0627\u0642\u0629:"), /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white mt-0.5"
  }, client.package)), /*#__PURE__*/React.createElement("span", {
    className: `text-[11px] font-black px-3 py-1 rounded-xl shadow border ${contractStatus.isExpired ? 'bg-rose-950 border-rose-500/50 text-rose-300' : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 animate-pulse-gold'}`
  }, contractStatus.badgeText)), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-2 pt-1 text-xs"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card-subtle p-3 rounded-2xl border border-amber-500/20"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-stone-400 font-bold"
  }, "\u062A\u0627\u0631\u064A\u062E \u0627\u0644\u0628\u062F\u0627\u064A\u0629:"), /*#__PURE__*/React.createElement("p", {
    className: "font-mono font-bold text-white mt-0.5"
  }, client.startDate || '-')), /*#__PURE__*/React.createElement("div", {
    className: "glass-card-subtle p-3 rounded-2xl border border-amber-500/20"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-stone-400 font-bold"
  }, "\u062A\u0627\u0631\u064A\u062E \u0627\u0644\u0627\u0646\u062A\u0647\u0627\u0621:"), /*#__PURE__*/React.createElement("p", {
    className: "font-mono font-bold text-amber-300 mt-0.5"
  }, client.expiryDate || 'مستمر'))), contractStatus.daysLeft !== null && /*#__PURE__*/React.createElement("div", {
    className: "p-2.5 bg-stone-900/90 rounded-2xl border border-amber-500/20 flex justify-between items-center text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-stone-300 font-bold"
  }, "\u23F1\uFE0F \u0627\u0644\u0623\u064A\u0627\u0645 \u0627\u0644\u0645\u062A\u0628\u0642\u064A\u0629 \u0641\u064A \u0627\u0644\u0639\u0642\u062F:"), /*#__PURE__*/React.createElement("span", {
    className: "font-black text-amber-300 font-mono"
  }, contractStatus.daysLeft < 0 ? `منتهي منذ ${Math.abs(contractStatus.daysLeft)} يوم` : `${contractStatus.daysLeft} يوم متبقي`))), !contractStatus.isFullTime ? (() => {
    const currentBalNum = parseFloat(client.currentBalance || 0);
    const totalHrsNum = parseFloat(client.totalHours || client.initialHours || client.hours || client.currentBalance || 0);
    const consumedNum = Math.max(0, totalHrsNum - currentBalNum);
    const formatHrs = n => n % 1 === 0 ? n : n.toFixed(1);
    return /*#__PURE__*/React.createElement("div", {
      className: "glass-card p-5 rounded-3xl border-2 border-emerald-500/40 shadow-xl bg-gradient-to-br from-stone-950 via-emerald-950/40 to-stone-950 space-y-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-center"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-xs font-black text-emerald-300 flex items-center gap-1.5"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCB3 \u0631\u0635\u064A\u062F \u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0627\u0644\u0645\u062A\u0628\u0642\u064A:")), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-lg font-mono font-bold"
    }, "\u0645\u062D\u062F\u062B \u0644\u062D\u0638\u064A\u0627\u064B \u26A1")), /*#__PURE__*/React.createElement("div", {
      className: "text-center py-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-5xl font-black text-emerald-400 font-mono tracking-tight drop-shadow-md"
    }, formatHrs(currentBalNum), " ", /*#__PURE__*/React.createElement("span", {
      className: "text-xl text-emerald-300"
    }, "\u0633\u0627\u0639\u0629")), /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] text-stone-300 mt-1 font-bold"
    }, "\u0645\u062A\u0627\u062D\u0629 \u0644\u0644\u062D\u062C\u0632 \u0648\u0627\u0644\u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0627\u0644\u0641\u0648\u0631\u064A")), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 gap-2 pt-2 border-t border-emerald-500/20 text-xs"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-center p-2 rounded-xl bg-stone-900/80 border border-amber-500/15"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-stone-400 font-bold"
    }, "\u0625\u062C\u0645\u0627\u0644\u064A \u0627\u0644\u0645\u0634\u062A\u0631\u0627\u0629:"), /*#__PURE__*/React.createElement("p", {
      className: "font-black text-white font-mono mt-0.5 text-sm"
    }, formatHrs(totalHrsNum), "\u0633")), /*#__PURE__*/React.createElement("div", {
      className: "text-center p-2 rounded-xl bg-stone-900/80 border border-rose-500/20"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-rose-300 font-bold"
    }, "\u0627\u0644\u0645\u0633\u062A\u0647\u0644\u0643 \u0628\u0627\u0644\u062E\u0635\u0645:"), /*#__PURE__*/React.createElement("p", {
      className: "font-black text-rose-400 font-mono mt-0.5 text-sm"
    }, formatHrs(consumedNum), "\u0633"))));
  })() :
  /*#__PURE__*/
  /* Full Time Notice Card */
  React.createElement("div", {
    className: "glass-card p-5 rounded-3xl border-2 border-purple-500/40 shadow-xl bg-gradient-to-br from-purple-950/40 via-stone-950 to-indigo-950/40 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-2xl"
  }, "\uD83D\uDC51"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "text-sm font-black text-purple-200"
  }, "\u0627\u0634\u062A\u0631\u0627\u0643 Full Time (\u062F\u0648\u0627\u0645 \u0643\u0627\u0645\u0644)"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-stone-300 mt-0.5"
  }, "\u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u063A\u064A\u0631 \u0645\u062D\u062F\u0648\u062F \u0644\u0644\u0642\u0627\u0639\u0627\u062A \u062E\u0644\u0627\u0644 \u0641\u062A\u0631\u0629 \u0627\u0644\u062A\u0639\u0627\u0642\u062F \u0627\u0644\u0633\u0627\u0631\u064A\u0629.")))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('book'),
    className: "w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-3xl text-sm shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\u2795"), /*#__PURE__*/React.createElement("span", null, "\u062D\u062C\u0632 \u0642\u0627\u0639\u0629 \u062C\u062F\u064A\u062F\u0629 \u0627\u0644\u0622\u0646 (\u0627\u0628\u062A\u062F\u0627\u0621\u064B \u0645\u0646 \u063A\u062F\u0627\u064B) \uD83D\uDCC5")), nextBooking && /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-4 rounded-3xl border border-amber-500/30 space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-amber-300 flex items-center gap-1"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCC5 \u062D\u062C\u0632\u0643 \u0627\u0644\u0642\u0627\u062F\u0645:")), /*#__PURE__*/React.createElement("span", {
    className: "bg-emerald-950 text-emerald-300 border border-emerald-500/40 text-[10px] font-black px-2 py-0.5 rounded-lg"
  }, "\u0645\u0624\u0643\u062F \u0642\u0627\u062F\u0645 \uD83D\uDFE2")), /*#__PURE__*/React.createElement("div", {
    className: "p-3 bg-stone-900/90 rounded-2xl border border-amber-500/20 text-xs flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "font-black text-white"
  }, nextBooking.room), /*#__PURE__*/React.createElement("p", {
    className: "text-stone-300 font-mono text-[11px] mt-0.5"
  }, "\uD83D\uDCC5 ", nextBooking.date, " \u2022 \u23F0 ", nextBooking.time, " (", nextBooking.duration, "\u0633)")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('mybookings'),
    className: "text-[11px] text-amber-300 font-bold hover:underline"
  }, "\u0639\u0631\u0636 \u0627\u0644\u062A\u0641\u0627\u0635\u064A\u0644 \u2190"))), notifications.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-4 rounded-3xl border border-amber-500/20 space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-white flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD14 \u0622\u062E\u0631 \u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A \u0648\u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A:")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('notifications'),
    className: "text-[10px] text-amber-300 font-bold"
  }, "\u0639\u0631\u0636 \u0627\u0644\u0643\u0644 (", notifications.length, ")")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5"
  }, notifications.slice(0, 2).map((n, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "p-2.5 bg-stone-900/70 border border-amber-500/15 rounded-xl text-xs flex items-start gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm mt-0.5"
  }, "\u26A1"), /*#__PURE__*/React.createElement("div", {
    className: "flex-1"
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-stone-200 text-[11px] font-bold"
  }, n.text || n.message), /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] text-stone-400 font-mono"
  }, n.time || ''))))))), activeTab === 'book' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-5 rounded-3xl border-2 border-amber-500/30 shadow-xl space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "border-b border-amber-500/20 pb-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCC5 \u062D\u062C\u0632 \u0642\u0627\u0639\u0629 \u062C\u062F\u064A\u062F\u0629")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-amber-300 mt-0.5 font-bold"
  }, "\u0627\u062E\u062A\u0631 \u0627\u0644\u0645\u0648\u0639\u062F \u0648\u0627\u0644\u0642\u0627\u0639\u0629 \u0644\u064A\u062A\u0645 \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062D\u062C\u0632 \u0641\u0648\u0631\u064A\u0627\u064B \u0628\u0627\u0644\u0633\u064A\u0633\u062A\u0645 \u0627\u0644\u0631\u0626\u064A\u0633\u064A")), /*#__PURE__*/React.createElement("div", {
    className: "p-3 bg-amber-950/40 border border-amber-500/30 rounded-2xl text-[11px] text-amber-200 space-y-1 font-bold"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1 text-amber-300 font-black"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDEE1\uFE0F \u0634\u0631\u0648\u0637 \u0648\u0642\u0648\u0627\u0639\u062F \u0627\u0644\u062D\u062C\u0632:")), /*#__PURE__*/React.createElement("ul", {
    className: "list-disc list-inside space-y-0.5 text-[10px] text-stone-300"
  }, /*#__PURE__*/React.createElement("li", null, "\u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0627\u0644\u062D\u062C\u0632 ", /*#__PURE__*/React.createElement("b", null, "\u063A\u062F\u0627\u064B \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644"), " (\u0644\u0627 \u064A\u0645\u0643\u0646 \u062D\u062C\u0632 \u0645\u0648\u0639\u062F \u0641\u064A \u0646\u0641\u0633 \u0627\u0644\u064A\u0648\u0645)."), /*#__PURE__*/React.createElement("li", null, "\u0627\u0644\u062D\u062C\u0632 \u0628\u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0627\u0644\u0643\u0627\u0645\u0644\u0629 \u0641\u0642\u0637 (1\u060C 2\u060C 3\u060C 4 \u0633\u0627\u0639\u0627\u062A - \u0628\u062F\u0648\u0646 \u0623\u0646\u0635\u0627\u0641 \u0633\u0627\u0639\u0627\u062A)."), /*#__PURE__*/React.createElement("li", null, "\u064A\u062A\u0645 ", /*#__PURE__*/React.createElement("b", null, "\u062E\u0635\u0645 \u0639\u062F\u062F \u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0641\u0648\u0631\u064A\u0627\u064B \u0648\u062A\u0644\u0642\u0627\u0626\u064A\u0627\u064B"), " \u0645\u0646 \u0631\u0635\u064A\u062F\u0643 \u0628\u0645\u062C\u0631\u062F \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062D\u062C\u0632."))), /*#__PURE__*/React.createElement("form", {
    onSubmit: handleExecuteBooking,
    className: "space-y-3.5"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-black text-amber-300 mb-1 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, "\u062A\u0627\u0631\u064A\u062E \u0627\u0644\u0645\u0648\u0639\u062F (\u0627\u0628\u062A\u062F\u0627\u0621\u064B \u0645\u0646 \u063A\u062F\u0627\u064B):"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-emerald-400 font-mono"
  }, "\uD83D\uDCC5 \u0645\u062A\u0627\u062D \u0644\u0644\u062D\u062C\u0632")), /*#__PURE__*/React.createElement("input", {
    required: true,
    type: "date",
    min: tomorrowStr,
    value: bookingForm.date,
    onChange: e => setBookingForm(b => ({
      ...b,
      date: e.target.value
    })),
    className: "w-full bg-stone-900 border-2 border-amber-500/40 text-amber-300 font-mono rounded-2xl p-3 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-black text-amber-300 mb-1"
  }, "\u0627\u062E\u062A\u0631 \u0627\u0644\u0642\u0627\u0639\u0629 / \u0627\u0644\u063A\u0631\u0641\u0629:"), /*#__PURE__*/React.createElement("select", {
    value: bookingForm.room,
    onChange: e => setBookingForm(b => ({
      ...b,
      room: e.target.value
    })),
    className: "w-full bg-stone-900 border border-amber-500/40 text-white rounded-2xl p-3 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none"
  }, (settings.rooms || []).map((r, idx) => /*#__PURE__*/React.createElement("option", {
    key: idx,
    value: r
  }, r)))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-2"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-black text-amber-300 mb-1"
  }, "\u0648\u0642\u062A \u0627\u0644\u0628\u062F\u0621:"), /*#__PURE__*/React.createElement("select", {
    value: bookingForm.time,
    onChange: e => setBookingForm(b => ({
      ...b,
      time: e.target.value
    })),
    className: "w-full bg-stone-900 border border-amber-500/40 text-white font-mono rounded-2xl p-3 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none"
  }, ['09:00 ص', '10:00 ص', '11:00 ص', '12:00 م', '01:00 م', '02:00 م', '03:00 م', '04:00 م', '05:00 م', '06:00 م', '07:00 م', '08:00 م', '09:00 م', '10:00 م'].map((t, idx) => /*#__PURE__*/React.createElement("option", {
    key: idx,
    value: t
  }, t)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-black text-amber-300 mb-1"
  }, "\u0627\u0644\u0645\u062F\u0629 (\u0633\u0627\u0639\u0627\u062A \u0635\u062D\u064A\u062D\u0629):"), /*#__PURE__*/React.createElement("select", {
    value: bookingForm.duration,
    onChange: e => setBookingForm(b => ({
      ...b,
      duration: e.target.value
    })),
    className: "w-full bg-stone-900 border border-amber-500/40 text-emerald-400 font-black rounded-2xl p-3 text-xs focus:ring-2 focus:ring-amber-400 focus:outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "1"
  }, "\u0633\u0627\u0639\u0629 \u0648\u0627\u062D\u062F\u0629 (1)"), /*#__PURE__*/React.createElement("option", {
    value: "2"
  }, "\u0633\u0627\u0639\u062A\u0627\u0646 (2)"), /*#__PURE__*/React.createElement("option", {
    value: "3"
  }, "3 \u0633\u0627\u0639\u0627\u062A"), /*#__PURE__*/React.createElement("option", {
    value: "4"
  }, "4 \u0633\u0627\u0639\u0627\u062A"), /*#__PURE__*/React.createElement("option", {
    value: "5"
  }, "5 \u0633\u0627\u0639\u0627\u062A"), /*#__PURE__*/React.createElement("option", {
    value: "6"
  }, "6 \u0633\u0627\u0639\u0627\u062A"), /*#__PURE__*/React.createElement("option", {
    value: "8"
  }, "8 \u0633\u0627\u0639\u0627\u062A (\u064A\u0648\u0645 \u0643\u0627\u0645\u0644)")))), conflictCheck.hasConflict ? /*#__PURE__*/React.createElement("div", {
    className: "p-3 bg-rose-950/80 border-2 border-rose-500/60 rounded-2xl text-rose-300 text-xs space-y-1 font-bold"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 font-black text-rose-200"
  }, /*#__PURE__*/React.createElement("span", null, "\u26D4 \u0627\u0644\u0642\u0627\u0639\u0629 \u0645\u0634\u063A\u0648\u0644\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u062A\u0648\u0642\u064A\u062A!")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px]"
  }, "\u0627\u0644\u0642\u0627\u0639\u0629 \u0645\u062D\u062C\u0648\u0632\u0629 \u0645\u0633\u0628\u0642\u0627\u064B \u0641\u064A \u0627\u0644\u0641\u062A\u0631\u0629 (", conflictCheck.conflictTime, "). \u064A\u0631\u062C\u0649 \u0627\u062E\u062A\u064A\u0627\u0631 \u0645\u0648\u0639\u062F \u0622\u062E\u0631 \u0623\u0648 \u0642\u0627\u0639\u0629 \u0628\u062F\u064A\u0644\u0629.")) : /*#__PURE__*/React.createElement("div", {
    className: "p-3 bg-emerald-950/60 border border-emerald-500/40 rounded-2xl text-emerald-300 text-xs flex items-center gap-2 font-bold"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDFE2"), /*#__PURE__*/React.createElement("span", null, "\u0627\u0644\u0642\u0627\u0639\u0629 \u0645\u062A\u0627\u062D\u0629 \u0628\u0627\u0644\u0643\u0627\u0645\u0644 \u0641\u064A \u0627\u0644\u062A\u0648\u0642\u064A\u062A \u0627\u0644\u0645\u062D\u062F\u062F!")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-black text-stone-300 mb-1"
  }, "\u0645\u0644\u0627\u062D\u0638\u0627\u062A / \u0637\u0628\u064A\u0639\u0629 \u0627\u0644\u0646\u0634\u0627\u0637 (\u0627\u062E\u062A\u064A\u0627\u0631\u064A):"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: bookingForm.notes,
    onChange: e => setBookingForm(b => ({
      ...b,
      notes: e.target.value
    })),
    placeholder: "\u0645\u062B\u0627\u0644: \u0627\u062C\u062A\u0645\u0627\u0639 \u0641\u0631\u064A\u0642 \u0627\u0644\u0639\u0645\u0644\u060C \u0648\u0631\u0634\u0629 \u062A\u062F\u0631\u064A\u0628\u064A\u0629...",
    className: "w-full bg-stone-900 border border-amber-500/30 text-white rounded-2xl p-3 text-xs focus:ring-2 focus:ring-amber-400 focus:outline-none"
  })), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    disabled: bookingSubmitting || conflictCheck.hasConflict || contractStatus.isExpired,
    className: `w-full py-4 rounded-2xl text-sm font-black shadow-xl transition-all flex items-center justify-center gap-2 ${conflictCheck.hasConflict || contractStatus.isExpired ? 'bg-stone-800 text-stone-500 cursor-not-allowed border border-stone-700' : 'gold-gradient-btn text-stone-950 active:scale-95'}`
  }, bookingSubmitting ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "w-4 h-4 border-2 border-stone-950 border-t-transparent rounded-full animate-spin"
  }), /*#__PURE__*/React.createElement("span", null, "\u062C\u0627\u0631\u064A \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062D\u062C\u0632 \u0648\u062D\u0641\u0638\u0647 \u0628\u0627\u0644\u0633\u064A\u0633\u062A\u0645...")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\u26A1 \u062A\u0623\u0643\u064A\u062F \u0648\u062D\u0641\u0638 \u062D\u062C\u0632 \u0627\u0644\u0642\u0627\u0639\u0629 \u0641\u0648\u0631\u064A\u0627\u064B")))))), activeTab === 'mybookings' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white"
  }, "\u062C\u062F\u0648\u0644 \u062D\u062C\u0648\u0632\u0627\u062A\u064A \uD83D\uDCC5"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('book'),
    className: "gold-gradient-btn text-stone-950 text-xs font-black px-3 py-1.5 rounded-xl flex items-center gap-1 shadow"
  }, /*#__PURE__*/React.createElement("span", null, "\u2795 \u062D\u062C\u0632 \u062C\u062F\u064A\u062F"))), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-1.5 overflow-x-auto pb-1"
  }, [{
    id: 'all',
    label: 'الكل'
  }, {
    id: 'scheduled',
    label: 'القادمة ⏳'
  }, {
    id: 'attended',
    label: 'المكتملة ✅'
  }, {
    id: 'cancelled',
    label: 'الملغاة ❌'
  }].map(f => /*#__PURE__*/React.createElement("button", {
    key: f.id,
    onClick: () => setBookingFilter(f.id),
    className: `px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${bookingFilter === f.id ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-black' : 'bg-stone-900/80 text-stone-400 hover:text-white border border-amber-500/10'}`
  }, f.label))), (() => {
    const filtered = myBookings.filter(b => {
      if (bookingFilter === 'all') return true;
      return b.status === bookingFilter;
    });
    if (filtered.length === 0) {
      return /*#__PURE__*/React.createElement("div", {
        className: "text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-3"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-3xl"
      }, "\uD83D\uDCC5"), /*#__PURE__*/React.createElement("p", {
        className: "text-xs text-stone-400 font-bold"
      }, "\u0644\u0627 \u062A\u0648\u062C\u062F \u062D\u062C\u0648\u0632\u0627\u062A \u0645\u0633\u062C\u0644\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u0642\u0633\u0645 \u062D\u0627\u0644\u064A\u0627\u064B."), /*#__PURE__*/React.createElement("button", {
        onClick: () => setActiveTab('book'),
        className: "gold-gradient-btn text-stone-950 text-xs font-black px-4 py-2 rounded-2xl shadow"
      }, "\u062D\u062C\u0632 \u0642\u0627\u0639\u0629 \u0627\u0644\u0622\u0646"));
    }
    return /*#__PURE__*/React.createElement("div", {
      className: "space-y-3"
    }, filtered.map(b => /*#__PURE__*/React.createElement("div", {
      key: b.id,
      className: "glass-card p-4 rounded-3xl border border-amber-500/25 space-y-3 shadow-lg"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-start"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
      className: "text-sm font-black text-white"
    }, b.room), /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] text-amber-300/90 font-mono font-bold mt-0.5"
    }, "\uD83D\uDCC5 ", b.date, " \u2022 \u23F0 ", b.time, " (", b.duration, "\u0633)")), /*#__PURE__*/React.createElement("span", {
      className: `text-[10px] font-black px-2.5 py-1 rounded-xl border ${b.status === 'scheduled' ? 'bg-emerald-950 border-emerald-500/40 text-emerald-300' : b.status === 'attended' || b.status === 'completed' ? 'bg-blue-950 border-blue-500/40 text-blue-300' : 'bg-rose-950 border-rose-500/40 text-rose-300'}`
    }, b.status === 'scheduled' ? 'مؤكد قادم ⏳' : b.status === 'attended' || b.status === 'completed' ? 'جلسة مكتملة ✅' : 'ملغي ❌')), b.notes && /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] text-stone-400 font-bold bg-stone-900/60 p-2 rounded-xl"
    }, "\uD83D\uDCDD ", b.notes), /*#__PURE__*/React.createElement("div", {
      className: "pt-2 border-t border-amber-500/15 flex items-center justify-between text-[10px]"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-emerald-300 font-black flex items-center gap-1"
    }, /*#__PURE__*/React.createElement("span", null, "\u2713"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0645 \u062E\u0635\u0645 (", b.duration || b.durationHours || 1, "\u0633) \u062A\u0644\u0642\u0627\u0626\u064A\u0627\u064B \u0645\u0646 \u0627\u0644\u0631\u0635\u064A\u062F")), /*#__PURE__*/React.createElement("span", {
      className: "text-stone-400 font-bold bg-stone-900/90 px-2 py-0.5 rounded-lg border border-amber-500/20"
    }, "\uD83D\uDD12 \u062D\u062C\u0632 \u0646\u0647\u0627\u0626\u064A \u0648\u0645\u0624\u0643\u062F")))));
  })()), activeTab === 'history' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white"
  }, "\u0633\u062C\u0644 \u0627\u0644\u062D\u0636\u0648\u0631 \u0648\u062E\u0635\u0645 \u0627\u0644\u0633\u0627\u0639\u0627\u062A \uD83D\uDCCB"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-amber-300 font-mono font-bold"
  }, myAttendance.length, " \u062C\u0644\u0633\u0629")), myAttendance.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-3xl"
  }, "\uD83D\uDCCB"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-stone-400 font-bold"
  }, "\u0644\u0645 \u064A\u062A\u0645 \u062A\u0633\u062C\u064A\u0644 \u062C\u0644\u0633\u0627\u062A \u062D\u0636\u0648\u0631 \u0623\u0648 \u062E\u0635\u0645 \u0633\u0627\u0639\u0627\u062A \u062D\u062A\u0649 \u0627\u0644\u0622\u0646.")) : /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, myAttendance.map(att => /*#__PURE__*/React.createElement("div", {
    key: att.id,
    className: "glass-card p-3.5 rounded-2xl border border-amber-500/20 flex justify-between items-center text-xs shadow"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "font-black text-white"
  }, att.serviceType || 'جلسة عمل'), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-stone-400 font-mono mt-0.5 font-bold"
  }, "\uD83D\uDCC5 ", att.date, " (", att.time, ") ", att.notes ? `• ${att.notes}` : '')), /*#__PURE__*/React.createElement("div", {
    className: "text-right"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-rose-400 text-sm"
  }, "-", att.hoursConsumed, "\u0633"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-300/80 font-bold"
  }, "\u0627\u0644\u0631\u0635\u064A\u062F \u0628\u0639\u062F\u0647\u0627: ", att.newBalance, "\u0633")))))), activeTab === 'notifications' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white"
  }, "\u0645\u0631\u0643\u0632 \u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0648\u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A \uD83D\uDD14"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-amber-300 font-mono font-bold"
  }, notifications.length, " \u0625\u0634\u0639\u0627\u0631")), notifications.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-3xl"
  }, "\uD83D\uDD14"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-stone-400 font-bold"
  }, "\u0644\u0627 \u062A\u0648\u062C\u062F \u0625\u0634\u0639\u0627\u0631\u0627\u062A \u062C\u062F\u064A\u062F\u0629 \u062D\u0627\u0644\u064A\u0627\u064B.")) : /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, notifications.map((n, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    className: "glass-card p-3.5 rounded-2xl border border-amber-500/20 flex items-start gap-3 shadow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg mt-0.5"
  }, n.type === 'deduction' ? '⚡' : n.type === 'booking' ? '📅' : n.type === 'renewal' ? '🔄' : '🔔'), /*#__PURE__*/React.createElement("div", {
    className: "flex-1"
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-xs font-bold text-white leading-relaxed"
  }, n.text || n.message), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-amber-300/80 font-mono mt-1 block"
  }, n.time || ''))))))), bookingSuccessModal && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-50 bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card bg-stone-950/95 max-w-sm w-full p-6 rounded-3xl border-2 border-emerald-500/80 text-center space-y-4 shadow-2xl animate-in zoom-in-95 duration-150"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-16 h-16 mx-auto rounded-full bg-emerald-500/20 text-emerald-400 border-2 border-emerald-500/50 flex items-center justify-center text-3xl"
  }, "\u2713"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-lg font-black text-white"
  }, "\u062A\u0645 \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062D\u062C\u0632 \u0628\u0646\u062C\u0627\u062D \uD83C\uDF89"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-emerald-300 mt-1 font-bold"
  }, "\u062A\u0645 \u062A\u0633\u062C\u064A\u0644 \u0648\u062D\u0641\u0638 \u0627\u0644\u062D\u062C\u0632 \u0628\u0627\u0644\u0633\u064A\u0633\u062A\u0645 \u0627\u0644\u0631\u0626\u064A\u0633\u064A \u0641\u064A \u0646\u0641\u0633 \u0627\u0644\u0644\u062D\u0638\u0629!")), /*#__PURE__*/React.createElement("div", {
    className: "p-3.5 bg-stone-900 rounded-2xl border border-amber-500/20 text-xs text-right space-y-1 font-mono"
  }, /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("span", {
    className: "text-amber-300 font-sans"
  }, "\u0627\u0644\u0642\u0627\u0639\u0629:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-white"
  }, bookingSuccessModal.room)), /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("span", {
    className: "text-amber-300 font-sans"
  }, "\u0627\u0644\u062A\u0627\u0631\u064A\u062E:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-white"
  }, bookingSuccessModal.date)), /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("span", {
    className: "text-amber-300 font-sans"
  }, "\u0627\u0644\u062A\u0648\u0642\u064A\u062A:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-white"
  }, bookingSuccessModal.time), " (", bookingSuccessModal.duration, " \u0633\u0627\u0639\u0627\u062A)")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2"
  }, /*#__PURE__*/React.createElement("a", {
    href: `https://wa.me/${(settings.companyPhone || '01227084903').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`أهلاً إدارة مجموعة الكيان 🌟\n\nلقد قمت بحجز موعد عبر تطبيق الجوال:\n👤 العميل: ${client.name}\n📱 الهاتف: ${client.phone}\n🏛️ القاعة: ${bookingSuccessModal.room}\n📅 التاريخ: ${bookingSuccessModal.date}\n⏰ الوقت: ${bookingSuccessModal.time} (${bookingSuccessModal.duration} ساعات)\n💳 الرصيد المتبقي: ${client.currentBalance} ساعة\n\nيرجى تأكيد الحجز بالسيستم.`)}`,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-3 rounded-2xl text-xs shadow-lg flex items-center justify-center gap-2 active:scale-95 transition-all"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCF2 \u0625\u0631\u0633\u0627\u0644 \u0625\u0634\u0639\u0627\u0631 \u0648\u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062D\u062C\u0632 \u0644\u0644\u0625\u062F\u0627\u0631\u0629 \u0639\u0628\u0631 WhatsApp")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setBookingSuccessModal(null);
      setActiveTab('mybookings');
    },
    className: "w-full gold-gradient-btn text-stone-950 font-black py-3 rounded-2xl text-xs shadow-lg active:scale-95"
  }, "\u0639\u0631\u0636 \u062C\u062F\u0648\u0644 \u062D\u062C\u0648\u0632\u0627\u062A\u064A \uD83D\uDCC5")))), /*#__PURE__*/React.createElement("nav", {
    className: "fixed bottom-0 inset-x-0 z-40 max-w-md mx-auto mobile-bottom-nav px-3 py-2 flex items-center justify-around shadow-2xl"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('home'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${activeTab === 'home' ? 'text-amber-300 scale-105' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83C\uDFE0"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-black"
  }, "\u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('book'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${activeTab === 'book' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\u2795"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold"
  }, "\u062D\u062C\u0632 \u0642\u0627\u0639\u0629")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('mybookings'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${activeTab === 'mybookings' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83D\uDCC5"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold"
  }, "\u062D\u062C\u0648\u0632\u0627\u062A\u064A")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('history'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${activeTab === 'history' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83D\uDCCB"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold"
  }, "\u0627\u0644\u0633\u062C\u0644")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('notifications'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all relative ${activeTab === 'notifications' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83D\uDD14"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold"
  }, "\u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A"))));
}

// Mount React App safely
try {
  const rootEl = document.getElementById('root');
  if (rootEl) {
    if (ReactDOM.createRoot) {
      ReactDOM.createRoot(rootEl).render( /*#__PURE__*/React.createElement(MobileApp, null));
    } else if (ReactDOM.render) {
      ReactDOM.render( /*#__PURE__*/React.createElement(MobileApp, null), rootEl);
    }
  }
} catch (e) {
  console.error('Mobile React mount error:', e);
}