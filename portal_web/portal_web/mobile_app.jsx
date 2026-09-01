const { useState, useEffect, useRef, useMemo } = React;

const INITIAL_ROOMS = ['Master VIP Room', 'MaxRoom'];
const FIREBASE_BASE_URL = 'https://alkayan-group-default-rtdb.europe-west1.firebasedatabase.app';

// Convert Arabic/Persian digits to standard digits
function toStandardDigits(str) {
  if (!str) return '';
  const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  const persianDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  return str.toString()
    .replace(/[٠-٩]/g, d => arabicDigits.indexOf(d))
    .replace(/[۰-۹]/g, d => persianDigits.indexOf(d));
}

// ====================================================
// 🕒 Time Parsing & Real-Time Interval Conflict Helpers
// ====================================================
function parseArabicTimeToDecimal(timeStr) {
  if (!timeStr) return 10.0;
  const str = toStandardDigits(timeStr).trim();
  const isPM = str.includes('م') || str.toLowerCase().includes('pm');
  const isAM = str.includes('ص') || str.toLowerCase().includes('am');

  const clean = str.replace(/[^\d:]/g, '');
  const parts = clean.split(':');
  let hours = parseInt(parts[0], 10) || 0;
  const minutes = parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0;

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  return hours + (minutes / 60);
}

function decimalToTimeStr(decimal) {
  let hours = Math.floor(decimal) % 24;
  const minutes = Math.round((decimal - Math.floor(decimal)) * 60);
  const isPM = hours >= 12;
  let displayHour = hours % 12;
  if (displayHour === 0) displayHour = 12;
  const displayMin = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const period = isPM ? 'م' : 'ص';
  const hStr = displayHour < 10 ? `0${displayHour}` : `${displayHour}`;
  return `${hStr}:${displayMin} ${period}`;
}

function isPastBooking(b) {
  if (!b || !b.date) return false;
  const todayStr = new Date().toISOString().split('T')[0];
  if (b.date < todayStr) return true;
  if (b.date > todayStr) return false;
  // If same day, check if end time passed
  const now = new Date();
  const currentDecimal = now.getHours() + (now.getMinutes() / 60);
  const startDecimal = parseArabicTimeToDecimal(b.time || b.startTime || '00:00');
  const duration = parseFloat(b.duration || b.durationHours || 1);
  return currentDecimal >= (startDecimal + duration);
}

function getBookingDisplayCategory(b) {
  if (!b) return 'scheduled';
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'attended' || b.status === 'completed') return 'attended';
  if (isPastBooking(b)) return 'attended'; // Past scheduled bookings are auto-completed
  return 'scheduled';
}

function checkRoomConflict(candRoom, candDate, candTimeStr, candDuration, allBookings, ignoreBookingId = null) {
  if (!candRoom || !candDate || !candTimeStr) return { hasConflict: false };

  const candStart = parseArabicTimeToDecimal(candTimeStr);
  const candEnd = candStart + (parseFloat(candDuration) || 1);

  const bookingsList = Array.isArray(allBookings) ? allBookings : Object.values(allBookings || {});

  for (const b of bookingsList) {
    if (!b) continue;
    if (ignoreBookingId && b.id === ignoreBookingId) continue;
    if (b.status === 'cancelled') continue; // Cancelled bookings do not occupy rooms
    if (getBookingDisplayCategory(b) !== 'scheduled') continue; // Only upcoming scheduled bookings occupy rooms

    if (b.room === candRoom && b.date === candDate) {
      const bStart = parseArabicTimeToDecimal(b.time || b.startTime);
      const bEnd = bStart + (parseFloat(b.duration || b.durationHours) || 1);

      // Overlap condition: startA < endB && endA > startB
      if (candStart < bEnd && candEnd > bStart) {
        return {
          hasConflict: true,
          conflictingBooking: b,
          conflictTime: `${decimalToTimeStr(bStart)} إلى ${decimalToTimeStr(bEnd)}`
        };
      }
    }
  }

  return { hasConflict: false };
}

function getClientContractStatus(client) {
  if (!client) return { isExpired: false, daysLeft: null, label: 'غير مسجل', badgeText: 'غير محدد' };

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

  const badgeText = isExpired ? 'منتهي الصلاحية ⛔' : (daysLeft !== null ? (daysLeft <= 7 ? `قارب على الانتهاء (${daysLeft} يوم) ⚠️` : 'ساري ونشط 🟢') : 'ساري 🟢');

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
    const handleBeforeInstall = (e) => {
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
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowInstallBanner(false);
      setDeferredPrompt(null);
    }
  };

  const [activeTab, setActiveTab] = useState('home'); // 'home' | 'book' | 'mybookings' | 'history' | 'notifications'
  
  // Auth Form State
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
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
    companyTagline: 'الكيان يبدأ من كيان له كيان',
    companyDescription: 'الكيان يبدأ من كيان له كيان',
    companyLogo: 'app_icon.png',
    companyPhone: '+201500070655',
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

  const triggerToast = (title, message, type = 'info') => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Automated Luxury Welcome Toast on App Load / Login
  useEffect(() => {
    if (client && client.name) {
      const sessionKey = 'KAYAN_WELCOMED_' + (client.id || client.username || 'user');
      if (!sessionStorage.getItem(sessionKey)) {
        sessionStorage.setItem(sessionKey, 'true');
        const hour = new Date().getHours();
        const timeGreeting = (hour >= 5 && hour < 12) ? 'صباح الخير والبركة ☀️' : 'مساء الخير والتميز 🌙';
        setTimeout(() => {
          triggerToast(
            `${timeGreeting} أ/ ${client.name} 🌟`,
            `أهلاً بك في ${settings.companyName || 'مجموعة الكيان'}. رصيدك المتاح: ${client.currentBalance || 0} ساعة. نتمنى لك وقتاً مثمراً! ✨`,
            'success'
          );
        }, 500);
      }
    }
  }, [client?.id, client?.name]);

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
            headers: { 'Content-Type': 'application/json' },
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

  const fetchClientData = async (currentClient = client) => {
    syncPendingBookings();
    if (!currentClient) return;
    try {
      setIsSyncing(true);
      let clientFound = false;

      // A. Direct Real-time Cloud Firebase Pull (Primary source of truth for mobile 24/7)
      try {
        const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db.json`, { cache: 'no-store' });
        if (fbRes.ok) {
          const fbDb = await fbRes.json();
          if (fbDb && typeof fbDb === 'object') {
            const fbClients = Array.isArray(fbDb.clients) ? fbDb.clients : [];
            const fbBookings = fbDb.bookings ? (Array.isArray(fbDb.bookings) ? fbDb.bookings : Object.values(fbDb.bookings)) : [];
            const fbAttendance = Array.isArray(fbDb.attendance) ? fbDb.attendance : [];
            const fbNotifs = Array.isArray(fbDb.notifications) ? fbDb.notifications : [];

            // Find matching client
            const matched = fbClients.find(c => c && (
              c.id === currentClient.id ||
              (currentClient.username && c.username && c.username.toLowerCase() === currentClient.username.toLowerCase()) ||
              (currentClient.phone && c.phone && c.phone === currentClient.phone)
            ));

            if (matched) {
              if (currentClient.currentBalance !== matched.currentBalance) {
                const diff = (parseFloat(currentClient.currentBalance || 0) - parseFloat(matched.currentBalance || 0)).toFixed(1);
                if (diff > 0) {
                  triggerToast('⚡ تحديث الرصيد', `تم تحديث رصيدك. الرصيد الحالي: ${matched.currentBalance}س`, 'info');
                }
              }
              setClient(matched);
              clientFound = true;

              // Filter client's bookings
              const myB = fbBookings.filter(b => b && (b.clientId === matched.id || b.username === matched.username || (matched.phone && b.clientPhone === matched.phone)));
              const myA = fbAttendance.filter(a => a && (a.clientId === matched.id || (matched.phone && a.clientPhone === matched.phone)));
              const activeScheduled = fbBookings.filter(b => b && b.status === 'scheduled');

              setMyBookings(myB);
              setAllBookings(activeScheduled);
              const myNotifs = fbNotifs.filter(n => n && (
                n.clientId === 'all' ||
                n.clientId === matched.id ||
                !n.clientId ||
                (matched.name && n.text && n.text.includes(matched.name)) ||
                (matched.name && n.message && n.message.includes(matched.name)) ||
                (matched.phone && n.clientPhone && n.clientPhone === matched.phone)
              ));
              setNotifications(myNotifs);
              setUnreadNotifCount(myNotifs.filter(n => !n.read).length);

              if (fbDb.settings) {
                setSettings(prev => ({ ...prev, ...fbDb.settings }));
                if (!bookingForm.room && fbDb.settings.rooms && fbDb.settings.rooms.length > 0) {
                  setBookingForm(b => ({ ...b, room: fbDb.settings.rooms[0] }));
                }
              }
              setLastSyncTime(new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            }
          }
        }
      } catch (fbErr) {
        console.warn('Firebase poll warning:', fbErr);
      }

      // B. Secondary Local Server API (if connected to local Wi-Fi server)
      if (!clientFound) {
        try {
          const res = await fetch(`/api/client/data?clientId=${encodeURIComponent(currentClient.id)}&username=${encodeURIComponent(currentClient.username || '')}`);
          const json = await res.json();
          if (json && json.success) {
            if (json.client) {
              if (currentClient.currentBalance !== json.client.currentBalance) {
                const diff = (parseFloat(currentClient.currentBalance || 0) - parseFloat(json.client.currentBalance || 0)).toFixed(1);
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
              setSettings(prev => ({ ...prev, ...json.settings }));
              if (!bookingForm.room && json.settings.rooms && json.settings.rooms.length > 0) {
                setBookingForm(b => ({ ...b, room: json.settings.rooms[0] }));
              }
            }
            setLastSyncTime(new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
          }
        } catch (apiErr) {}
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

  // Helper to lookup client in live cloud sources (Firebase Realtime DB -> Vercel Serverless -> Static Snapshot)
  const lookupInCloudSnapshot = async (cleanUser, cleanPass) => {
    let portalData = null;

    // 1. Direct Firebase Realtime Database (Primary Live Source)
    try {
      const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db.json`, { cache: 'no-store' });
      if (fbRes.ok) {
        const fbJson = await fbRes.json();
        if (fbJson && Array.isArray(fbJson.clients) && fbJson.clients.length > 0) {
          portalData = fbJson;
          window.ALKAYAN_PORTAL_DATA = fbJson;
        }
      }
    } catch (fbErr) {
      console.log('Firebase fetch note:', fbErr);
    }

    // 2. ALWAYS fetch fresh data from Vercel Serverless /api/sync
    if (!portalData) {
      try {
        const sRes = await fetch('/api/sync?t=' + Date.now(), { cache: 'no-store' });
        if (sRes.ok) {
          const sJson = await sRes.json();
          if (sJson && sJson.data && Array.isArray(sJson.data.clients) && sJson.data.clients.length > 0) {
            portalData = sJson.data;
            window.ALKAYAN_PORTAL_DATA = portalData;
          }
        }
      } catch (sErr) {
        console.log('Could not reach /api/sync, falling back to cached data');
      }
    }

    // 3. Fallback to portal_data.json or window
    if (!portalData) {
      try {
        const pRes = await fetch('./portal_data.json?t=' + Date.now(), { cache: 'no-store' });
        if (pRes.ok) {
          portalData = await pRes.json();
          window.ALKAYAN_PORTAL_DATA = portalData;
        }
      } catch (err) {}
    }

    if (!portalData) {
      portalData = window.ALKAYAN_PORTAL_DATA;
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
      const userMatch = (cUser && cUser === uLow) ||
                        (cPhone && cPhone === cleanUser) ||
                        (cleanUserDigitsOnly && cPhoneDigitsOnly && (cPhoneDigitsOnly.endsWith(cleanUserDigitsOnly) || cleanUserDigitsOnly.endsWith(cPhoneDigitsOnly))) ||
                        (cName && cName === uLow) ||
                        (cId && cId === uLow);

      if (userMatch) {
        // Verify password
        if (cPass === cleanPass || !cPass || !cleanPass) {
          const rawBookings = portalData.bookings || [];
          const bookingsList = Array.isArray(rawBookings) ? rawBookings : Object.values(rawBookings);
          const rawAttendance = portalData.attendance || [];
          const attendanceList = Array.isArray(rawAttendance) ? rawAttendance : Object.values(rawAttendance);

          const myB = bookingsList.filter(b => b && (b.clientId === c.id || b.username === c.username || (c.phone && b.clientPhone === c.phone)));
          const myA = attendanceList.filter(a => a && (a.clientId === c.id || (c.phone && a.clientPhone === c.phone)));
          return {
            client: c,
            myBookings: myB,
            myAttendance: myA,
            allBookings: bookingsList.filter(b => b && b.status === 'scheduled'),
            notifications: [],
            settings: portalData.settings || {}
          };
        }
      }
    }
    return 'INVALID_CREDENTIALS';
  };

  // Execute Login with 3-Layer Authentication (Server API -> Cloud Portal Snapshot -> Local Device Registry)
  const executeLogin = async (username, password, isAuto = false) => {
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUser, password: cleanPass })
      });

      if (res.ok) {
        const json = await res.json();
        if (json && json.success) {
          setClient(json.client);
          setMyBookings(json.myBookings || []);
          setAllBookings(json.allBookings || []);
          setMyAttendance(json.myAttendance || []);
          setNotifications(json.notifications || []);
          if (json.settings) setSettings(prev => ({ ...prev, ...json.settings }));

          const sessionObj = {
            client: json.client,
            myBookings: json.myBookings || [],
            myAttendance: json.myAttendance || [],
            notifications: json.notifications || [],
            settings: json.settings || {},
            credentials: { username: cleanUser, password: cleanPass },
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
        if (cloudResult.settings) setSettings(prev => ({ ...prev, ...cloudResult.settings }));

        const sessionObj = {
          client: cloudResult.client,
          myBookings: cloudResult.myBookings || [],
          myAttendance: cloudResult.myAttendance || [],
          notifications: cloudResult.notifications || [],
          settings: cloudResult.settings || {},
          credentials: { username: cleanUser, password: cleanPass },
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
        if (targetSession.settings) setSettings(prev => ({ ...prev, ...targetSession.settings }));
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
    setLoginForm({ username: '', password: '' });
    setActiveTab('home');
    triggerToast('تم تسجيل الخروج', 'تم تسجيل الخروج من حسابك بأمان.', 'info');
  };

  // Real-Time Room Conflict Check for Current Booking Form
  const conflictCheck = useMemo(() => {
    if (!bookingForm.room || !bookingForm.date || !bookingForm.time) {
      return { hasConflict: false };
    }
    return checkRoomConflict(bookingForm.room, bookingForm.date, bookingForm.time, bookingForm.duration, allBookings);
  }, [bookingForm.room, bookingForm.date, bookingForm.time, bookingForm.duration, allBookings]);

  // Real-Time Occupied Slots for Selected Room and Date
  const dayOccupiedSlots = useMemo(() => {
    const targetDate = bookingForm.date;
    const targetRoom = bookingForm.room;
    if (!targetDate || !targetRoom) return [];

    const bookingsList = Array.isArray(allBookings) ? allBookings : Object.values(allBookings || {});
    return bookingsList.filter(b => {
      if (!b) return false;
      if (b.status === 'cancelled') return false;
      if (getBookingDisplayCategory(b) !== 'scheduled') return false;
      return b.room === targetRoom && b.date === targetDate;
    }).sort((a, b) => {
      const aDec = parseArabicTimeToDecimal(a.time || a.startTime);
      const bDec = parseArabicTimeToDecimal(b.time || b.startTime);
      return aDec - bDec;
    });
  }, [allBookings, bookingForm.date, bookingForm.room]);

  // Stats for My Bookings Categorization
  const myBookingsStats = useMemo(() => {
    const all = myBookings || [];
    let scheduled = 0;
    let attended = 0;
    let cancelled = 0;

    all.forEach(b => {
      const cat = getBookingDisplayCategory(b);
      if (cat === 'scheduled') scheduled++;
      else if (cat === 'attended') attended++;
      else if (cat === 'cancelled') cancelled++;
    });

    return {
      total: all.length,
      scheduled,
      attended,
      cancelled
    };
  }, [myBookings]);

  // Filtered List for My Bookings
  const filteredMyBookings = useMemo(() => {
    const all = myBookings || [];
    return all.filter(b => {
      if (bookingFilter === 'all') return true;
      const cat = getBookingDisplayCategory(b);
      return cat === bookingFilter;
    });
  }, [myBookings, bookingFilter]);

  // Client Contract Details
  const contractStatus = useMemo(() => {
    return getClientContractStatus(client);
  }, [client]);

  // Handle Client Booking Submission
  const handleExecuteBooking = async (e) => {
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
    const targetRoom = bookingForm.room || (settings.rooms && settings.rooms[0]) || 'Master VIP Room';

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
    try {
      // A. Push booking to Firebase
      await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${bookingId}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullBookingObj)
      });

      // B. Update client balance in Firebase
      try {
        const fbClientsRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json`, { cache: 'no-store' });
        if (fbClientsRes.ok) {
          const fbClients = await fbClientsRes.json();
          if (Array.isArray(fbClients)) {
            const idx = fbClients.findIndex(c => c && (
              c.id === client.id ||
              (client.username && c.username && c.username.toLowerCase() === client.username.toLowerCase()) ||
              (client.phone && c.phone && c.phone === client.phone)
            ));
            if (idx !== -1) {
              fbClients[idx] = updatedClient;
              await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fbClients)
              });
            }
          }
        }
      } catch (e) {}

      // C. Push attendance record to Firebase
      await fetch(`${FIREBASE_BASE_URL}/alkayan_db/attendance/${attItem.id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attItem)
      });
    } catch (fbErr) {
      console.warn('Firebase direct booking warning:', fbErr);
    }

    // 2. Also send to Backend API
    try {
      fetch('/api/client/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        credentials: { username: client.username, password: client.password },
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

  // Handle Cancel Booking (Direct Firebase Cloud 24/7 + Local Server)
  const handleCancelBooking = async (bookingId) => {
    if (!window.confirm('هل أنت متأكد من رغبتك في إلغاء هذا الحجز؟ سيتم تحرير القاعة فوراً وإتاحتها للآخرين.')) return;

    try {
      // 1. Direct Firebase Realtime Database status update
      try {
        await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${bookingId}/status.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify('cancelled')
        });
      } catch (fbErr) {
        console.warn('Firebase cancel warning:', fbErr);
      }

      // 2. Secondary Local Server API
      try {
        await fetch('/api/client/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: client.id,
            bookingId: bookingId
          })
        });
      } catch (apiErr) {}

      // 3. Immediately update UI state & release room
      setMyBookings(prev => prev.map(b => b.id === bookingId ? { ...b, status: 'cancelled' } : b));
      setAllBookings(prev => prev.map(b => b.id === bookingId ? { ...b, status: 'cancelled' } : b));

      triggerToast('تم إلغاء الحجز 🗑️', 'تم إلغاء الحجز بنجاح وتحرير القاعة في السحابة فورياً.', 'info');
      setTimeout(() => fetchClientData(), 500);
    } catch (e) {
      alert('حدث خطأ أثناء إلغاء الحجز.');
    }
  };

  // Next Upcoming Booking
  const nextBooking = useMemo(() => {
    const upcomings = (myBookings || [])
      .filter(b => b && getBookingDisplayCategory(b) === 'scheduled')
      .sort((a, b) => (a.date + (a.time || a.startTime || '')).localeCompare(b.date + (b.time || b.startTime || '')));
    return upcomings.length > 0 ? upcomings[0] : null;
  }, [myBookings]);

  // ====================================================
  // 🔐 1. LOGIN SCREEN (إذا لم يكن العميل مسجل دخوله)
  // ====================================================
  if (!client) {
    return (
      <div className="min-h-screen flex flex-col justify-between p-4 sm:p-6 max-w-md mx-auto">
        
        {/* Top Branding */}
        <div className="pt-6 text-center space-y-2.5">
          <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto rounded-2xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 p-0.5 shadow-xl animate-pulse-gold flex items-center justify-center">
            <img src="app_icon.png" alt="Al Kayan Logo" className="w-full h-full object-cover rounded-[14px]" onError={(e) => { e.target.style.display = 'none'; }} />
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white">مجموعة الكيان</h1>
          <p className="text-xs text-amber-300 font-bold">بوابة العميل الذكية وتطبيق الجوال 📱</p>
          <p className="text-[11px] text-stone-400">الكيان يبدأ من كيان له كيان</p>
        </div>

        {/* Login Card */}
        <div className="glass-card p-6 rounded-3xl border-2 border-amber-500/30 shadow-2xl space-y-5 my-6">
          <div className="border-b border-amber-500/20 pb-3 text-center">
            <h2 className="text-base font-black text-white">تسجيل الدخول إلى حسابك</h2>
            <p className="text-xs text-stone-300 mt-0.5">أدخل اسم المستخدم وكلمة المرور المسجلين بالسيستم</p>
          </div>

          {loginError && (
            <div className="p-3 bg-rose-950/80 border border-rose-500/50 rounded-2xl text-rose-300 text-xs font-bold flex items-center gap-2">
              <span>⚠️</span>
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); executeLogin(loginForm.username, loginForm.password); }} className="space-y-4">
            <div>
              <label className="block text-xs font-black text-amber-300 mb-1.5">اسم المستخدم أو رقم الهاتف:</label>
              <div className="relative">
                <input
                  required
                  type="text"
                  value={loginForm.username}
                  onChange={(e) => setLoginForm(prev => ({ ...prev, username: e.target.value }))}
                  placeholder="اسم المستخدم أو رقم الهاتف المسجل..."
                  className="w-full bg-stone-900 border border-amber-500/40 text-white font-mono rounded-2xl p-3.5 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none placeholder-stone-500"
                />
                <span className="absolute left-3.5 top-3.5 text-stone-400 text-sm">👤</span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-black text-amber-300 mb-1.5">كلمة المرور (Password):</label>
              <div className="relative">
                <input
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={loginForm.password}
                  onChange={(e) => setLoginForm(prev => ({ ...prev, password: e.target.value }))}
                  placeholder="كلمة المرور الخاصة بك"
                  className="w-full bg-stone-900 border border-amber-500/40 text-white font-mono rounded-2xl p-3.5 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none placeholder-stone-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-3.5 top-3 text-stone-400 hover:text-amber-300 text-sm font-bold"
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-2xl text-sm shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              {isLoggingIn ? (
                <>
                  <div className="w-4 h-4 border-2 border-stone-950 border-t-transparent rounded-full animate-spin"></div>
                  <span>جاري التحقق والدخول...</span>
                </>
              ) : (
                <>
                  <span>🔐 تسجيل الدخول إلى حسابي</span>
                </>
              )}
            </button>
          </form>

          <div className="p-3 bg-stone-900/80 border border-amber-500/20 rounded-2xl text-[11px] text-stone-300 text-center leading-relaxed">
            💡 يتم تزويدك باسم المستخدم وكلمة المرور من إدارة <b>مجموعة الكيان</b> عند تفعيل الباقة.
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-[10px] text-stone-500 pb-4">
          جميع الحقوق محفوظة © مجموعة الكيان | AL KAYAN GROUP
        </div>

      </div>
    );
  }

  // ====================================================
  // 📱 2. AUTHENTICATED MOBILE APP SHELL
  // ====================================================
  return (
    <div className="min-h-screen max-w-md mx-auto flex flex-col justify-between pb-safe">
      
      {/* Toast Notification Popup */}
      {toast && (
        <div className="fixed top-4 inset-x-4 z-50 max-w-md mx-auto animate-in slide-in-from-top-4 duration-200">
          <div className={`p-4 rounded-2xl shadow-2xl border flex items-start gap-3 ${
            toast.type === 'success' ? 'bg-emerald-950 border-emerald-500/80 text-emerald-200' :
            toast.type === 'warning' ? 'bg-amber-950 border-amber-500/80 text-amber-200' :
            'bg-stone-900 border-amber-500/50 text-white'
          }`}>
            <span className="text-xl">
              {toast.type === 'success' ? '✅' : toast.type === 'warning' ? '⚠️' : 'ℹ️'}
            </span>
            <div className="flex-1">
              <h4 className="text-xs font-black">{toast.title}</h4>
              <p className="text-[11px] mt-0.5 opacity-90">{toast.message}</p>
            </div>
            <button onClick={() => setToast(null)} className="text-xs font-bold opacity-60 hover:opacity-100">×</button>
          </div>
        </div>
      )}

      {/* 🌟 LUXURY ROYAL HEADER: Company Identity & Client Profile */}
      <header className="sticky top-0 z-40 bg-stone-950/95 backdrop-blur-2xl border-b border-amber-500/30 px-3 sm:px-4 py-3 shadow-2xl space-y-2.5">
        
        {/* Top Row: Company Branding + Action Controls */}
        <div className="flex items-center justify-between gap-2">
          
          {/* Company Logo, Name & Official Slogan */}
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className="relative flex-shrink-0">
              <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 p-0.5 shadow-lg flex items-center justify-center">
                <img
                  src={settings.companyLogo || 'app_icon.png'}
                  alt="Logo"
                  className="w-full h-full object-cover rounded-[14px]"
                  onError={(e) => {
                    if (e.target.src !== 'app_icon.png') {
                      e.target.src = 'app_icon.png';
                    }
                  }}
                />
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-stone-950 rounded-full shadow"></span>
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="text-xs sm:text-sm font-black text-white truncate tracking-wide flex items-center gap-1.5">
                <span>{settings.companyName || 'مجموعة الكيان | AL KAYAN GROUP'}</span>
              </h1>
              <p className="text-[10px] text-amber-300/85 font-bold truncate leading-tight mt-0.5">
                {settings.companyTagline || settings.companyDescription || 'الكيان يبدأ من كيان له كيان'}
              </p>
            </div>
          </div>

          {/* Left Controls: Sync Indicator & Logout Button */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {isSyncing && (
              <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" title="جاري التزامن اللحظي بالسحابة"></div>
            )}

            <button
              onClick={handleLogout}
              className="bg-stone-900/90 hover:bg-rose-950/80 text-stone-300 hover:text-rose-300 border border-amber-500/25 hover:border-rose-500/50 px-2.5 py-1.5 rounded-xl font-black text-[11px] shadow transition-all flex items-center gap-1 active:scale-95"
              title="تسجيل الخروج من الحساب"
            >
              <span>خروج</span>
              <span className="text-xs">🚪</span>
            </button>
          </div>
        </div>

        {/* Bottom Row: Client Identity Strip (Name, Phone, Status & Balance) */}
        <div className="bg-gradient-to-r from-stone-900 via-amber-950/40 to-stone-900 border border-amber-500/30 rounded-2xl p-2 sm:p-2.5 flex items-center justify-between gap-2 shadow-inner">
          
          {/* Client Avatar & Name & Phone */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-500/30 to-amber-700/20 border border-amber-500/50 text-amber-300 flex items-center justify-center font-black text-xs shadow-sm flex-shrink-0">
              {client.name ? client.name.charAt(0) : '👤'}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-black text-white truncate max-w-[120px] sm:max-w-[160px]">{client.name}</span>
                <span className="flex items-center gap-1 text-[8px] sm:text-[9px] bg-emerald-950/90 border border-emerald-500/40 text-emerald-300 px-1.5 py-0.5 rounded-full font-black whitespace-nowrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span>24/7 نشط</span>
                </span>
              </div>
              <p className="text-[10px] text-amber-300/90 font-mono font-bold leading-none mt-0.5" dir="ltr">{client.phone}</p>
            </div>
          </div>

          {/* Client Balance Badge */}
          <div className="flex-shrink-0 text-left">
            <div className="bg-stone-950/90 border border-amber-500/30 rounded-xl px-2.5 py-1 text-center shadow">
              <span className="text-[9px] text-stone-400 block font-bold leading-none">رصيدك المتبقي</span>
              <span className="text-xs font-black text-amber-400 font-mono mt-0.5 block leading-none">
                {client.currentBalance} <span className="text-[9px] font-sans">ساعة</span>
              </span>
            </div>
          </div>

        </div>

      </header>

      {/* Main Screen Content */}
      <main className="p-4 space-y-4 flex-1">
        
        {/* ==================================================== */}
        {/* 🏠 TAB 1: الرئيسية (Dashboard) */}
        {/* ==================================================== */}
        {activeTab === 'home' && (
          <div className="space-y-4">
            
            {/* ✨ Personalized Luxury Welcome Card */}
            <div className="glass-card p-4 rounded-3xl border-2 border-amber-500/35 bg-gradient-to-br from-amber-950/50 via-stone-900 to-stone-950 relative overflow-hidden shadow-xl space-y-2">
              <div className="absolute -left-6 -top-6 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl pointer-events-none"></div>
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="text-2xl animate-bounce">🌟</span>
                  <div>
                    <span className="text-[10px] text-amber-300 font-bold block">
                      {new Date().getHours() < 12 ? 'صباح الخير والبركة ☀️' : 'مساء الخير والتميز 🌙'}
                    </span>
                    <h3 className="text-sm sm:text-base font-black text-white">
                      أهلاً بك، {client.name} في {settings.companyName || 'مجموعة الكيان'} ✨
                    </h3>
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-stone-300 leading-relaxed font-medium">
                يسعدنا تواجدك معنا! حسابك وحجوزاتك متاحة 24/7، يمكنك حجز قاعاتك ومتابعة رصيدك بكل سهولة وسرعة.
              </p>
            </div>
            
                        {/* 📲 24/7 PWA Install Banner */}
            <div className="glass-card p-3.5 rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-950/40 via-stone-900 to-amber-950/40 flex items-center justify-between gap-3 shadow-lg">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">📲</span>
                <div>
                  <h4 className="text-xs font-black text-white">تثبيت التطبيق على هاتفك</h4>
                  <p className="text-[10px] text-amber-200 mt-0.5">وصول سريع ومباشر لحسابك وحجوزاتك في أي وقت 24/7</p>
                </div>
              </div>
              <button
                onClick={handleInstallApp}
                className="gold-gradient-btn text-stone-950 font-black text-[11px] px-3 py-1.5 rounded-xl whitespace-nowrap shadow active:scale-95 transition-all"
              >
                تثبيت الآن 📥
              </button>
            </div>

            {/* Account Status Card */}
            <div className="glass-card p-5 rounded-3xl border-2 border-amber-500/30 shadow-xl space-y-4">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-[10px] font-bold text-amber-300">نوع الاشتراك والباقة:</span>
                  <h3 className="text-base font-black text-white mt-0.5">{client.package}</h3>
                </div>
                <span className={`text-[11px] font-black px-3 py-1 rounded-xl shadow border ${
                  contractStatus.isExpired 
                    ? 'bg-rose-950 border-rose-500/50 text-rose-300' 
                    : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 animate-pulse-gold'
                }`}>
                  {contractStatus.badgeText}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                <div className="glass-card-subtle p-3 rounded-2xl border border-amber-500/20">
                  <span className="text-[10px] text-stone-400 font-bold">تاريخ البداية:</span>
                  <p className="font-mono font-bold text-white mt-0.5">{client.startDate || '-'}</p>
                </div>
                <div className="glass-card-subtle p-3 rounded-2xl border border-amber-500/20">
                  <span className="text-[10px] text-stone-400 font-bold">تاريخ الانتهاء:</span>
                  <p className="font-mono font-bold text-amber-300 mt-0.5">{client.expiryDate || 'مستمر'}</p>
                </div>
              </div>

              {contractStatus.daysLeft !== null && (
                <div className="p-2.5 bg-stone-900/90 rounded-2xl border border-amber-500/20 flex justify-between items-center text-xs">
                  <span className="text-stone-300 font-bold">⏱️ الأيام المتبقية في العقد:</span>
                  <span className="font-black text-amber-300 font-mono">
                    {contractStatus.daysLeft < 0 ? `منتهي منذ ${Math.abs(contractStatus.daysLeft)} يوم` : `${contractStatus.daysLeft} يوم متبقي`}
                  </span>
                </div>
              )}
            </div>

            {/* Hours Balance Card (Instant Dynamic Update on Mobile Booking) */}
            {!contractStatus.isFullTime ? (
              (() => {
                const currentBalNum = parseFloat(client.currentBalance || 0);
                const totalHrsNum = parseFloat(client.totalHours || client.initialHours || client.hours || client.currentBalance || 0);
                const consumedNum = Math.max(0, totalHrsNum - currentBalNum);
                
                const formatHrs = (n) => (n % 1 === 0 ? n : n.toFixed(1));

                return (
                <div className="glass-card p-5 rounded-3xl border-2 border-emerald-500/40 shadow-xl bg-gradient-to-br from-stone-950 via-emerald-950/40 to-stone-950 space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-black text-emerald-300 flex items-center gap-1.5">
                      <span>💳 رصيد الساعات المتبقي:</span>
                    </span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-lg font-mono font-bold">
                      محدث لحظياً ⚡
                    </span>
                  </div>

                  <div className="text-center py-2">
                    <div className="text-5xl font-black text-emerald-400 font-mono tracking-tight drop-shadow-md">
                      {formatHrs(currentBalNum)} <span className="text-xl text-emerald-300">ساعة</span>
                    </div>
                    <p className="text-[11px] text-stone-300 mt-1 font-bold">متاحة للحجز والاستخدام الفوري</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-emerald-500/20 text-xs">
                    <div className="text-center p-2 rounded-xl bg-stone-900/80 border border-amber-500/15">
                      <span className="text-[10px] text-stone-400 font-bold">إجمالي المشتراة:</span>
                      <p className="font-black text-white font-mono mt-0.5 text-sm">{formatHrs(totalHrsNum)}س</p>
                    </div>
                    <div className="text-center p-2 rounded-xl bg-stone-900/80 border border-rose-500/20">
                      <span className="text-[10px] text-rose-300 font-bold">المستهلك بالخصم:</span>
                      <p className="font-black text-rose-400 font-mono mt-0.5 text-sm">
                        {formatHrs(consumedNum)}س
                      </p>
                    </div>
                  </div>
                </div>
                );
              })()
            ) : (
              /* Full Time Notice Card */
              <div className="glass-card p-5 rounded-3xl border-2 border-purple-500/40 shadow-xl bg-gradient-to-br from-purple-950/40 via-stone-950 to-indigo-950/40 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">👑</span>
                  <div>
                    <h4 className="text-sm font-black text-purple-200">اشتراك Full Time (دوام كامل)</h4>
                    <p className="text-[11px] text-stone-300 mt-0.5">استخدام غير محدود للقاعات خلال فترة التعاقد السارية.</p>
                  </div>
                </div>
              </div>
            )}

            {/* Quick Action: Book Room Button */}
            <button
              onClick={() => setActiveTab('book')}
              className="w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-3xl text-sm shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <span className="text-lg">➕</span>
              <span>حجز قاعة جديدة الآن (ابتداءً من غداً) 📅</span>
            </button>

            {/* Next Scheduled Session / Booking */}
            {nextBooking && (
              <div className="glass-card p-4 rounded-3xl border border-amber-500/30 space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-black text-amber-300 flex items-center gap-1">
                    <span>📅 حجزك القادم:</span>
                  </span>
                  <span className="bg-emerald-950 text-emerald-300 border border-emerald-500/40 text-[10px] font-black px-2 py-0.5 rounded-lg">
                    مؤكد قادم 🟢
                  </span>
                </div>
                <div className="p-3 bg-stone-900/90 rounded-2xl border border-amber-500/20 text-xs flex justify-between items-center">
                  <div>
                    <h4 className="font-black text-white">{nextBooking.room}</h4>
                    <p className="text-stone-300 font-mono text-[11px] mt-0.5">
                      📅 {nextBooking.date} • ⏰ {nextBooking.time} ({nextBooking.duration}س)
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab('mybookings')}
                    className="text-[11px] text-amber-300 font-bold hover:underline"
                  >
                    عرض التفاصيل ←
                  </button>
                </div>
              </div>
            )}

            {/* Recent Notifications Snippet */}
            {notifications.length > 0 && (
              <div className="glass-card p-4 rounded-3xl border border-amber-500/20 space-y-2.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-black text-white flex items-center gap-1.5">
                    <span>🔔 آخر التنبيهات والإشعارات:</span>
                  </span>
                  <button onClick={() => setActiveTab('notifications')} className="text-[10px] text-amber-300 font-bold">
                    عرض الكل ({notifications.length})
                  </button>
                </div>
                <div className="space-y-1.5">
                  {notifications.slice(0, 2).map((n, i) => (
                    <div key={i} className="p-2.5 bg-stone-900/70 border border-amber-500/15 rounded-xl text-xs flex items-start gap-2">
                      <span className="text-sm mt-0.5">⚡</span>
                      <div className="flex-1">
                        <p className="text-stone-200 text-[11px] font-bold">{n.text || n.message}</p>
                        <span className="text-[9px] text-stone-400 font-mono">{n.time || ''}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}

        {/* ==================================================== */}
        {/* ➕ TAB 2: حجز قاعة جديدة (Book Room) */}
        {/* ==================================================== */}
        {activeTab === 'book' && (
          <div className="space-y-4">
            
            <div className="glass-card p-5 rounded-3xl border-2 border-amber-500/30 shadow-xl space-y-4">
              <div className="border-b border-amber-500/20 pb-3">
                <h3 className="text-base font-black text-white flex items-center gap-2">
                  <span>📅 حجز قاعة جديدة</span>
                </h3>
                <p className="text-xs text-amber-300 mt-0.5 font-bold">اختر الموعد والقاعة ليتم تأكيد الحجز فورياً بالسيستم الرئيسي</p>
              </div>

              {/* Strict Rule Notice Box */}
              <div className="p-3 bg-amber-950/40 border border-amber-500/30 rounded-2xl text-[11px] text-amber-200 space-y-1 font-bold">
                <div className="flex items-center gap-1 text-amber-300 font-black">
                  <span>🛡️ شروط وقواعد الحجز:</span>
                </div>
                <ul className="list-disc list-inside space-y-0.5 text-[10px] text-stone-300">
                  <li>يجب أن يكون الحجز <b>غداً على الأقل</b> (لا يمكن حجز موعد في نفس اليوم).</li>
                  <li>الحجز بالساعات الكاملة فقط (1، 2، 3، 4 ساعات - بدون أنصاف ساعات).</li>
                  <li>يتم <b>خصم عدد الساعات فورياً وتلقائياً</b> من رصيدك بمجرد تأكيد الحجز.</li>
                </ul>
              </div>

              <form onSubmit={handleExecuteBooking} className="space-y-3.5">
                
                {/* 1. Date Picker (Strictly >= Tomorrow) */}
                <div>
                  <label className="block text-xs font-black text-amber-300 mb-1 flex items-center justify-between">
                    <span>تاريخ الموعد (ابتداءً من غداً):</span>
                    <span className="text-[10px] text-emerald-400 font-mono">📅 متاح للحجز</span>
                  </label>
                  <input
                    required
                    type="date"
                    min={tomorrowStr}
                    value={bookingForm.date}
                    onChange={(e) => setBookingForm(b => ({ ...b, date: e.target.value }))}
                    className="w-full bg-stone-900 border-2 border-amber-500/40 text-amber-300 font-mono rounded-2xl p-3 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none"
                  />
                </div>

                {/* 2. Room Selector */}
                <div>
                  <label className="block text-xs font-black text-amber-300 mb-1">اختر القاعة / الغرفة:</label>
                  <select
                    value={bookingForm.room}
                    onChange={(e) => setBookingForm(b => ({ ...b, room: e.target.value }))}
                    className="w-full bg-stone-900 border border-amber-500/40 text-white rounded-2xl p-3 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none"
                  >
                    {(settings.rooms || []).map((r, idx) => (
                      <option key={idx} value={r}>{r}</option>
                    ))}
                  </select>
                </div>

                {/* 📊 Live Room Availability Timeline for Selected Date */}
                <div className="p-3.5 bg-stone-900/90 border border-amber-500/25 rounded-2xl space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-black text-amber-300 flex items-center gap-1.5">
                      <span>📊 حالة ({bookingForm.room}) ليوم ({bookingForm.date}):</span>
                    </span>
                    {dayOccupiedSlots.length === 0 ? (
                      <span className="text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-lg font-bold">
                        متاحة بالكامل 🟢
                      </span>
                    ) : (
                      <span className="text-[10px] bg-amber-950 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-lg font-bold">
                        {dayOccupiedSlots.length} حجز مسجل ⚠️
                      </span>
                    )}
                  </div>
                  {dayOccupiedSlots.length > 0 ? (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-[10px] text-stone-400 font-bold">الأوقات المشغولة بالقاعة في هذا اليوم (غير متاحة):</p>
                      <div className="flex flex-wrap gap-1.5">
                        {dayOccupiedSlots.map(s => {
                          const sStart = parseArabicTimeToDecimal(s.time || s.startTime);
                          const sDur = parseFloat(s.duration || s.durationHours || 1);
                          const sEnd = sStart + sDur;
                          const range = s.timeRange || `من ${decimalToTimeStr(sStart)} إلى ${decimalToTimeStr(sEnd)}`;
                          return (
                            <span key={s.id} className="text-[10px] bg-rose-950/80 border border-rose-500/40 text-rose-300 px-2.5 py-1 rounded-xl font-mono font-bold flex items-center gap-1">
                              <span>🔒</span>
                              <span>{range} ({sDur}س)</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-emerald-300 font-bold">كافة الأوقات متاحة للحجز في هذه القاعة لهذا اليوم دون أي تعارض.</p>
                  )}
                </div>

                {/* 3. Time Selector */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-black text-amber-300 mb-1">وقت البدء:</label>
                    <select
                      value={bookingForm.time}
                      onChange={(e) => setBookingForm(b => ({ ...b, time: e.target.value }))}
                      className="w-full bg-stone-900 border border-amber-500/40 text-white font-mono rounded-2xl p-3 text-xs font-bold focus:ring-2 focus:ring-amber-400 focus:outline-none"
                    >
                      {[
                        '09:00 ص', '10:00 ص', '11:00 ص', '12:00 م',
                        '01:00 م', '02:00 م', '03:00 م', '04:00 م',
                        '05:00 م', '06:00 م', '07:00 م', '08:00 م',
                        '09:00 م', '10:00 م'
                      ].map((t, idx) => (
                        <option key={idx} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>

                  {/* 4. Duration Selector (Integer Hours Only) */}
                  <div>
                    <label className="block text-xs font-black text-amber-300 mb-1">المدة (ساعات صحيحة):</label>
                    <select
                      value={bookingForm.duration}
                      onChange={(e) => setBookingForm(b => ({ ...b, duration: e.target.value }))}
                      className="w-full bg-stone-900 border border-amber-500/40 text-emerald-400 font-black rounded-2xl p-3 text-xs focus:ring-2 focus:ring-amber-400 focus:outline-none"
                    >
                      <option value="1">ساعة واحدة (1)</option>
                      <option value="2">ساعتان (2)</option>
                      <option value="3">3 ساعات</option>
                      <option value="4">4 ساعات</option>
                      <option value="5">5 ساعات</option>
                      <option value="6">6 ساعات</option>
                      <option value="8">8 ساعات (يوم كامل)</option>
                    </select>
                  </div>
                </div>

                {/* Live Room Conflict Alert */}
                {conflictCheck.hasConflict ? (
                  <div className="p-3.5 bg-rose-950/90 border-2 border-rose-500/80 rounded-2xl text-rose-200 text-xs space-y-1.5 font-bold shadow-lg">
                    <div className="flex items-center gap-2 font-black text-rose-300 text-sm">
                      <span className="text-base">⛔</span>
                      <span>القاعة غير متاحة في هذا التوقيت!</span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-stone-200">
                      القاعة محجوزة مسبقاً في الفترة (<span className="text-amber-300 font-mono font-black">{conflictCheck.conflictTime}</span>). يرجى اختيار توقيت آخر متاح أو قاعة بديلة.
                    </p>
                  </div>
                ) : (
                  <div className="p-3 bg-emerald-950/60 border border-emerald-500/40 rounded-2xl text-emerald-300 text-xs flex items-center gap-2 font-bold">
                    <span>🟢</span>
                    <span>القاعة متاحة بالكامل في التوقيت المحدد!</span>
                  </div>
                )}

                {/* Notes (Optional) */}
                <div>
                  <label className="block text-xs font-black text-stone-300 mb-1">ملاحظات / طبيعة النشاط (اختياري):</label>
                  <input
                    type="text"
                    value={bookingForm.notes}
                    onChange={(e) => setBookingForm(b => ({ ...b, notes: e.target.value }))}
                    placeholder="مثال: اجتماع عمل، ورشة تدريبية..."
                    className="w-full bg-stone-900 border border-amber-500/30 text-white rounded-2xl p-3 text-xs focus:ring-2 focus:ring-amber-400 focus:outline-none"
                  />
                </div>

                {/* Submit Booking Button */}
                <button
                  type="submit"
                  disabled={bookingSubmitting || conflictCheck.hasConflict || contractStatus.isExpired}
                  className={`w-full py-4 rounded-2xl text-sm font-black shadow-xl transition-all flex items-center justify-center gap-2 ${
                    conflictCheck.hasConflict || contractStatus.isExpired
                      ? 'bg-stone-800 text-stone-500 cursor-not-allowed border border-stone-700'
                      : 'gold-gradient-btn text-stone-950 active:scale-95'
                  }`}
                >
                  {bookingSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-stone-950 border-t-transparent rounded-full animate-spin"></div>
                      <span>جاري تأكيد الحجز وخصم الساعات بالسحابة...</span>
                    </>
                  ) : conflictCheck.hasConflict ? (
                    <>
                      <span>⛔ القاعة غير متاحة في هذا التوقيت</span>
                    </>
                  ) : (
                    <>
                      <span>⚡ تأكيد وحفظ حجز القاعة فورياً</span>
                    </>
                  )}
                </button>

              </form>
            </div>

          </div>
        )}

        {/* ==================================================== */}
        {/* 📅 TAB 3: جدول حجوزاتي (My Bookings) */}
        {/* ==================================================== */}
        {activeTab === 'mybookings' && (
          <div className="space-y-4">
            
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-base font-black text-white">جدول حجوزاتي 📅</h3>
                <p className="text-[10px] text-amber-300 font-bold mt-0.5">متابعة الحجوزات القادمة والمكتملة والملغاة</p>
              </div>
              <button
                onClick={() => setActiveTab('book')}
                className="gold-gradient-btn text-stone-950 text-xs font-black px-3.5 py-2 rounded-xl flex items-center gap-1 shadow active:scale-95 transition-all"
              >
                <span>➕ حجز جديد</span>
              </button>
            </div>

            {/* Filter Pills with Live Real-Time Counts */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {[
                { id: 'all', label: 'كافة المواعيد', count: myBookingsStats.total },
                { id: 'scheduled', label: 'المواعيد القادمة ⏳', count: myBookingsStats.scheduled },
                { id: 'attended', label: 'المكتملة ✅', count: myBookingsStats.attended },
                { id: 'cancelled', label: 'الملغاة ❌', count: myBookingsStats.cancelled }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setBookingFilter(f.id)}
                  className={`p-2.5 rounded-2xl text-xs font-bold transition-all text-center flex flex-col items-center justify-center gap-0.5 ${
                    bookingFilter === f.id
                      ? 'bg-amber-500/20 text-amber-300 border-2 border-amber-500/60 font-black shadow-md'
                      : 'bg-stone-900/90 text-stone-400 hover:text-white border border-amber-500/15'
                  }`}
                >
                  <span className="text-[11px]">{f.label}</span>
                  <span className={`text-xs font-mono font-black ${bookingFilter === f.id ? 'text-amber-400' : 'text-stone-500'}`}>
                    ({f.count})
                  </span>
                </button>
              ))}
            </div>

            {/* Bookings List */}
            {(() => {
              if (filteredMyBookings.length === 0) {
                return (
                  <div className="text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-3">
                    <span className="text-3xl">📅</span>
                    <p className="text-xs text-stone-400 font-bold">لا توجد حجوزات مسجلة في هذا القسم حالياً.</p>
                    <button
                      onClick={() => setActiveTab('book')}
                      className="gold-gradient-btn text-stone-950 text-xs font-black px-4 py-2 rounded-2xl shadow"
                    >
                      حجز قاعة الآن
                    </button>
                  </div>
                );
              }

              return (
                <div className="space-y-3">
                  {filteredMyBookings.map(b => {
                    const category = getBookingDisplayCategory(b);
                    const isUpcoming = category === 'scheduled';
                    const isCompleted = category === 'attended';
                    const isCancelled = category === 'cancelled';

                    const startDec = parseArabicTimeToDecimal(b.time || b.startTime);
                    const durNum = parseFloat(b.duration || b.durationHours || 1);
                    const endDec = startDec + durNum;
                    const timeRangeFormatted = b.timeRange || `من ${decimalToTimeStr(startDec)} إلى ${decimalToTimeStr(endDec)}`;

                    return (
                    <div 
                      key={b.id} 
                      className={`glass-card p-4 sm:p-5 rounded-3xl border space-y-3 shadow-xl transition-all ${
                        isUpcoming ? 'border-amber-500/40 bg-stone-950/90 hover:border-amber-400/70' :
                        isCompleted ? 'border-blue-500/30 bg-blue-950/20' :
                        'border-rose-500/30 bg-rose-950/20'
                      }`}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-base font-black text-white">{b.room}</h4>
                            <span className="text-[10px] bg-stone-900 border border-amber-500/30 text-amber-300 px-2 py-0.5 rounded-lg font-bold">
                              {durNum} {durNum === 1 ? 'ساعة' : durNum === 2 ? 'ساعتان' : 'ساعات'}
                            </span>
                          </div>
                          <p className="text-xs text-amber-300 font-mono font-bold mt-1 flex items-center gap-1">
                            <span>📅 {b.date}</span>
                            <span>•</span>
                            <span>⏰ {timeRangeFormatted}</span>
                          </p>
                        </div>
                        <span className={`text-[10px] font-black px-3 py-1 rounded-xl border shadow whitespace-nowrap ${
                          isUpcoming ? 'bg-emerald-950 border-emerald-500/50 text-emerald-300 animate-pulse-gold' :
                          isCompleted ? 'bg-blue-950 border-blue-500/50 text-blue-300' :
                          'bg-rose-950 border-rose-500/50 text-rose-300'
                        }`}>
                          {isUpcoming ? 'مؤكد قادم ⏳' : isCompleted ? 'جلسة مكتملة ✅' : 'ملغي ❌'}
                        </span>
                      </div>

                      {b.notes && (
                        <p className="text-[11px] text-stone-300 font-bold bg-stone-900/80 border border-amber-500/15 p-2 rounded-xl">
                          📝 {b.notes}
                        </p>
                      )}

                      {/* Footer Actions & Status Notice */}
                      <div className="pt-2.5 border-t border-amber-500/15 flex items-center justify-between text-[11px] flex-wrap gap-2">
                        <span className="text-emerald-300 font-black flex items-center gap-1 text-[10px]">
                          <span>✓</span>
                          <span>تم خصم ({durNum}س) فورياً من الرصيد</span>
                        </span>

                        {isUpcoming ? (
                          <button
                            onClick={() => handleCancelBooking(b.id)}
                            className="bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-[10px] font-black px-3 py-1 rounded-xl shadow active:scale-95 transition-all flex items-center gap-1"
                          >
                            <span>🗑️</span>
                            <span>إلغاء الحجز</span>
                          </button>
                        ) : isCompleted ? (
                          <span className="text-[10px] text-blue-300 font-bold bg-blue-950/60 px-2.5 py-0.5 rounded-lg border border-blue-500/20">
                            جلسة منتهية ✅
                          </span>
                        ) : (
                          <span className="text-[10px] text-rose-300 font-bold bg-rose-950/60 px-2.5 py-0.5 rounded-lg border border-rose-500/20">
                            القاعة محررة 🔓
                          </span>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              );
            })()}

          </div>
        )}

        {/* ==================================================== */}
        {/* 📋 TAB 4: سجل الاستهلاك والخصم (History) */}
        {/* ==================================================== */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            
            <div className="flex justify-between items-center">
              <h3 className="text-base font-black text-white">سجل الحضور وخصم الساعات 📋</h3>
              <span className="text-xs text-amber-300 font-mono font-bold">{myAttendance.length} جلسة</span>
            </div>

            {myAttendance.length === 0 ? (
              <div className="text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-2">
                <span className="text-3xl">📋</span>
                <p className="text-xs text-stone-400 font-bold">لم يتم تسجيل جلسات حضور أو خصم ساعات حتى الآن.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {myAttendance.map(att => (
                  <div key={att.id} className="glass-card p-3.5 rounded-2xl border border-amber-500/20 flex justify-between items-center text-xs shadow">
                    <div>
                      <h4 className="font-black text-white">{att.serviceType || 'جلسة عمل'}</h4>
                      <p className="text-[11px] text-stone-400 font-mono mt-0.5 font-bold">
                        📅 {att.date} ({att.time}) {att.notes ? `• ${att.notes}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="font-black text-rose-400 text-sm">-{att.hoursConsumed}س</span>
                      <p className="text-[10px] text-amber-300/80 font-bold">الرصيد بعدها: {att.newBalance}س</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

          </div>
        )}

        {/* ==================================================== */}
        {/* 🔔 TAB 5: الإشعارات والتنبيهات (Notifications) */}
        {/* ==================================================== */}
        {activeTab === 'notifications' && (
          <div className="space-y-4">
            
            <div className="flex justify-between items-center">
              <h3 className="text-base font-black text-white">مركز الإشعارات والتنبيهات 🔔</h3>
              <span className="text-xs text-amber-300 font-mono font-bold">{notifications.length} إشعار</span>
            </div>

            {notifications.length === 0 ? (
              <div className="text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-2">
                <span className="text-3xl">🔔</span>
                <p className="text-xs text-stone-400 font-bold">لا توجد إشعارات جديدة حالياً.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {notifications.map((n, idx) => (
                  <div key={idx} className={`glass-card p-4 rounded-2xl border space-y-1.5 shadow-lg ${n.type === 'alert' || n.type === 'warning' ? 'border-rose-500/40 bg-rose-950/20' : 'border-amber-500/30'}`}>
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">
                          {n.type === 'alert' || n.type === 'warning' ? '⚠️' : n.type === 'deduction' ? '⚡' : n.type === 'booking' ? '📅' : n.type === 'package' ? '💳' : '🔔'}
                        </span>
                        <h4 className="text-xs font-black text-amber-300">{n.title || 'إشعار من الإدارة'}</h4>
                      </div>
                      <span className="text-[9px] bg-stone-900 border border-amber-500/20 text-stone-400 px-2 py-0.5 rounded-lg font-mono">
                        {n.time || ''}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-white leading-relaxed whitespace-pre-line pr-7">
                      {n.text || n.message}
                    </p>
                  </div>
                ))}
              </div>
            )}

          </div>
        )}

      </main>

      {/* Booking Success Modal */}
      {bookingSuccessModal && (
        <div className="fixed inset-0 z-50 bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="glass-card bg-stone-950/95 max-w-sm w-full p-6 rounded-3xl border-2 border-emerald-500/80 text-center space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/20 text-emerald-400 border-2 border-emerald-500/50 flex items-center justify-center text-3xl">
              ✓
            </div>
            <div>
              <h3 className="text-lg font-black text-white">تم تأكيد الحجز بنجاح 🎉</h3>
              <p className="text-xs text-emerald-300 mt-1 font-bold">تم تسجيل وحفظ الحجز بالسيستم الرئيسي في نفس اللحظة!</p>
            </div>

            <div className="p-3.5 bg-stone-900 rounded-2xl border border-amber-500/20 text-xs text-right space-y-1 font-mono">
              <p><span className="text-amber-300 font-sans">القاعة:</span> <b className="text-white">{bookingSuccessModal.room}</b></p>
              <p><span className="text-amber-300 font-sans">التاريخ:</span> <b className="text-white">{bookingSuccessModal.date}</b></p>
              <p><span className="text-amber-300 font-sans">التوقيت:</span> <b className="text-white">{bookingSuccessModal.time}</b> ({bookingSuccessModal.duration} ساعات)</p>
            </div>

            <div className="pt-2">
              <button
                onClick={() => {
                  setBookingSuccessModal(null);
                  setActiveTab('mybookings');
                }}
                className="w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-2xl text-xs shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                <span>عرض جدول حجوزاتي 📅</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================== */}
      {/* 📱 LUXURY BOTTOM NAVIGATION BAR */}
      {/* ==================================================== */}
      <nav className="fixed bottom-0 inset-x-0 z-40 max-w-md mx-auto mobile-bottom-nav px-3 py-2 flex items-center justify-around shadow-2xl">
        
        <button
          onClick={() => setActiveTab('home')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${
            activeTab === 'home' ? 'text-amber-300 scale-105' : 'text-stone-400 hover:text-white'
          }`}
        >
          <span className="text-lg">🏠</span>
          <span className="text-[10px] font-black">الرئيسية</span>
        </button>

        <button
          onClick={() => setActiveTab('book')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${
            activeTab === 'book' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'
          }`}
        >
          <span className="text-lg">➕</span>
          <span className="text-[10px] font-bold">حجز قاعة</span>
        </button>

        <button
          onClick={() => setActiveTab('mybookings')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${
            activeTab === 'mybookings' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'
          }`}
        >
          <span className="text-lg">📅</span>
          <span className="text-[10px] font-bold">حجوزاتي</span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${
            activeTab === 'history' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'
          }`}
        >
          <span className="text-lg">📋</span>
          <span className="text-[10px] font-bold">السجل</span>
        </button>

        <button
          onClick={() => setActiveTab('notifications')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all relative ${
            activeTab === 'notifications' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'
          }`}
        >
          <span className="text-lg">🔔</span>
          <span className="text-[10px] font-bold">الإشعارات</span>
        </button>

      </nav>

    </div>
  );
}

// Mount React App safely
try {
  const rootEl = document.getElementById('root');
  if (rootEl) {
    if (ReactDOM.createRoot) {
      ReactDOM.createRoot(rootEl).render(<MobileApp />);
    } else if (ReactDOM.render) {
      ReactDOM.render(<MobileApp />, rootEl);
    }
  }
} catch (e) {
  console.error('Mobile React mount error:', e);
}
