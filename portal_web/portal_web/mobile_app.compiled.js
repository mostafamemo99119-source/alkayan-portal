const {
  useState,
  useEffect,
  useRef,
  useMemo
} = React;
const INITIAL_ROOMS = ['Master VIP Room', 'MaxRoom'];
const FIREBASE_BASE_URL = 'https://alkayan-group-default-rtdb.europe-west1.firebasedatabase.app';

// Convert Arabic/Persian digits to standard digits
function toStandardDigits(str) {
  if (!str) return '';
  const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return str.toString().replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[۰-۹]/g, d => persianDigits.indexOf(d));
}

// Consistent Client Storage Key Helper for 100% notification retention
function getClientStorageKey(clientObj) {
  if (!clientObj) {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      if (sess) {
        const p = JSON.parse(sess);
        if (p && p.client) return p.client.id || p.client.username || '';
      }
    } catch (e) {}
    return '';
  }
  return clientObj.id || clientObj.username || clientObj.phone || '';
}

// Helper to extract timestamp (ms) from client object creation date
function getClientCreationTime(clientObj) {
  if (!clientObj) return 0;

  // 1. If explicit timestamp in created_at or createdAt with time
  const rawCreated = clientObj.created_at || clientObj.createdAt;
  if (rawCreated) {
    if (typeof rawCreated === 'number' && rawCreated > 0) return rawCreated;
    const str = String(rawCreated).trim();
    if (str.length > 10) {
      const t = new Date(str).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
  }

  // 2. High-precision epoch ms embedded in client ID (e.g. c-1788751385312)
  const idStr = String(clientObj.id || '');
  const m = idStr.match(/\d{12,}/);
  if (m) {
    const t = parseInt(m[0], 10);
    if (!isNaN(t) && t > 0) return t;
  }

  // 3. Fallback date string (e.g. '2026-09-07')
  if (rawCreated) {
    const t = new Date(rawCreated).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (clientObj.registrationDate) {
    const t = new Date(clientObj.registrationDate).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return 0;
}

// Helper to extract timestamp (ms) from notification or transaction
function getRecordTimestamp(item) {
  if (!item) return 0;
  if (item.timestamp) {
    const t = typeof item.timestamp === 'number' ? item.timestamp : new Date(item.timestamp).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (item.createdAt) {
    const t = new Date(item.createdAt).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (item.created_at) {
    const t = new Date(item.created_at).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  const idStr = String(item.id || '');
  const m = idStr.match(/\d{12,}/);
  if (m) {
    const t = parseInt(m[0], 10);
    if (!isNaN(t) && t > 0) return t;
  }
  if (item.date) {
    const cleanDate = toStandardDigits(item.date).trim();
    const t = new Date(cleanDate).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return 0;
}

// Helper to detect financial notifications
function isFinancialNotification(notif) {
  if (!notif) return false;
  const type = (notif.type || '').toString().toLowerCase();
  const category = (notif.category || '').toString().toLowerCase();
  const finTypes = ['financial', 'recharge', 'balance', 'payment', 'invoice', 'buffet', 'buffet_charge', 'money', 'debt', 'refund', 'subscription_renew'];
  if (finTypes.includes(type) || finTypes.includes(category)) return true;
  const text = ((notif.title || '') + ' ' + (notif.message || '') + ' ' + (notif.text || '')).toLowerCase();
  const financialKeywords = ['رصيد', 'سداد', 'دفع', 'فاتورة', 'شحن', 'استرداد', 'بوفيه', 'جنيه', 'ريال', 'خصم مالي', 'إيداع', 'تحويل', 'إنستاباي', 'instapay', 'مديونية', 'تجديد باقة', 'تجديد الاشتراك', 'مبلغ'];
  return financialKeywords.some(kw => text.includes(kw));
}

// 🔒 STRICT PER-ACCOUNT NOTIFICATION ISOLATION HELPER
// Ensures that notifications sent to Client 1 will NEVER appear in Client 2's account
function isNotificationForClient(notif, clientObj) {
  if (!notif || !clientObj) return false;

  // Never show internal admin alerts to clients
  const nCid = notif.targetClientId || notif.clientId;
  if (nCid === 'admin_only' || nCid === 'internal') return false;
  const tStr = ((notif.title || '') + ' ' + (notif.message || notif.text || '')).toLowerCase();
  if (tStr.includes('تم تجهيز رسالة واتساب')) return false;

  // 🛡️ CHRONOLOGICAL FILTER: Ignore any notification (broadcast or direct) created BEFORE this client account was created
  const clientCreatedTime = getClientCreationTime(clientObj);
  const notifTime = getRecordTimestamp(notif);
  if (clientCreatedTime > 0 && notifTime > 0 && notifTime < clientCreatedTime) {
    return false;
  }
  const curClientId = (clientObj.id || '').toString().trim();
  const isFinancial = isFinancialNotification(notif);

  // 💳 STRICT FINANCIAL RULE: Must strictly match the current client's unique client_id
  // Financial notifications must NEVER be displayed based on username, phone, or broadcast 'all'
  if (isFinancial) {
    if (!curClientId) return false;
    return notif.clientId === curClientId || notif.targetClientId === curClientId;
  }

  // 1. Direct Match by Unique Client ID (primary & authoritative)
  if (curClientId && (notif.clientId === curClientId || notif.targetClientId === curClientId)) {
    return true;
  }

  // 2. Match by Exact Username ONLY if notification does not target a different clientId
  const cUser = (clientObj.username || '').toString().trim().toLowerCase();
  const nUser = (notif.clientUsername || notif.username || '').toString().trim().toLowerCase();
  if (cUser && nUser && cUser === nUser) {
    if (nCid && curClientId && nCid !== curClientId && nCid !== 'all') {
      return false;
    }
    return true;
  }

  // 3. General Broadcast sent explicitly to 'all' (only if sent on/after registration)
  if (nCid === 'all') {
    if (clientCreatedTime > 0 && notifTime > 0 && notifTime < clientCreatedTime) {
      return false;
    }
    return true;
  }

  // ⛔ NEVER match by phone number alone! (prevents debt/history leaking to re-registered phone numbers)
  return false;
}

// 🛡️ STRICT DEDUPLICATION HELPER FOR BOOKINGS (With Safe ID Resolution)
function deduplicateBookings(bookingsArray) {
  if (!Array.isArray(bookingsArray)) return [];
  const seenIds = new Set();
  const uniqueBookings = [];
  bookingsArray.forEach((b, idx) => {
    if (!b) return;
    const id = b.id || b.key || `${b.date || ''}_${b.start_time || b.time || b.startTime || ''}_${b.room_name || b.room || ''}` || (idx !== undefined ? `booking_${idx}` : '');
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    if (!b.id) {
      b.id = id;
    }
    uniqueBookings.push(b);
  });
  return uniqueBookings;
}

// 🛡️ DOM Container Sanitizer: Targets dedicated cards container (#bookingsList / #cardsContainer)
function clearBookingsContainer() {
  const cardsContainer = document.getElementById('bookingsList') || document.getElementById('cardsContainer');
  if (cardsContainer) {
    cardsContainer.innerHTML = '';
  }
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
  const minutes = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  return hours + minutes / 60;
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
  const currentDecimal = now.getHours() + now.getMinutes() / 60;
  const startDecimal = parseArabicTimeToDecimal(b.time || b.startTime || '00:00');
  const duration = parseFloat(b.duration || b.durationHours || 1);
  return currentDecimal >= startDecimal + duration;
}
function getBookingDisplayCategory(b) {
  if (!b) return 'scheduled';
  if (b.status === 'cancelled' || b.status === 'canceled') return 'cancelled';
  try {
    const rawG = localStorage.getItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL');
    if (rawG && b.id && rawG.includes(b.id)) return 'cancelled';
  } catch (_) {}
  if (b.status === 'attended' || b.status === 'completed') return 'attended';
  if (isPastBooking(b)) return 'attended'; // Past scheduled bookings are auto-completed
  return 'scheduled';
}
function checkRoomConflict(candRoom, candDate, candTimeStr, candDuration, allBookings, ignoreBookingId = null) {
  if (!candRoom || !candDate || !candTimeStr) return {
    hasConflict: false
  };
  const candStart = parseArabicTimeToDecimal(candTimeStr);
  const candEnd = candStart + (parseFloat(candDuration) || 1);
  const bookingsList = Array.isArray(allBookings) ? allBookings : Object.values(allBookings || {});

  // 🛡️ Read global cancellation blacklist
  let cancelledGlobalSet = new Set();
  try {
    const rawG = localStorage.getItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL');
    if (rawG) {
      const arr = JSON.parse(rawG);
      if (Array.isArray(arr)) cancelledGlobalSet = new Set(arr);
    }
  } catch (_) {}
  for (const b of bookingsList) {
    if (!b) continue;
    if (ignoreBookingId && b.id === ignoreBookingId) continue;
    if (b.status === 'cancelled' || b.id && cancelledGlobalSet.has(b.id)) continue; // Cancelled bookings do not occupy rooms
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
  return {
    hasConflict: false
  };
}
function calcFullTimeWorkingHours(startDateStr, expiryDateStr, refDate = new Date()) {
  const DAILY_HOURS = 12; // 12 hours daily (10:00 AM to 10:00 PM - 6 days/week, Friday off)
  if (!expiryDateStr) {
    return {
      totalWorkingDays: 0,
      totalWorkingHours: 0,
      remainingWorkingDays: 0,
      remainingWorkingHours: 0,
      consumedWorkingDays: 0,
      consumedWorkingHours: 0,
      dailyHours: DAILY_HOURS
    };
  }
  const parseD = s => {
    if (!s) return null;
    const clean = s.toString().split('T')[0].trim();
    const parts = clean.split('-');
    if (parts.length < 3) return null;
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  };
  const today = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const start = parseD(startDateStr) || today;
  const end = parseD(expiryDateStr);
  if (!end || end < start) {
    return {
      totalWorkingDays: 0,
      totalWorkingHours: 0,
      remainingWorkingDays: 0,
      remainingWorkingHours: 0,
      consumedWorkingDays: 0,
      consumedWorkingHours: 0,
      dailyHours: DAILY_HOURS
    };
  }
  let totalWorkingDays = 0;
  let cur = new Date(start.getTime());
  while (cur < end) {
    if (cur.getDay() !== 5) {
      // 5 is Friday
      totalWorkingDays++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  let remainingWorkingDays = 0;
  if (today < end) {
    let curRem = new Date(today.getTime());
    while (curRem < end) {
      if (curRem.getDay() !== 5) {
        // 5 is Friday
        remainingWorkingDays++;
      }
      curRem.setDate(curRem.getDate() + 1);
    }
  }
  const totalWorkingHours = totalWorkingDays * DAILY_HOURS;
  const remainingWorkingHours = remainingWorkingDays * DAILY_HOURS;
  const consumedWorkingHours = Math.max(0, totalWorkingHours - remainingWorkingHours);
  const consumedWorkingDays = Math.max(0, totalWorkingDays - remainingWorkingDays);
  return {
    totalWorkingDays,
    totalWorkingHours,
    remainingWorkingDays,
    remainingWorkingHours,
    consumedWorkingDays,
    consumedWorkingHours,
    dailyHours: DAILY_HOURS
  };
}
function getClientContractStatus(client) {
  if (!client) return {
    isExpired: false,
    daysLeft: null,
    label: 'غير مسجل',
    badgeText: 'غير محدد'
  };
  const isFT = Boolean(client.subscriptionType === 'fulltime' || client.subscriptionType === 'shift' || client.isFullTime === true || client.isFullTime === 'true' || client.packageDuration && client.packageDuration.toString().startsWith('fulltime') || client.package && client.package.toString().toLowerCase().includes('full time') || client.package && client.package.toString().includes('دوام كامل') || client.package && client.package.toString().includes('الشيفت'));
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
  const ftMetrics = isFT ? calcFullTimeWorkingHours(client.startDate, client.expiryDate) : null;

  // Full-time clients have access throughout contract period! Only hourly clients expire on balance <= 0
  if (!isFT && (client.currentBalance || 0) <= 0) {
    isExpired = true;
    reason = reason ? `${reason} ونفاد رصيد الساعات` : 'نفاد رصيد الساعات المخصصة';
  }
  const badgeText = isExpired ? 'منتهي الصلاحية ⛔' : daysLeft !== null ? daysLeft <= 7 ? `قارب على الانتهاء (${daysLeft} يوم) ⚠️` : 'ساري ونشط 🟢' : 'ساري 🟢';
  return {
    isFullTime: isFT,
    isExpired,
    daysLeft,
    workingDaysLeft: ftMetrics ? ftMetrics.remainingWorkingDays : null,
    workingHoursLeft: ftMetrics ? ftMetrics.remainingWorkingHours : null,
    totalWorkingDays: ftMetrics ? ftMetrics.totalWorkingDays : null,
    totalWorkingHours: ftMetrics ? ftMetrics.totalWorkingHours : null,
    consumedWorkingDays: ftMetrics ? ftMetrics.consumedWorkingDays : null,
    consumedWorkingHours: ftMetrics ? ftMetrics.consumedWorkingHours : null,
    dailyHours: 12,
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

// ⚡ Official InstaPay Payment Configuration & Logo Component
const INSTAPAY_PAYMENT_URL = 'https://ipn.eg/S/x.lance/instapay/1ZQ65n';
function InstaPayLogo({
  className = "w-7 h-7"
}) {
  return /*#__PURE__*/React.createElement("svg", {
    className: className,
    viewBox: "0 0 100 100",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg"
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "ipn_main_grad",
    x1: "0",
    y1: "0",
    x2: "100",
    y2: "100",
    gradientUnits: "userSpaceOnUse"
  }, /*#__PURE__*/React.createElement("stop", {
    stopColor: "#9C1C62"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "0.6",
    stopColor: "#78134B"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "#4A0A2E"
  })), /*#__PURE__*/React.createElement("linearGradient", {
    id: "ipn_bolt_grad",
    x1: "30",
    y1: "15",
    x2: "70",
    y2: "85",
    gradientUnits: "userSpaceOnUse"
  }, /*#__PURE__*/React.createElement("stop", {
    stopColor: "#FFB300"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "#FF6D00"
  }))), /*#__PURE__*/React.createElement("rect", {
    width: "100",
    height: "100",
    rx: "26",
    fill: "url(#ipn_main_grad)"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "2.5",
    y: "2.5",
    width: "95",
    height: "95",
    rx: "23.5",
    stroke: "#FF4D94",
    strokeWidth: "2",
    strokeOpacity: "0.4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M54 16L24 53H47L41 84L76 47H52L60 16H54Z",
    fill: "url(#ipn_bolt_grad)"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M50 23L31 50H46L43 72L67 45H50L56 23H50Z",
    fill: "#FFFFFF"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "75",
    cy: "24",
    r: "6",
    fill: "#FFB300"
  }));
}

// ====================================================
// 📱 Mobile Application Component
// ====================================================
function MobileApp() {
  const [client, setClient] = useState(() => {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      if (sess) {
        const parsed = JSON.parse(sess);
        if (parsed && parsed.client) {
          return parsed.client;
        }
      }
    } catch (e) {}
    return null;
  });
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
      alert('📱 لتثبيت التطبيق: افتح خيارات المتصفح (⋮) في أعلى الصفحة ثم اختر "إضافة إلى الشاشة الرئيسية" (Add to Home screen) - التطبيق يعمل فى اي وقت 24 ساعه خلال جميع ايام الاسبوع.');
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
  const [showInstaPayModal, setShowInstaPayModal] = useState(false);
  const [showStrictAlertModal, setShowStrictAlertModal] = useState(false);

  // ⚡ Handle InstaPay Automatic Redirect & Mandatory Screenshot Notice
  const handleOpenInstaPay = () => {
    try {
      const win = window.open(INSTAPAY_PAYMENT_URL, '_blank');
      if (!win || win.closed || typeof win.closed === 'undefined') {
        window.location.assign(INSTAPAY_PAYMENT_URL);
      }
    } catch (e) {
      window.location.href = INSTAPAY_PAYMENT_URL;
    }
    setShowInstaPayModal(true);
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
  const [myBookings, setMyBookings] = useState(() => {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      if (sess) {
        const parsed = JSON.parse(sess);
        return parsed.myBookings || [];
      }
    } catch (e) {}
    return [];
  });
  const [myAttendance, setMyAttendance] = useState(() => {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      if (sess) {
        const parsed = JSON.parse(sess);
        return parsed.myAttendance || [];
      }
    } catch (e) {}
    return [];
  });
  const [myFinancialTransactions, setMyFinancialTransactions] = useState(() => {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      if (sess) {
        const parsed = JSON.parse(sess);
        return parsed.financialTransactions || [];
      }
    } catch (e) {}
    return [];
  });
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  const [notifications, setNotifications] = useState(() => {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      let clientObj = null;
      if (sess) {
        try {
          clientObj = JSON.parse(sess).client;
        } catch (e) {}
      }
      if (!clientObj || !clientObj.id) return [];
      const uKey = getClientStorageKey(clientObj);
      if (!uKey) return [];
      const rawCached = localStorage.getItem('ALKAYAN_NOTIFS_STORE_' + uKey);
      let locallyReadIds = new Set();
      try {
        locallyReadIds = new Set(JSON.parse(localStorage.getItem('ALKAYAN_READ_NOTIFS_' + uKey) || '[]'));
      } catch (e) {}
      let baseList = [];
      if (rawCached) {
        try {
          const parsed = JSON.parse(rawCached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            baseList = parsed.filter(n => isNotificationForClient(n, clientObj));
          }
        } catch (e) {}
      }
      if (baseList.length === 0 && sess) {
        try {
          const parsed = JSON.parse(sess);
          if (Array.isArray(parsed.notifications)) {
            baseList = parsed.notifications.filter(n => isNotificationForClient(n, clientObj));
          }
        } catch (e) {}
      }
      return baseList.map(n => {
        if (n && n.id && (locallyReadIds.has(n.id) || n.read)) {
          return {
            ...n,
            read: true
          };
        }
        return n;
      });
    } catch (e) {}
    return [];
  });
  const notificationsRef = useRef([]);
  const initialNotifSyncDoneRef = useRef(false);
  const knownNotifIdsRef = useRef(new Set());

  // Robust Timestamp Extractor for Chronological Sorting (Newest First)
  const getNotifTimestamp = n => {
    if (!n) return 0;
    if (n.createdAt) {
      const t = new Date(n.createdAt).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
    if (n.id && typeof n.id === 'string') {
      const m = n.id.match(/\d{10,}/);
      if (m) {
        const t = parseInt(m[0], 10);
        if (!isNaN(t) && t > 0) return t;
      }
    }
    if (n.date) {
      const t = new Date(n.date).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
    return 0;
  };
  const sortedNotifications = useMemo(() => {
    let list = [...(notifications || [])];

    // Filter strictly with isNotificationForClient
    if (client) {
      list = list.filter(n => isNotificationForClient(n, client));
    }

    // Deduplicate notifications by unique ID
    const seenNotifIds = new Set();
    const uniqueNotifs = [];
    list.forEach(n => {
      if (!n) return;
      const nId = String(n.id || '').trim();
      if (!nId || seenNotifIds.has(nId)) return;
      seenNotifIds.add(nId);
      uniqueNotifs.push(n);
    });
    list = uniqueNotifs;

    // 🚨 Strict 100% System Notification Injection for Last 7 Days (FT) or Last 5 Hours (Hourly)
    if (client && client.name) {
      const contract = getClientContractStatus(client);
      const isFT = contract.isFullTime;
      const daysLeft = contract.daysLeft;
      const curBal = parseFloat(client.currentBalance || 0);

      // 🛡️ When client is currently renewed and active, purge any stale past expiry / depletion warnings
      if (!contract.isExpired && (isFT || curBal > 0)) {
        list = list.filter(n => {
          if (!n) return false;
          const t = ((n.title || '') + ' ' + (n.message || '') + ' ' + (n.text || '')).toLowerCase();
          const isExpiredWarning = n.type === 'expiry' || n.type === 'contract_expired' || t.includes('انتهت باقة') || t.includes('انتهاء العقد') || t.includes('نفد رصيد') || t.includes('نفاد رصيد') || t.includes('رصيد منته') || t.includes('انتهى اشتراك');
          return !isExpiredWarning;
        });
      }
      if (isFT && daysLeft !== null && daysLeft <= 7) {
        list.unshift({
          id: 'sys-alert-ft-7days',
          title: daysLeft <= 0 ? '⛔ انتهت فترة اشتراك الدوام الكامل!' : `⚠️ تنبيه تجديد الاشتراك: متبقي ${daysLeft} أيام فقط!`,
          message: `ينتهي اشتراكك بنظام الدوام الكامل بتاريخ (${client.expiryDate}). يرجى التواصل مع الإدارة فوراً لتأكيد التجديد وضمان استمرار تخصيص مكتبك الخاص دون انقطاع.`,
          date: new Date().toISOString().split('T')[0],
          time: 'تنبيه عاجل 🚨',
          type: 'alert',
          read: false
        });
      } else if (!isFT && curBal <= 5) {
        list.unshift({
          id: 'sys-alert-hr-5hours',
          title: curBal <= 0 ? '⛔ نفد رصيد الساعات المخصص لك بالكامل!' : `⏱️ تنبيه رصيد الباقة: متبقي لديك (${curBal} ساعة) فقط!`,
          message: `لقد وصل رصيدك لآخر 5 ساعات في باقتك. يرجى تجديد أو شحن الباقة الآن عبر الدفع بإنستاباي أو التواصل مع الإدارة للاستمرار في حجز القاعات ومساحات العمل.`,
          date: new Date().toISOString().split('T')[0],
          time: 'تنبيه عاجل ⚠️',
          type: 'alert',
          read: false
        });
      }
    }
    return list.sort((a, b) => getNotifTimestamp(b) - getNotifTimestamp(a));
  }, [notifications, client]);
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
  const [unreadNotifCount, setUnreadNotifCount] = useState(() => {
    try {
      const sess = localStorage.getItem('al_kayan_client_session');
      let clientObj = null;
      if (sess) {
        try {
          clientObj = JSON.parse(sess).client;
        } catch (e) {}
      }
      const uKey = getClientStorageKey(clientObj);
      const rawCached = localStorage.getItem('ALKAYAN_NOTIFS_STORE_' + uKey) || localStorage.getItem('ALKAYAN_NOTIFS_STORE_all') || localStorage.getItem('ALKAYAN_NOTIFS_STORE_user') || localStorage.getItem('ALKAYAN_NOTIFS_STORE_client_default');
      let locallyReadIds = new Set();
      try {
        locallyReadIds = new Set(JSON.parse(localStorage.getItem('ALKAYAN_READ_NOTIFS_' + uKey) || '[]'));
      } catch (e) {}
      if (rawCached) {
        const list = JSON.parse(rawCached);
        if (Array.isArray(list)) {
          return list.filter(n => n && n.id && !locallyReadIds.has(n.id) && !n.read).length;
        }
      }
    } catch (e) {}
    return 0;
  });
  const [notifPermission, setNotifPermission] = useState(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
    return 'default';
  });

  // Sound Synthesizer + Real Audio Element + Mobile Hardware Vibration
  const playNotificationSound = (type = 'bell') => {
    // 1. Play real audio chime for 100% loudness on mobile devices
    try {
      const audio = new Audio('./notification.wav');
      audio.volume = 1.0;
      audio.play().catch(() => {});
    } catch (e) {}

    // 2. Hardware vibration (Mobile phones)
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([500, 200, 500, 200, 500]);
      }
    } catch (e) {}

    // 3. Web Audio oscillator synthesis
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      const playTone = (freq, delay, dur, vol = 0.3) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        gain.gain.setValueAtTime(0, ctx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + dur);
      };
      if (type === 'warning') {
        playTone(659.25, 0.0, 0.2, 0.35); // E5
        playTone(523.25, 0.15, 0.35, 0.35); // C5
      } else if (type === 'success') {
        playTone(523.25, 0.0, 0.18, 0.3); // C5
        playTone(659.25, 0.08, 0.18, 0.3); // E5
        playTone(783.99, 0.16, 0.18, 0.3); // G5
        playTone(1046.50, 0.26, 0.35, 0.35); // C6
      } else {
        // Luxury Bell Chime (C5 -> E5 -> G5)
        playTone(523.25, 0.0, 0.2, 0.3);
        playTone(659.25, 0.1, 0.2, 0.3);
        playTone(783.99, 0.2, 0.4, 0.35);
      }
    } catch (e) {}
  };

  // Trigger Native Mobile System Notification (Appears on phone lock screen / status bar even outside the app)
  const showDeviceNativeNotification = notif => {
    if (!notif) return;
    try {
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SHOW_NATIVE_NOTIFICATION',
            notification: notif
          });
        } else {
          new Notification(notif.title || '🔔 إشعار من مجموعة الكيان', {
            body: notif.message || notif.text || '',
            icon: './app_icon.png',
            badge: './app_icon.png',
            vibrate: [500, 200, 500]
          });
        }
      }
    } catch (e) {}
  };

  // Handle Incoming Notification Instantly (Zero Delay: Loud Sound + Vibration + Native Notification + Modal + Toast)
  const handleIncomingNotificationInstantly = notif => {
    if (!notif || !notif.id) return;
    if (!client) return;

    // Strict check: Is this notification intended for this client?
    if (!isNotificationForClient(notif, client)) return;

    // Check if already displayed
    const seenKey = 'KAYAN_SEEN_POPUP_' + notif.id;
    if (localStorage.getItem(seenKey)) return;
    localStorage.setItem(seenKey, 'true');

    // 1. Play Loud Sound
    playNotificationSound(notif.type === 'alert' || notif.type === 'warning' ? 'warning' : 'bell');

    // 2. Hardware Vibration
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([600, 200, 600, 200, 600]);
      }
    } catch (e) {}

    // 3. Show Native System Notification (works when tab is in background / screen locked)
    showDeviceNativeNotification(notif);

    // 4. In-App Modal & Toast
    setActiveNotifModal(notif);
    triggerToast(`🔔 ${notif.title || 'إشعار من الإدارة'}`, notif.message || notif.text || 'وصلك إشعار وتنبيه جديد في حسابك', 'warning');

    // 5. Update local state & persistent cache
    setNotifications(prev => {
      const exists = prev.some(item => item && item.id === notif.id);
      const updated = exists ? prev : [notif, ...prev];
      try {
        const uKey = getClientStorageKey(client);
        localStorage.setItem('ALKAYAN_NOTIFS_STORE_' + uKey, JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
    setUnreadNotifCount(prev => prev + 1);
  };

  // Request Native System Notification Permission
  const requestNotificationPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      triggerToast('تنبيه', 'متصفحك لا يدعم الإشعارات المباشرة', 'warning');
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
      if (perm === 'granted') {
        playNotificationSound('success');
        triggerToast('✓ تم تفعيل الإشعارات', 'ستصلك التنبيهات الصوتية فورياً حتى عند إغلاق التطبيق أو قفل الهاتف.', 'success');
        showDeviceNativeNotification({
          id: 'test-perm-' + Date.now(),
          title: '🔔 مجموعة الكيان | تم تفعيل الإشعارات بنجاح',
          message: 'تهانينا! الإشعارات والتنبيهات الصوتية نشطة الآن على هاتفك لتصلك كافة المستجدات.'
        });
      } else {
        triggerToast('تنبيه', 'يرجى السماح بالإشعارات من إعدادات المتصفح لتصلك التنبيهات.', 'warning');
      }
    } catch (err) {
      console.warn('Notification permission error:', err);
    }
  };

  // Mark all notifications as read permanently (UI + LocalStorage + Firebase)
  const handleMarkAllNotifsRead = async () => {
    if (!notifications || notifications.length === 0) return;
    const uKey = getClientStorageKey(client);
    const readStorageKey = 'ALKAYAN_READ_NOTIFS_' + uKey;
    const readIds = notifications.map(n => n.id).filter(Boolean);

    // 1. Immediately update UI: all notifications stay 100% in list, "جديد" disappears!
    const updatedList = notifications.map(n => ({
      ...n,
      read: true
    }));
    setNotifications(updatedList);
    notificationsRef.current = updatedList;
    setUnreadNotifCount(0);

    // 2. Persist 100% of the notifications in ALKAYAN_NOTIFS_STORE_ with read: true
    try {
      localStorage.setItem('ALKAYAN_NOTIFS_STORE_' + uKey, JSON.stringify(updatedList));
      const existing = JSON.parse(localStorage.getItem(readStorageKey) || '[]');
      const merged = Array.from(new Set([...existing, ...readIds]));
      localStorage.setItem(readStorageKey, JSON.stringify(merged));
    } catch (e) {}

    // 3. Batch Update Firebase Realtime Database
    try {
      const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications.json`, {
        cache: 'no-store'
      });
      if (fbRes.ok) {
        const rawNotifs = await fbRes.json();
        let updatedArr = null;
        if (Array.isArray(rawNotifs)) {
          updatedArr = rawNotifs.map(item => {
            if (item && readIds.includes(item.id)) {
              return {
                ...item,
                read: true
              };
            }
            return item;
          });
        } else if (rawNotifs && typeof rawNotifs === 'object') {
          updatedArr = {
            ...rawNotifs
          };
          Object.keys(updatedArr).forEach(k => {
            if (updatedArr[k] && readIds.includes(updatedArr[k].id)) {
              updatedArr[k] = {
                ...updatedArr[k],
                read: true
              };
            }
          });
        }
        if (updatedArr) {
          await fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications.json`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatedArr)
          });
        }
      }
    } catch (err) {
      console.warn('Firebase mark all read error:', err);
    }
    triggerToast('✓ تمت القراءة', 'تم تحديد جميع الإشعارات كمقروءة والاحتفاظ بها كاملة 100%.', 'success');
  };
  const handleMarkSingleNotifRead = notifId => {
    if (!notifId) return;
    const uKey = getClientStorageKey(client);
    const readStorageKey = 'ALKAYAN_READ_NOTIFS_' + uKey;
    setNotifications(prev => {
      const updated = prev.map(n => n && n.id === notifId ? {
        ...n,
        read: true
      } : n);
      try {
        localStorage.setItem('ALKAYAN_NOTIFS_STORE_' + uKey, JSON.stringify(updated));
        const existing = JSON.parse(localStorage.getItem(readStorageKey) || '[]');
        const merged = Array.from(new Set([...existing, notifId]));
        localStorage.setItem(readStorageKey, JSON.stringify(merged));
      } catch (e) {}
      notificationsRef.current = updated;
      setUnreadNotifCount(updated.filter(n => !n.read).length);
      return updated;
    });
  };

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
  const [cancelModalBooking, setCancelModalBooking] = useState(null);
  const [bookingFilter, setBookingFilter] = useState('all'); // all | upcoming | completed | cancelled
  const [activeNotifModal, setActiveNotifModal] = useState(null);

  // Toast State
  const [toast, setToast] = useState(null);
  const triggerToast = (title, message, type = 'info') => {
    setToast({
      title,
      message,
      type
    });
    setTimeout(() => setToast(null), 4000);
  };

  // Automated Luxury Welcome Toast on App Load / Login
  useEffect(() => {
    if (client && client.name) {
      const sessionKey = 'KAYAN_WELCOMED_' + (client.id || client.username || 'user');
      if (!sessionStorage.getItem(sessionKey)) {
        sessionStorage.setItem(sessionKey, 'true');
        const hour = new Date().getHours();
        const timeGreeting = hour >= 5 && hour < 12 ? 'صباح الخير والبركة ☀️' : 'مساء الخير والتميز 🌙';
        const isFT = client.subscriptionType === 'fulltime' || client.subscriptionType === 'shift' || client.isFullTime || client.packageDuration && client.packageDuration.startsWith('fulltime') || client.package && (client.package.includes('Full Time') || client.package.includes('دوام كامل') || client.package.includes('الشيفت'));
        let welcomeBody = '';
        if (isFT) {
          const contract = getClientContractStatus(client);
          const remDays = contract.daysLeft !== null && contract.daysLeft >= 0 ? contract.daysLeft : 0;
          const roomStr = client.dedicatedRoom || client.room || 'المكتب التنفيذي الخاص';
          welcomeBody = `أهلاً بك بنظام الدوام الكامل! مكتبك المخصص: (${roomStr}) • متبقي ${remDays} يوم حتى موعد التجديد القادم. نتمنى لك أوقاتاً مثمرة ومميزة! 👑`;
        } else {
          const curBal = client.currentBalance !== undefined && client.currentBalance !== null ? client.currentBalance : 0;
          welcomeBody = `أهلاً بك في ${settings.companyName || 'مجموعة الكيان'}. رصيدك المتاح: ${curBal} ساعة. نتمنى لك وقتاً مثمراً! ✨`;
        }
        setTimeout(() => {
          triggerToast(`${timeGreeting} أ/ ${client.name} 🌟`, welcomeBody, 'success');
        }, 500);
      }
    }
  }, [client?.id, client?.name]);

  // 🚨 Strict 100% Unskippable Alert on App Load / Refresh (<= 7 days FT / <= 5 hours Hourly)
  useEffect(() => {
    if (client && client.name) {
      const contract = getClientContractStatus(client);
      const isFT = contract.isFullTime;
      const daysLeft = contract.daysLeft;
      const curBal = parseFloat(client.currentBalance || 0);
      const isFulltimeLast7Days = isFT && daysLeft !== null && daysLeft <= 7;
      const isHourlyLast5Hours = !isFT && curBal <= 5;
      if (isFulltimeLast7Days || isHourlyLast5Hours) {
        setTimeout(() => {
          setShowStrictAlertModal(true);
        }, 800);
      } else {
        setShowStrictAlertModal(false);
      }
    }
  }, [client?.id, client?.name, client?.currentBalance, client?.expiryDate]);

  // 1. Check URL parameters for 1-Tap Instant Auto-Login & saved session (24/7 Persistent auto-login)
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.location) {
        const urlParams = new URLSearchParams(window.location.search);
        const urlUser = urlParams.get('u') || urlParams.get('user') || urlParams.get('username') || urlParams.get('phone') || urlParams.get('client');
        const urlPass = urlParams.get('p') || urlParams.get('pass') || urlParams.get('password');
        if (urlUser) {
          executeLogin(urlUser, urlPass || urlUser, true);
          return;
        }
      }

      // 🛡️ If client session already exists, DO NOT re-login to avoid UI flicker or loading stale cache
      if (client) {
        fetchClientData(client);
        return;
      }
      const savedUser = localStorage.getItem('KAYAN_MOBILE_USER');
      if (savedUser) {
        const parsed = JSON.parse(savedUser);
        if (parsed && parsed.username && parsed.password) {
          executeLogin(parsed.username, parsed.password, true);
          return;
        }
      }
      const sess = localStorage.getItem('al_kayan_client_session');
      if (sess) {
        const parsedSess = JSON.parse(sess);
        if (parsedSess && parsedSess.credentials?.username && parsedSess.credentials?.password) {
          executeLogin(parsedSess.credentials.username, parsedSess.credentials.password, true);
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
  const fetchClientData = async (currentClient = client) => {
    syncPendingBookings();
    if (!currentClient) return;
    try {
      setIsSyncing(true);
      let clientFound = false;

      // A. Direct Real-time Cloud Firebase Pull (Primary source of truth for mobile 24/7)
      try {
        const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db.json?t=${Date.now()}`, {
          cache: 'no-store'
        });
        if (fbRes.ok) {
          const fbDb = await fbRes.json();
          if (fbDb && typeof fbDb === 'object') {
            let fbClients = Array.isArray(fbDb.clients) ? fbDb.clients : fbDb.clients && typeof fbDb.clients === 'object' ? Object.values(fbDb.clients) : [];
            if (fbClients.length === 0) {
              try {
                const cDirectRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json?t=${Date.now()}`, {
                  cache: 'no-store'
                });
                if (cDirectRes.ok) {
                  const directC = await cDirectRes.json();
                  if (directC) {
                    fbClients = Array.isArray(directC) ? directC : Object.values(directC);
                  }
                }
              } catch (cfErr) {}
            }
            const fbBookings = fbDb.bookings ? Array.isArray(fbDb.bookings) ? fbDb.bookings : Object.entries(fbDb.bookings).map(([k, v]) => v && typeof v === 'object' ? {
              key: k,
              id: v.id || v.key || k,
              ...v
            } : v) : [];
            const fbAttendance = Array.isArray(fbDb.attendance) ? fbDb.attendance : fbDb.attendance && typeof fbDb.attendance === 'object' ? Object.values(fbDb.attendance) : [];
            let fbNotifs = [];
            if (Array.isArray(fbDb.notifications)) {
              fbNotifs = fbDb.notifications;
            } else if (fbDb.notifications && typeof fbDb.notifications === 'object') {
              fbNotifs = Object.values(fbDb.notifications);
            }
            const fbDeleted = fbDb.deleted_clients ? Array.isArray(fbDb.deleted_clients) ? fbDb.deleted_clients : Object.values(fbDb.deleted_clients) : [];
            const curU = toStandardDigits(currentClient.username || '').toLowerCase();
            const curPhone = toStandardDigits(currentClient.phone || '').trim();
            const curPhoneDigits = curPhone.replace(/\D/g, '');
            const curId = (currentClient.id || '').toString().trim();

            // Find matching client using priority hierarchy
            let matched = null;
            // 1. Exact ID
            if (curId) {
              matched = fbClients.find(c => c && c.id === curId);
            }
            // 2. Exact Username
            if (!matched && curU) {
              matched = fbClients.find(c => c && toStandardDigits(c.username || '').toLowerCase() === curU);
            }
            // 3. Exact Phone (>= 8 digits)
            if (!matched && curPhoneDigits && curPhoneDigits.length >= 8) {
              matched = fbClients.find(c => {
                if (!c) return false;
                const cDigits = toStandardDigits(c.phone || '').replace(/\D/g, '');
                return cDigits && (cDigits === curPhoneDigits || cDigits.endsWith(curPhoneDigits) || curPhoneDigits.endsWith(cDigits));
              });
            }
            // 4. Exact Name Match
            if (!matched && currentClient.name) {
              const curNm = currentClient.name.toString().trim().toLowerCase();
              matched = fbClients.find(c => c && (c.name || '').toString().trim().toLowerCase() === curNm);
            }

            // 🚨 SENTINEL 1: Check if client is in deleted_clients blacklist AND NOT ACTIVE
            const isBlacklisted = fbDeleted.some(dc => {
              if (!dc) return false;
              const dcId = (dc.id || '').toString().trim();
              const dcU = toStandardDigits(dc.username || '').toLowerCase();
              const dcP = toStandardDigits(dc.phone || '').replace(/\D/g, '');
              if (curId && dcId && dcId === curId) return true;
              if (curU && dcU && dcU === curU) return true;
              if (curPhoneDigits.length >= 8 && dcP.length >= 8 && (dcP === curPhoneDigits || dcP.endsWith(curPhoneDigits))) return true;
              return false;
            });
            if (isBlacklisted && !matched) {
              handleImmediateAccountPurge('تم حذف هذا الحساب نهائياً من قبل الإدارة العامة للمجموعة. تم إغلاق الجلسة فوراً.');
              return;
            }

            // 🚨 SENTINEL 2: Cloud database has active clients, but this client does NOT exist -> likely deleted
            // Safety checks to prevent false positives during sync/re-registration:
            // - Require at least 2 clients in Firebase (not just 1 test record)
            // - Require deleted_clients list to be empty (no ongoing deletion sync) 
            if (fbClients.length >= 2 && fbDeleted.length === 0 && !matched) {
              handleImmediateAccountPurge('تم حذف هذا الحساب نهائياً من قاعدة بيانات المجموعة. تم إغلاق الجلسة فوراً.');
              return;
            }
            if (matched) {
              const unifiedBalance = matched.currentBalance !== undefined && matched.currentBalance !== null && !isNaN(parseFloat(matched.currentBalance)) ? parseFloat(matched.currentBalance) : matched.initialHours !== undefined ? parseFloat(matched.initialHours) : 0;
              const unifiedClient = {
                ...matched,
                currentBalance: unifiedBalance
              };

              // NOTE: setClient will be called below AFTER financialBalance is recomputed from transactions
              clientFound = true;

              // 0. Enforce local persistent blacklist of cancelled bookings (both global and per-client)
              const cancelledKey = 'ALKAYAN_CANCELLED_BOOKINGS_' + (matched.id || matched.username || 'all');
              let locallyCancelledIds = new Set();
              try {
                const pList = JSON.parse(localStorage.getItem(cancelledKey) || '[]');
                const gList = JSON.parse(localStorage.getItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL') || '[]');
                locallyCancelledIds = new Set([...pList, ...gList]);
              } catch (e) {}
              fbBookings.forEach(b => {
                if (b && (locallyCancelledIds.has(b.id) || b.status === 'cancelled')) {
                  b.status = 'cancelled';
                }
              });

              // Filter client's bookings
              const myB = fbBookings.filter(b => b && (b.clientId === matched.id || b.username === matched.username || matched.phone && b.clientPhone === matched.phone));
              const myA = fbAttendance.filter(a => a && (a.clientId === matched.id || matched.phone && a.clientPhone === matched.phone));
              const activeScheduled = fbBookings.filter(b => b && b.status === 'scheduled');
              setMyBookings(deduplicateBookings(myB));
              setAllBookings(activeScheduled);

              // 🔒 Filter client's financial transactions with STRICT 3-FIELD exact matching
              // (prevents cross-client data leakage from partial phone matches)
              const allFinancial = Array.isArray(fbDb.financial_transactions) ? fbDb.financial_transactions : fbDb.financial_transactions && typeof fbDb.financial_transactions === 'object' ? Object.values(fbDb.financial_transactions) : [];
              const _mId = (matched.id || '').toString().trim();
              const _mUser = (matched.username || '').trim().toLowerCase();
              const clientCreatedTime = getClientCreationTime(matched);
              const myFin = allFinancial.filter(t => {
                if (!t) return false;
                // 🛡️ CHRONOLOGICAL FILTER: Ignore transactions created before client account registration
                const txTime = getRecordTimestamp(t);
                if (clientCreatedTime > 0 && txTime > 0 && txTime < clientCreatedTime - 60000) {
                  return false;
                }
                // 1. Exact client ID match (authoritative)
                if (_mId && t.clientId === _mId) return true;
                // 2. Exact username match only if not assigned to a different client ID
                const tUser = (t.clientUsername || '').trim().toLowerCase();
                if (_mUser && tUser && tUser === _mUser && (!t.clientId || t.clientId === _mId)) return true;
                // ⛔ NEVER match transactions by phone number alone!
                return false;
              });
              setMyFinancialTransactions(myFin);

              // 🔒 RECOMPUTE financialBalance from actual transactions (source of truth)
              // Never rely on stored financialBalance which may be stale
              let recomputedFinBalance = 0;
              myFin.forEach(t => {
                const amt = parseFloat(t.amount) || 0;
                if (t.type === 'charge') recomputedFinBalance -= amt; // مطلوب منه → رصيد سالب
                else if (t.type === 'payment') recomputedFinBalance += amt; // سداد → رصيد موجب
              });

              // Build final client object with corrected balance
              const finalClient = {
                ...unifiedClient,
                financialBalance: recomputedFinBalance
              };
              setClient(finalClient);

              // Persist corrected balance in session
              try {
                const s = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
                s.client = finalClient;
                s.financialTransactions = myFin;
                localStorage.setItem('al_kayan_client_session', JSON.stringify(s));
              } catch (e) {}
              const myNotifs = fbNotifs.filter(n => isNotificationForClient(n, matched));

              // 1. Apply persistent read status from localStorage
              const uKey = getClientStorageKey(matched);
              const readStorageKey = 'ALKAYAN_READ_NOTIFS_' + uKey;
              let locallyReadIds = new Set();
              try {
                locallyReadIds = new Set(JSON.parse(localStorage.getItem(readStorageKey) || '[]'));
              } catch (e) {}
              const processedIncoming = (myNotifs || []).map(n => {
                if (n && n.id && (locallyReadIds.has(n.id) || n.read)) {
                  return {
                    ...n,
                    read: true
                  };
                }
                return n;
              });

              // 2. SMART MERGE: Keep only notifications belonging strictly to THIS client
              setNotifications(prev => {
                const map = new Map();

                // Keep only previously loaded notifications that belong to THIS matched client!
                (prev || []).forEach(n => {
                  if (n && n.id && isNotificationForClient(n, matched)) {
                    const isRead = locallyReadIds.has(n.id) || n.read;
                    map.set(n.id, {
                      ...n,
                      read: isRead
                    });
                  }
                });

                // Add or update with incoming notifications belonging strictly to THIS client
                processedIncoming.forEach(n => {
                  if (n && n.id && isNotificationForClient(n, matched)) {
                    const existing = map.get(n.id);
                    const isRead = locallyReadIds.has(n.id) || existing && existing.read || n.read;
                    map.set(n.id, {
                      ...n,
                      ...(existing || {}),
                      ...n,
                      read: isRead
                    });
                  }
                });
                let allMerged = Array.from(map.values());
                allMerged.sort((a, b) => getNotifTimestamp(b) - getNotifTimestamp(a));

                // 🛡️ When matched client is renewed and active, purge stale expiry warnings from local store & UI
                const matchedContract = getClientContractStatus(matched);
                const isMatchedFT = matchedContract.isFullTime;
                const matchedBal = parseFloat(matched.currentBalance || 0);
                if (!matchedContract.isExpired && (isMatchedFT || matchedBal > 0)) {
                  allMerged = allMerged.filter(n => {
                    if (!n) return false;
                    const t = ((n.title || '') + ' ' + (n.message || '') + ' ' + (n.text || '')).toLowerCase();
                    return !(n.type === 'expiry' || n.type === 'contract_expired' || t.includes('انتهت باقة') || t.includes('انتهاء العقد') || t.includes('نفد رصيد') || t.includes('نفاد رصيد') || t.includes('رصيد منته') || t.includes('انتهى اشتراك'));
                  });
                }
                if (uKey) {
                  try {
                    localStorage.setItem('ALKAYAN_NOTIFS_STORE_' + uKey, JSON.stringify(allMerged));
                  } catch (e) {}
                }
                notificationsRef.current = allMerged;
                setUnreadNotifCount(allMerged.filter(n => !n.read).length);
                return allMerged;
              });

              // 3. Deliver any truly NEW unseen notifications with sound + vibration + popup + native alert
              if (!initialNotifSyncDoneRef.current) {
                initialNotifSyncDoneRef.current = true;
                (processedIncoming || []).forEach(n => {
                  if (n && n.id) {
                    try {
                      localStorage.setItem('KAYAN_SEEN_POPUP_' + n.id, 'true');
                    } catch (e) {}
                  }
                });
              } else {
                const unseenUnread = processedIncoming.filter(n => n && n.id && !n.read && !localStorage.getItem('KAYAN_SEEN_POPUP_' + n.id));
                if (unseenUnread.length > 0) {
                  const newest = unseenUnread[0];
                  handleIncomingNotificationInstantly(newest);
                }
              }
              if (fbDb.settings) {
                setSettings(prev => ({
                  ...prev,
                  ...fbDb.settings
                }));
                if (!bookingForm.room && fbDb.settings.rooms && fbDb.settings.rooms.length > 0) {
                  setBookingForm(b => ({
                    ...b,
                    room: fbDb.settings.rooms[0]
                  }));
                }
              }
              setLastSyncTime(new Date().toLocaleTimeString('ar-SA', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
              }));
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
          const json = res.ok ? await res.json() : null;
          if (json && json.success) {
            if (Array.isArray(json.myBookings)) setMyBookings(deduplicateBookings(json.myBookings));
            if (Array.isArray(json.allBookings)) setAllBookings(json.allBookings);
            if (Array.isArray(json.myAttendance)) setMyAttendance(json.myAttendance);

            // 🔒 Recompute financialBalance from server transactions (source of truth)
            if (json.client) {
              const serverTxs = Array.isArray(json.financialTransactions) ? json.financialTransactions : [];
              setMyFinancialTransactions(serverTxs);
              let serverFinBal = 0;
              serverTxs.forEach(t => {
                const amt = parseFloat(t.amount) || 0;
                if (t.type === 'charge') serverFinBal -= amt;else if (t.type === 'payment') serverFinBal += amt;
              });
              const correctedClient = {
                ...json.client,
                financialBalance: serverFinBal
              };
              setClient(correctedClient);
              try {
                const s = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
                s.client = correctedClient;
                s.financialTransactions = serverTxs;
                localStorage.setItem('al_kayan_client_session', JSON.stringify(s));
              } catch (e) {}
            }
            if (Array.isArray(json.notifications) && json.notifications.length > 0) {
              setNotifications(prev => {
                const map = new Map();
                (prev || []).forEach(n => {
                  if (n && n.id && isNotificationForClient(n, currentClient)) map.set(n.id, n);
                });
                (json.notifications || []).forEach(n => {
                  if (n && n.id && isNotificationForClient(n, currentClient)) {
                    const existing = map.get(n.id);
                    map.set(n.id, {
                      ...n,
                      ...(existing || {}),
                      ...n,
                      read: existing && existing.read || n.read
                    });
                  }
                });
                const merged = Array.from(map.values());
                merged.sort((a, b) => getNotifTimestamp(b) - getNotifTimestamp(a));
                return merged;
              });
            }
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
        } catch (apiErr) {}
      }
    } catch (e) {
      console.warn('Sync error:', e);
    } finally {
      setIsSyncing(false);
    }
  };

  // 3. Instant Real-Time Notification Listener + Periodic Polling (0.05s response time)
  useEffect(() => {
    if (!client) return;
    fetchClientData();

    // Fast backup interval
    const interval = setInterval(() => {
      fetchClientData();
    }, 2000);

    // Instant EventSource Streaming from Firebase Realtime Database (0.02s latency)
    let es = null;
    try {
      if (typeof window !== 'undefined' && window.EventSource) {
        es = new EventSource(`${FIREBASE_BASE_URL}/alkayan_db/latest_notification.json`);
        es.addEventListener('put', e => {
          try {
            const parsed = JSON.parse(e.data);
            const notif = parsed ? parsed.data : null;
            if (notif && notif.id) {
              handleIncomingNotificationInstantly(notif);
            }
          } catch (err) {}
          fetchClientData();
        });
      }
    } catch (err) {
      console.warn('EventSource listener error:', err);
    }

    // ⚡ INSTANT PURGE KILL-SWITCH: Listen to Firebase latest_purged_client event stream (<0.05s response)
    let purgeEs = null;
    try {
      if (typeof window !== 'undefined' && window.EventSource) {
        purgeEs = new EventSource(`${FIREBASE_BASE_URL}/alkayan_db/latest_purged_client.json`);
        const onPurgeEvent = e => {
          try {
            const parsed = JSON.parse(e.data);
            const data = parsed ? parsed.data || parsed : null;
            // Skip clear/reset signals
            if (!data || data.id === 'clear' || data.timestamp === 0) return;
            if (data && client) {
              const curId = (client.id || '').toString().trim();
              const curU = (client.username || '').toString().trim().toLowerCase();
              const curP = (client.phone || '').replace(/\D/g, '');
              const pId = (data.id || '').toString().trim();
              const pU = (data.username || '').toString().trim().toLowerCase();
              const pP = (data.phone || '').replace(/\D/g, '');
              // Extra safety: if client exists in fbClients (active list), do NOT purge
              if (window.__fbActiveClientIds && window.__fbActiveClientIds.has(curId)) return;
              if (pId && curId && pId === curId || pU && curU && pU === curU || pP && curP && pP.length >= 8 && pP === curP) {
                handleImmediateAccountPurge('تم حذف هذا الحساب نهائياً من قبل الإدارة العامة للمجموعة. تم طرد الجلسة فوراً.');
              }
            }
          } catch (err) {}
        };
        purgeEs.addEventListener('put', onPurgeEvent);
        purgeEs.onmessage = onPurgeEvent;
      }
    } catch (purgeErr) {}

    // ⚡ INSTANT CLIENT RENEWAL / UPDATE SSE LISTENER (<0.02s response)
    let clientUpdateEs = null;
    try {
      if (typeof window !== 'undefined' && window.EventSource) {
        clientUpdateEs = new EventSource(`${FIREBASE_BASE_URL}/alkayan_db/latest_client_update.json`);
        const onClientUpdateEvent = e => {
          try {
            const parsed = JSON.parse(e.data);
            const data = parsed ? parsed.data || parsed : null;
            if (data && client) {
              const curId = (client.id || '').toString().trim();
              const curU = toStandardDigits(client.username || '').toString().trim().toLowerCase();
              const curP = toStandardDigits(client.phone || '').replace(/\D/g, '');
              const uId = (data.clientId || data.client && data.client.id || '').toString().trim();
              const uU = toStandardDigits(data.clientUsername || data.client && data.client.username || '').toString().trim().toLowerCase();
              const uP = toStandardDigits(data.clientPhone || data.client && data.client.phone || '').replace(/\D/g, '');
              const isMatch = uId && curId && uId === curId || uU && curU && uU === curU || uP && curP && curP.length >= 8 && (uP === curP || uP.endsWith(curP) || curP.endsWith(uP));
              if (isMatch && data.client) {
                const isFT = data.client.isFullTime || data.client.subscriptionType === 'fulltime' || data.client.subscriptionType === 'shift';
                const parsedBal = data.client.currentBalance !== undefined && data.client.currentBalance !== null && !isNaN(parseFloat(data.client.currentBalance)) ? parseFloat(data.client.currentBalance) : data.client.initialHours !== undefined && !isFT ? parseFloat(data.client.initialHours) : null;
                const freshClient = {
                  ...client,
                  ...data.client,
                  currentBalance: isFT ? null : parsedBal
                };
                setClient(freshClient);
                try {
                  const s = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
                  s.client = freshClient;
                  localStorage.setItem('al_kayan_client_session', JSON.stringify(s));
                } catch (err) {}

                // Instant celebratory toast & sound
                if (data.action === 'renewal' || data.action === 'recharge') {
                  const balStr = isFT ? 'دوام كامل' : `${freshClient.currentBalance ?? 0} ساعة`;
                  triggerToast('🎉 تم تجديد / شحن باقتك بنجاح!', `رصيدك المتاح الآن: (${balStr}) | سارٍ حتى: (${freshClient.expiryDate}). نتمنى لك وقتاً مثمراً! ✨`, 'success');
                  try {
                    const a = new Audio('./notification.wav');
                    a.volume = 0.5;
                    a.play().catch(() => {});
                  } catch (err) {}
                }
              }
            }
          } catch (err) {}
          fetchClientData();
        };
        clientUpdateEs.addEventListener('put', onClientUpdateEvent);
        clientUpdateEs.onmessage = onClientUpdateEvent;
      }
    } catch (clientUpdateErr) {}

    // ⚡ INSTANT BOOKING UPDATE / ROOM RELEASE SSE LISTENER (<0.02s response)
    let bookingUpdateEs = null;
    try {
      if (typeof window !== 'undefined' && window.EventSource) {
        bookingUpdateEs = new EventSource(`${FIREBASE_BASE_URL}/alkayan_db/latest_booking_update.json`);
        const onBookingUpdateEvent = e => {
          try {
            const parsed = JSON.parse(e.data);
            const data = parsed ? parsed.data || parsed : null;
            if (data && (data.action === 'cancel' || data.status === 'cancelled') && data.bookingId) {
              const bId = data.bookingId;
              // 1. Add to global blacklist in localStorage
              try {
                const cur = JSON.parse(localStorage.getItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL') || '[]');
                if (!cur.includes(bId)) {
                  localStorage.setItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL', JSON.stringify([...cur, bId]));
                }
              } catch (_) {}

              // 2. Immediately update allBookings state to release the room slot (< 0.02s)
              setAllBookings(prev => {
                const list = Array.isArray(prev) ? prev : Object.values(prev || {});
                return list.map(item => item && item.id === bId ? {
                  ...item,
                  status: 'cancelled'
                } : item);
              });

              // 3. If it belongs to current client, also update myBookings
              setMyBookings(prev => {
                const list = Array.isArray(prev) ? prev : Object.values(prev || {});
                return list.map(item => item && item.id === bId ? {
                  ...item,
                  status: 'cancelled'
                } : item);
              });
            }
          } catch (err) {}
          fetchClientData();
        };
        bookingUpdateEs.addEventListener('put', onBookingUpdateEvent);
        bookingUpdateEs.onmessage = onBookingUpdateEvent;
      }
    } catch (bookingUpdateErr) {}
    return () => {
      clearInterval(interval);
      if (bookingUpdateEs) {
        try {
          bookingUpdateEs.close();
        } catch (e) {}
      }
      if (clientUpdateEs) {
        try {
          clientUpdateEs.close();
        } catch (e) {}
      }
      if (purgeEs) {
        try {
          purgeEs.close();
        } catch (e) {}
      }
      if (es) {
        try {
          es.close();
        } catch (e) {}
      }
    };
  }, [client?.id]);

  // Unlock Mobile Web Audio & Sound Context on First User Touch
  useEffect(() => {
    const unlockAudio = () => {
      try {
        const a = new Audio('./notification.wav');
        a.volume = 0.01;
        a.play().then(() => {
          a.pause();
          a.currentTime = 0;
          window.KAYAN_AUDIO_UNLOCKED = true;
        }).catch(() => {});
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === 'suspended') ctx.resume();
          window.KAYAN_AUDIO_CTX = ctx;
        }
      } catch (e) {}
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('touchstart', unlockAudio);
    };
    document.addEventListener('click', unlockAudio, {
      once: true
    });
    document.addEventListener('touchstart', unlockAudio, {
      once: true
    });
    return () => {
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('touchstart', unlockAudio);
    };
  }, []);

  // 4. Register active client with Service Worker for 24/7 background push notifications
  useEffect(() => {
    if (!client) return;
    const registerWithSW = () => {
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'REGISTER_CLIENT',
          client: {
            id: client.id,
            name: client.name,
            username: client.username,
            phone: client.phone
          }
        });
      }
    };
    registerWithSW();
    const onSWMessage = e => {
      if (e.data && e.data.type === 'NAVIGATE_TAB' && e.data.tab) {
        setActiveTab(e.data.tab);
      }
    };
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSWMessage);
      return () => navigator.serviceWorker.removeEventListener('message', onSWMessage);
    }
  }, [client?.id]);

  // Helper to lookup client in live cloud sources (Firebase Realtime DB -> Direct Clients Table -> Vercel Serverless -> Static Snapshot)
  const lookupInCloudSnapshot = async (cleanUser, cleanPass) => {
    let portalData = null;

    // 1. Direct Firebase Realtime Database Full Snapshot (Primary Live Source)
    try {
      const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db.json`, {
        cache: 'no-store'
      });
      if (fbRes.ok) {
        const fbJson = await fbRes.json();
        if (fbJson && typeof fbJson === 'object') {
          const cList = Array.isArray(fbJson.clients) ? fbJson.clients : fbJson.clients && typeof fbJson.clients === 'object' ? Object.values(fbJson.clients) : [];
          if (cList.length > 0) {
            portalData = {
              ...fbJson,
              clients: cList
            };
            window.ALKAYAN_PORTAL_DATA = portalData;
          }
        }
      }
    } catch (fbErr) {
      console.log('Firebase full db fetch note:', fbErr);
    }

    // 1.5 Direct fallback to /alkayan_db/clients.json (Ultra-fast direct table lookup)
    if (!portalData || !portalData.clients || portalData.clients.length === 0) {
      try {
        const cRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json`, {
          cache: 'no-store'
        });
        if (cRes.ok) {
          const cJson = await cRes.json();
          const cList = Array.isArray(cJson) ? cJson : cJson && typeof cJson === 'object' ? Object.values(cJson) : [];
          if (cList.length > 0) {
            portalData = {
              clients: cList,
              bookings: [],
              attendance: [],
              notifications: [],
              settings: {}
            };
            window.ALKAYAN_PORTAL_DATA = portalData;
          }
        }
      } catch (cErr) {
        console.log('Firebase direct clients fetch note:', cErr);
      }
    }

    // 2. Fallback to Vercel Serverless /api/sync
    if (!portalData || !portalData.clients || portalData.clients.length === 0) {
      try {
        const sRes = await fetch('/api/sync?t=' + Date.now(), {
          cache: 'no-store'
        });
        if (sRes.ok) {
          const sJson = await sRes.json();
          if (sJson && sJson.data) {
            const sClients = Array.isArray(sJson.data.clients) ? sJson.data.clients : sJson.data.clients && typeof sJson.data.clients === 'object' ? Object.values(sJson.data.clients) : [];
            if (sClients.length > 0) {
              portalData = {
                ...sJson.data,
                clients: sClients
              };
              window.ALKAYAN_PORTAL_DATA = portalData;
            }
          }
        }
      } catch (sErr) {
        console.log('Could not reach /api/sync, falling back to static snapshot');
      }
    }

    // 3. Fallback to portal_data.json or window global
    if (!portalData || !portalData.clients || portalData.clients.length === 0) {
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
    if (!portalData) {
      portalData = window.ALKAYAN_PORTAL_DATA;
    }
    if (!portalData || !portalData.clients) return null;
    const clientsList = Array.isArray(portalData.clients) ? portalData.clients : Object.values(portalData.clients);
    if (clientsList.length === 0) return null;

    // 🚫 SENTINEL: Check deleted_clients blacklist from cloud
    const delList = portalData.deleted_clients ? Array.isArray(portalData.deleted_clients) ? portalData.deleted_clients : Object.values(portalData.deleted_clients) : [];
    const isPurgedInCloud = delList.some(dc => {
      if (!dc) return false;
      const dcId = (dc.id || '').toString().trim().toLowerCase();
      const dcUser = toStandardDigits(dc.username || '').trim().toLowerCase();
      const dcPhone = toStandardDigits(dc.phone || '').replace(/\D/g, '');
      if (dcId && dcId === cleanUser.toLowerCase()) return true;
      if (dcUser && dcUser === cleanUser.toLowerCase()) return true;
      const userDigits = cleanUser.replace(/\D/g, '');
      if (userDigits.length >= 8 && dcPhone.length >= 8 && (dcPhone === userDigits || dcPhone.endsWith(userDigits))) return true;
      return false;
    });
    if (isPurgedInCloud) {
      return {
        isPurged: true,
        message: 'تم حذف هذا الحساب نهائياً من قبل الإدارة العامة للمجموعة ولا يمكن الدخول إليه.'
      };
    }

    // ⚡ Robust Smart Password Matching Tolerance
    const checkPasswordMatch = (clientObj, inPass) => {
      if (!inPass) return true;
      const cPass = (clientObj.password || '').toString().trim();
      const cUser = (clientObj.username || '').toString().trim().toLowerCase();
      const cPhone = (clientObj.phone || '').toString().trim();
      const cStd = toStandardDigits(cPass).toLowerCase();
      const inStd = toStandardDigits(inPass).toLowerCase();
      if (cStd === inStd) return true;
      if (inStd === cUser) return true;
      const normDigits = p => {
        if (!p) return '';
        const d = toStandardDigits(p).replace(/\D/g, '');
        return d.startsWith('20') && d.length > 10 ? '0' + d.slice(2) : d;
      };
      const cDigits = normDigits(cPass);
      const inDigits = normDigits(inPass);
      if (cDigits && inDigits && cDigits.length >= 8 && inDigits.length >= 8) {
        if (cDigits === inDigits || cDigits.endsWith(inDigits) || inDigits.endsWith(cDigits)) return true;
      }
      const pDigits = normDigits(cPhone);
      if (pDigits && inDigits && pDigits.length >= 8 && inDigits.length >= 8) {
        if (pDigits === inDigits || pDigits.endsWith(inDigits) || inDigits.endsWith(pDigits)) return true;
      }
      return false;
    };
    const normDigits = p => {
      if (!p) return '';
      const d = toStandardDigits(p).replace(/\D/g, '');
      return d.startsWith('20') && d.length > 10 ? '0' + d.slice(2) : d;
    };
    const uLow = cleanUser.toLowerCase();
    const userDigits = cleanUser.replace(/\D/g, '');
    const isPhoneCandidate = userDigits.length >= 8 && cleanUser.replace(/[\d\+\s\-]/g, '') === '';
    const userNormPhone = normDigits(cleanUser);
    let matchedClient = null;

    // 1. Exact Username Match (Case-Insensitive) - HIGHEST PRIORITY
    for (const c of clientsList) {
      if (!c) continue;
      const cUser = toStandardDigits(c.username || '').trim().toLowerCase();
      if (cUser && cUser === uLow) {
        matchedClient = c;
        break;
      }
    }

    // 2. Exact Phone Number Match (Strictly >= 8 digits, only when input looks like phone)
    if (!matchedClient && isPhoneCandidate) {
      for (const c of clientsList) {
        if (!c) continue;
        const cPhoneNorm = normDigits(c.phone || '');
        if (cPhoneNorm && cPhoneNorm.length >= 8) {
          if (cPhoneNorm === userNormPhone || cPhoneNorm.endsWith(userNormPhone) || userNormPhone.endsWith(cPhoneNorm)) {
            matchedClient = c;
            break;
          }
        }
      }
    }

    // 3. Client ID Match
    if (!matchedClient) {
      for (const c of clientsList) {
        if (!c) continue;
        const cId = (c.id || '').toString().trim().toLowerCase();
        if (cId && cId === uLow) {
          matchedClient = c;
          break;
        }
      }
    }

    // 4. Client Name Match
    if (!matchedClient) {
      for (const c of clientsList) {
        if (!c) continue;
        const cName = (c.name || '').toString().trim().toLowerCase();
        if (cName && cName === uLow) {
          matchedClient = c;
          break;
        }
      }
    }

    // 5. Reverse / Swapped Credential Recovery
    if (!matchedClient) {
      for (const c of clientsList) {
        if (!c) continue;
        const cUser = toStandardDigits(c.username || '').trim().toLowerCase();
        const cPass = toStandardDigits(c.password || '').trim().toLowerCase();
        if (cPass && cPass === uLow && (cUser === cleanPass.toLowerCase() || checkPasswordMatch(c, cleanUser))) {
          matchedClient = c;
          break;
        }
      }
    }
    if (matchedClient) {
      if (checkPasswordMatch(matchedClient, cleanPass) || !cleanPass) {
        const c = matchedClient;
        const cPhoneDigitsOnly = (c.phone || '').replace(/\D/g, '');
        const rawBookings = portalData.bookings || [];
        const bookingsList = Array.isArray(rawBookings) ? rawBookings : Object.values(rawBookings);
        const rawAttendance = portalData.attendance || [];
        const attendanceList = Array.isArray(rawAttendance) ? rawAttendance : Object.values(rawAttendance);
        const rawNotifs = portalData.notifications || [];
        const notifsList = Array.isArray(rawNotifs) ? rawNotifs : Object.values(rawNotifs);
        const myB = bookingsList.filter(b => {
          if (!b) return false;
          if (c.id && (b.clientId === c.id || b.targetClientId === c.id)) return true;
          if (c.username && b.username && b.username.toString().trim().toLowerCase() === c.username.toString().trim().toLowerCase()) return true;
          const bPhone = (b.clientPhone || b.phone || '').replace(/\D/g, '');
          if (cPhoneDigitsOnly && bPhone && (cPhoneDigitsOnly === bPhone || cPhoneDigitsOnly.length >= 9 && bPhone.endsWith(cPhoneDigitsOnly) || bPhone.length >= 9 && cPhoneDigitsOnly.endsWith(bPhone))) return true;
          return false;
        });
        const myA = attendanceList.filter(a => {
          if (!a) return false;
          if (c.id && a.clientId === c.id) return true;
          if (c.username && a.username && a.username.toString().trim().toLowerCase() === c.username.toString().trim().toLowerCase()) return true;
          const aPhone = (a.clientPhone || a.phone || '').replace(/\D/g, '');
          if (cPhoneDigitsOnly && aPhone && (cPhoneDigitsOnly === aPhone || cPhoneDigitsOnly.length >= 9 && aPhone.endsWith(cPhoneDigitsOnly) || aPhone.length >= 9 && cPhoneDigitsOnly.endsWith(aPhone))) return true;
          return false;
        });
        const myN = notifsList.filter(n => isNotificationForClient(n, c));
        const clientCreatedTime = getClientCreationTime(c);
        const allFins = Array.isArray(portalData.financial_transactions) ? portalData.financial_transactions : [];
        const myF = allFins.filter(t => {
          if (!t) return false;
          const txTime = getRecordTimestamp(t);
          if (clientCreatedTime > 0 && txTime > 0 && txTime < clientCreatedTime - 60000) {
            return false;
          }
          if (c.id && t.clientId === c.id) return true;
          if (c.username && t.clientUsername && t.clientUsername.toString().trim().toLowerCase() === c.username.toString().trim().toLowerCase() && (!t.clientId || t.clientId === c.id)) return true;
          return false;
        });
        return {
          client: c,
          myBookings: myB,
          myAttendance: myA,
          allBookings: bookingsList.filter(b => b && b.status === 'scheduled'),
          notifications: myN,
          financialTransactions: myF,
          settings: portalData.settings || {}
        };
      } else {
        return 'INVALID_CREDENTIALS';
      }
    }
    return {
      notFoundInCloud: true,
      message: 'اسم المستخدم أو رقم الهاتف غير مسجل بالنظام أو تم حذفه نهائياً.'
    };
  };

  // Execute Login with 3-Layer Authentication (Server API -> Cloud Firebase / Snapshot -> Local Device Registry)
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

    // 1. Try Online Server API (when desktop system is running)
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
          try {
            const prevSess = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
            if (prevSess.client && prevSess.client.id && prevSess.client.id !== json.client.id) {
              const uKeyOld = getClientStorageKey(prevSess.client);
              localStorage.removeItem('ALKAYAN_NOTIFS_STORE_' + uKeyOld);
              localStorage.removeItem('ALKAYAN_READ_NOTIFS_' + uKeyOld);
            }
          } catch (e) {}
          const clientNotifs = (json.notifications || []).filter(n => isNotificationForClient(n, json.client));
          setClient(json.client);
          setMyBookings(deduplicateBookings(json.myBookings || []));
          setAllBookings(json.allBookings || []);
          setMyAttendance(json.myAttendance || []);
          setMyFinancialTransactions(json.financialTransactions || []);
          setNotifications(clientNotifs);
          notificationsRef.current = clientNotifs;
          setUnreadNotifCount(clientNotifs.filter(n => !n.read).length);
          if (json.settings) setSettings(prev => ({
            ...prev,
            ...json.settings
          }));
          const sessionObj = {
            client: json.client,
            myBookings: json.myBookings || [],
            myAttendance: json.myAttendance || [],
            financialTransactions: json.financialTransactions || [],
            notifications: clientNotifs,
            settings: json.settings || {},
            credentials: {
              username: cleanUser,
              password: cleanPass
            },
            savedAt: new Date().toISOString()
          };
          localStorage.setItem('al_kayan_client_session', JSON.stringify(sessionObj));
          localStorage.setItem('KAYAN_MOBILE_USER', JSON.stringify({
            username: cleanUser,
            password: cleanPass
          }));
          const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
          registry[cleanUser.toLowerCase()] = sessionObj;
          localStorage.setItem('al_kayan_client_registry', JSON.stringify(registry));
          const uKey = getClientStorageKey(json.client);
          if (uKey) {
            try {
              localStorage.setItem('ALKAYAN_NOTIFS_STORE_' + uKey, JSON.stringify(clientNotifs));
            } catch (e) {}
          }
          triggerToast('مرحباً بك 🌟', `تم تسجيل الدخول بنجاح يا ${json.client.name}`, 'success');
          setIsLoggingIn(false);
          return;
        }
      }
    } catch (netErr) {
      // Server is offline (normal for mobile / 24-7 remote usage) -> Seamlessly proceed to Cloud
    }

    // 2. Try Direct Cloud Firebase Realtime Database (24/7 Global Access)
    let cloudResult = null;
    try {
      cloudResult = await lookupInCloudSnapshot(cleanUser, cleanPass);
      if (cloudResult && cloudResult.isPurged) {
        purgeAccountFromDevice(cleanUser);
        setLoginError(cloudResult.message || 'تم حذف هذا الحساب نهائياً من قبل الإدارة العامة للمجموعة.');
        setIsLoggingIn(false);
        return;
      }
      if (cloudResult && cloudResult.notFoundInCloud) {
        purgeAccountFromDevice(cleanUser);
        setLoginError('اسم المستخدم أو رقم الهاتف غير مسجل بالنظام أو تم حذفه نهائياً.');
        setIsLoggingIn(false);
        return;
      }
      if (cloudResult === 'INVALID_CREDENTIALS') {
        setLoginError('كلمة المرور غير صحيحة. يرجى التأكد من كلمة المرور.');
        setIsLoggingIn(false);
        return;
      }
      if (cloudResult && typeof cloudResult === 'object' && cloudResult.client) {
        try {
          const prevSess = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
          if (prevSess.client && prevSess.client.id && prevSess.client.id !== cloudResult.client.id) {
            const uKeyOld = getClientStorageKey(prevSess.client);
            localStorage.removeItem('ALKAYAN_NOTIFS_STORE_' + uKeyOld);
            localStorage.removeItem('ALKAYAN_READ_NOTIFS_' + uKeyOld);
          }
        } catch (e) {}
        const clientNotifs = (cloudResult.notifications || []).filter(n => isNotificationForClient(n, cloudResult.client));
        setClient(cloudResult.client);
        setMyBookings(deduplicateBookings(cloudResult.myBookings || []));
        setAllBookings(cloudResult.allBookings || []);
        setMyAttendance(cloudResult.myAttendance || []);
        setMyFinancialTransactions(cloudResult.financialTransactions || []);
        setNotifications(clientNotifs);
        notificationsRef.current = clientNotifs;
        setUnreadNotifCount(clientNotifs.filter(n => !n.read).length);
        if (cloudResult.settings) setSettings(prev => ({
          ...prev,
          ...cloudResult.settings
        }));
        const sessionObj = {
          client: cloudResult.client,
          myBookings: cloudResult.myBookings || [],
          myAttendance: cloudResult.myAttendance || [],
          financialTransactions: cloudResult.financialTransactions || [],
          notifications: clientNotifs,
          settings: cloudResult.settings || {},
          credentials: {
            username: cleanUser,
            password: cleanPass
          },
          savedAt: new Date().toISOString()
        };
        localStorage.setItem('al_kayan_client_session', JSON.stringify(sessionObj));
        localStorage.setItem('KAYAN_MOBILE_USER', JSON.stringify({
          username: cleanUser,
          password: cleanPass
        }));
        const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
        registry[cleanUser.toLowerCase()] = sessionObj;
        localStorage.setItem('al_kayan_client_registry', JSON.stringify(registry));
        const uKey = getClientStorageKey(cloudResult.client);
        if (uKey) {
          try {
            localStorage.setItem('ALKAYAN_NOTIFS_STORE_' + uKey, JSON.stringify(clientNotifs));
          } catch (e) {}
        }
        triggerToast('مرحباً بك 🌟', `تم تسجيل الدخول بنجاح يا ${cloudResult.client.name} (بوابة العميل الذكية)`, 'success');
        setIsLoggingIn(false);
        return;
      }
    } catch (snapErr) {
      console.warn('Snapshot lookup error:', snapErr);
    }

    // 3. Try Local Device Cache Registry (Strict Offline Multi-Account Only)
    if (cloudResult && (cloudResult.isPurged || cloudResult.notFoundInCloud || cloudResult === 'INVALID_CREDENTIALS')) {
      setIsLoggingIn(false);
      return;
    }
    try {
      const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
      const currentCached = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
      let targetSession = null;
      for (const [k, sess] of Object.entries(registry)) {
        if (!sess || !sess.client) continue;
        const c = sess.client;
        const cUser = (c.username || '').toString().trim().toLowerCase();
        const cPhone = (c.phone || '').replace(/\D/g, '');
        const uDigits = cleanUser.replace(/\D/g, '');
        if (cUser === cleanUser.toLowerCase() || uDigits.length >= 8 && cPhone.endsWith(uDigits)) {
          if (sess.credentials?.password === cleanPass || !cleanPass) {
            targetSession = sess;
            break;
          }
        }
      }
      if (!targetSession && currentCached.client) {
        const c = currentCached.client;
        const cUser = (c.username || '').toString().trim().toLowerCase();
        const cPhone = (c.phone || '').replace(/\D/g, '');
        const uDigits = cleanUser.replace(/\D/g, '');
        if (cUser === cleanUser.toLowerCase() || uDigits.length >= 8 && cPhone.endsWith(uDigits)) {
          if (currentCached.credentials?.password === cleanPass || !cleanPass) {
            targetSession = currentCached;
          }
        }
      }
      if (targetSession && targetSession.client) {
        const clientNotifs = (targetSession.notifications || []).filter(n => isNotificationForClient(n, targetSession.client));
        setClient(targetSession.client);
        setMyBookings(deduplicateBookings(targetSession.myBookings || []));
        setMyAttendance(targetSession.myAttendance || []);
        setMyFinancialTransactions(targetSession.financialTransactions || []);
        setNotifications(clientNotifs);
        notificationsRef.current = clientNotifs;
        setUnreadNotifCount(clientNotifs.filter(n => !n.read).length);
        if (targetSession.settings) setSettings(prev => ({
          ...prev,
          ...targetSession.settings
        }));
        triggerToast('تسجيل الدخول التلقائي 📱', `أهلاً بك ${targetSession.client.name} (الوضع المحفوظ)`, 'info');
      } else {
        setLoginError('اسم المستخدم أو كلمة المرور غير صحيحة. يرجى التأكد من صحة البيانات المسجلة.');
      }
    } catch (cacheErr) {
      setLoginError('اسم المستخدم أو كلمة المرور غير صحيحة.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Expose helpers globally for seamless testing & recovery
  if (typeof window !== 'undefined') {
    window.lookupInCloudSnapshot = lookupInCloudSnapshot;
    window.executeLogin = executeLogin;
  }

  // 🛡️ Client Deletion Purge Helper: Wipes target account from local device storage completely
  const purgeAccountFromDevice = targetUserOrId => {
    if (!targetUserOrId) return;
    const targetStr = toStandardDigits(targetUserOrId).trim().toLowerCase();
    const targetDigits = targetStr.replace(/\D/g, '');
    try {
      const registry = JSON.parse(localStorage.getItem('al_kayan_client_registry') || '{}');
      for (const [k, v] of Object.entries(registry)) {
        const c = v?.client;
        const cUser = (c?.username || '').toLowerCase();
        const cId = (c?.id || '').toString().toLowerCase();
        const cPhone = (c?.phone || '').replace(/\D/g, '');
        if (k === targetStr || cUser === targetStr || cId === targetStr || targetDigits.length >= 8 && cPhone.endsWith(targetDigits)) {
          delete registry[k];
        }
      }
      localStorage.setItem('al_kayan_client_registry', JSON.stringify(registry));
    } catch (e) {}
    try {
      const sess = JSON.parse(localStorage.getItem('al_kayan_client_session') || '{}');
      const c = sess?.client;
      const cUser = (c?.username || '').toLowerCase();
      const cId = (c?.id || '').toString().toLowerCase();
      const cPhone = (c?.phone || '').replace(/\D/g, '');
      if (cUser === targetStr || cId === targetStr || targetDigits.length >= 8 && cPhone.endsWith(targetDigits)) {
        localStorage.removeItem('al_kayan_client_session');
        localStorage.removeItem('KAYAN_MOBILE_USER');
      }
    } catch (e) {}
  };

  // ⚡ INSTANT PURGE & PERMANENT LOCKOUT: Purges active session and prevents any further access
  const handleImmediateAccountPurge = (reason = 'تم حذف هذا الحساب نهائياً من قبل الإدارة العامة للمجموعة.') => {
    console.warn('🚨 IMMEDIATE ACCOUNT PURGE TRIGGERED:', reason);
    localStorage.removeItem('KAYAN_MOBILE_USER');
    localStorage.removeItem('al_kayan_client_session');
    if (client) {
      purgeAccountFromDevice(client.id || client.username);
      const uKey = getClientStorageKey(client);
      if (uKey) {
        try {
          localStorage.removeItem('ALKAYAN_NOTIFS_STORE_' + uKey);
          localStorage.removeItem('ALKAYAN_READ_NOTIFS_' + uKey);
        } catch (e) {}
      }
    }
    setClient(null);
    setMyBookings([]);
    setMyAttendance([]);
    setMyFinancialTransactions([]);
    setNotifications([]);
    notificationsRef.current = [];
    setUnreadNotifCount(0);
    setLoginForm({
      username: '',
      password: ''
    });
    setLoginError(reason);
    setActiveTab('home');
    triggerToast('تم قفل الحساب ⛔', reason, 'error');
  };

  // Handle Logout (Completely purge client session and cached notifications from localStorage)
  const handleLogout = () => {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('al_kayan_client_') || key.startsWith('KAYAN_') || key.startsWith('ALKAYAN_NOTIFS_') || key.startsWith('ALKAYAN_READ_'))) {
          if (key !== 'ALKAYAN_CANCELLED_BOOKINGS_GLOBAL') {
            keysToRemove.push(key);
          }
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
      localStorage.removeItem('KAYAN_MOBILE_USER');
      localStorage.removeItem('al_kayan_client_session');
      localStorage.removeItem('al_kayan_client_registry');
    } catch (e) {}
    setClient(null);
    setMyBookings([]);
    setMyAttendance([]);
    setMyFinancialTransactions([]);
    setNotifications([]); // 🔒 CLEAR ALL NOTIFICATIONS ON LOGOUT
    notificationsRef.current = [];
    setUnreadNotifCount(0); // 🔒 RESET NOTIFICATION BELL COUNT TO 0
    setLoginForm({
      username: '',
      password: ''
    });
    setActiveTab('home');
    triggerToast('تم تسجيل الخروج', 'تم تسجيل الخروج من حسابك بأمان ومسح الجلسة.', 'info');
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

  // Real-Time Strict Working Hours Check (10:00 AM to 10:00 PM Only)
  const workingHoursCheck = useMemo(() => {
    if (!bookingForm.time) return {
      isOutside: false
    };
    const startDec = parseArabicTimeToDecimal(bookingForm.time);
    const durNum = parseFloat(bookingForm.duration) || 1;
    const endDec = startDec + durNum;

    // Must start >= 10:00 AM (10.0), cannot start at or after 10:00 PM (22.0), and must end <= 10:00 PM (22.0)
    const isEarly = startDec < 10.0;
    const isLate = endDec > 22.0 || startDec >= 22.0;
    return {
      isOutside: isEarly || isLate,
      startDec,
      durNum,
      endDec,
      endTimeFormatted: decimalToTimeStr(endDec)
    };
  }, [bookingForm.time, bookingForm.duration]);

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

  // Stats for My Bookings Categorization (Strictly Deduplicated)
  const myBookingsStats = useMemo(() => {
    const all = deduplicateBookings(myBookings || []);
    let scheduled = 0;
    let attended = 0;
    let cancelled = 0;
    all.forEach(b => {
      const cat = getBookingDisplayCategory(b);
      if (cat === 'scheduled') scheduled++;else if (cat === 'attended') attended++;else if (cat === 'cancelled') cancelled++;
    });
    return {
      total: all.length,
      scheduled,
      attended,
      cancelled
    };
  }, [myBookings]);

  // Filtered List for My Bookings (Strictly Deduplicated)
  const filteredMyBookings = useMemo(() => {
    const all = deduplicateBookings(myBookings || []);
    return all.filter(b => {
      if (bookingFilter === 'all') return true;
      const cat = getBookingDisplayCategory(b);
      return cat === bookingFilter;
    });
  }, [myBookings, bookingFilter]);

  // 🛡️ Safe DOM Container State (React handles rendering inside #bookingsList / #cardsContainer)

  // ⚡ Firebase Realtime Database Listener Management with strict .off() before .on('value')
  useEffect(() => {
    let fbBookingsRef = null;
    let fbNotifsRef = null;
    try {
      if (typeof window !== 'undefined' && window.firebase && window.firebase.database) {
        // 1. Bookings Listener: ALWAYS call .off('value') before .on('value') to prevent stacking
        fbBookingsRef = window.firebase.database().ref('alkayan_db/bookings');
        fbBookingsRef.off('value');
        fbBookingsRef.on('value', snapshot => {
          const val = snapshot.val();
          if (val) {
            const rawList = Array.isArray(val) ? val : Object.values(val);
            const dedupedList = deduplicateBookings(rawList);
            setAllBookings(dedupedList.filter(b => b && b.status === 'scheduled'));
            if (client && client.id) {
              const myB = dedupedList.filter(b => b && (b.clientId === client.id || b.username === client.username));
              setMyBookings(deduplicateBookings(myB));
            }
          }
        });

        // 2. Notifications Listener: ALWAYS call .off('value') before .on('value') to prevent stacking
        fbNotifsRef = window.firebase.database().ref('alkayan_db/notifications');
        fbNotifsRef.off('value');
        fbNotifsRef.on('value', snapshot => {
          const val = snapshot.val();
          if (val) {
            const rawNotifs = Array.isArray(val) ? val : Object.values(val);
            if (client) {
              const clientNotifs = rawNotifs.filter(n => isNotificationForClient(n, client));
              setNotifications(clientNotifs);
            }
          }
        });
      }
    } catch (err) {
      console.warn('Firebase listener setup note:', err);
    }
    return () => {
      try {
        if (fbBookingsRef && typeof fbBookingsRef.off === 'function') {
          fbBookingsRef.off('value');
        }
        if (fbNotifsRef && typeof fbNotifsRef.off === 'function') {
          fbNotifsRef.off('value');
        }
      } catch (err) {}
    };
  }, [activeTab, client?.id]);

  // Client Contract Details
  const contractStatus = useMemo(() => {
    return getClientContractStatus(client);
  }, [client]);

  // Ensure Full-Time clients stay on appropriate tabs (Home, History, Notifications)
  useEffect(() => {
    if (contractStatus.isFullTime && (activeTab === 'book' || activeTab === 'mybookings')) {
      setActiveTab('home');
    }
  }, [contractStatus.isFullTime, activeTab]);

  // Handle Client Booking Submission
  const handleExecuteBooking = async e => {
    e.preventDefault();
    if (!bookingForm.date || !bookingForm.time || !bookingForm.duration) {
      triggerToast('خطأ', 'يرجى تعبئة كافة الحقول المطلوبة.', 'error');
      return;
    }
    setBookingSubmitting(true);
    try {
      // 1) قراءة مستند العميل الفعلي بالسحابة بناءً على هاتفه/معرفه والتأكد من رصيده
      const fbClientsRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json?t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (!fbClientsRes.ok) throw new Error('فشل الاتصال بقاعدة البيانات السحابية.');
      const fbClientsRaw = await fbClientsRes.json();
      if (!fbClientsRaw) throw new Error('لا توجد بيانات للعملاء.');
      let clientList = Array.isArray(fbClientsRaw) ? [...fbClientsRaw] : Object.values(fbClientsRaw);
      const clientIdx = clientList.findIndex(c => c && (c.id === client.id || client.username && c.username && c.username.toLowerCase() === client.username.toLowerCase() || client.phone && c.phone && c.phone === client.phone));
      if (clientIdx === -1) {
        throw new Error('العميل غير موجود في قاعدة البيانات السحابية.');
      }
      const cloudClient = clientList[clientIdx];
      const oldBalNum = parseFloat(cloudClient.currentBalance) || parseFloat(cloudClient.active_hours) || parseFloat(cloudClient.hours) || 0;
      const durVal = parseFloat(bookingForm.duration);
      if (oldBalNum <= 0) {
        throw new Error(`رصيد الساعات منتهٍ بالكامل. لا يمكن الحجز.`);
      }
      if (oldBalNum < durVal) {
        throw new Error(`رصيد الساعات (${oldBalNum}س) أقل من مدة الحجز المطلوبة (${durVal}س).`);
      }

      // 2) خصم الساعات من نفس المستند بالسحابة مباشرة
      const newBalNum = Math.max(0, oldBalNum - durVal);
      const newBalStr = newBalNum % 1 === 0 ? String(newBalNum) : String(newBalNum.toFixed(1));
      const nowIso = new Date().toISOString();
      const updatedClient = {
        ...cloudClient,
        currentBalance: newBalStr,
        active_hours: newBalStr,
        hours: newBalStr,
        balanceUpdatedAt: Date.now(),
        updatedAt: nowIso
      };
      clientList[clientIdx] = updatedClient;

      // Push updated clients array
      const updateClientRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/clients.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(clientList)
      });
      if (!updateClientRes.ok) throw new Error('فشل في تحديث الرصيد السحابي.');

      // Setup booking details
      // Setup booking details safely with reliable decimals
      const startDec = parseArabicTimeToDecimal(bookingForm.time);
      const safeH = Math.floor(startDec) % 24;
      const safeM = Math.round((startDec - Math.floor(startDec)) * 60);
      
      const endDec = startDec + Math.floor(durVal);
      const endH = Math.floor(endDec) % 24;
      const endM = safeM;
      
      let h = safeH;
      const m = safeM;
      const to12h = (hour, minute) => {
        const period = hour >= 12 ? 'م' : 'ص';
        const h12 = hour % 12 === 0 ? 12 : hour % 12;
        const minStr = String(minute).padStart(2, '0');
        const hStr = String(h12).padStart(2, '0');
        return `${hStr}:${minStr} ${period}`;
      };
      const start12h = to12h(safeH, safeM);
      const end12h = to12h(endH, endM);
      const timeRangeStr = `من ${start12h} إلى ${end12h}`;
      const durStr = String(Math.floor(durVal));
      const bookingId = `b-mob-${Date.now()}`;
      const targetRoom = bookingForm.room || settings.rooms && settings.rooms[0] || 'Master VIP Room';
      
      // Calculate 24h format time string for backend payload based on decimal variables
      const startDecStrFormat = parseArabicTimeToDecimal(bookingForm.time);
      const displayH = Math.floor(startDecStrFormat) % 24;
      const displayM = Math.round((startDecStrFormat - Math.floor(startDecStrFormat)) * 60);
      const time24h = String(displayH).padStart(2, '0') + ':' + String(displayM).padStart(2, '0');
      
      const fullBookingObj = {
        id: bookingId,
        clientId: updatedClient.id,
        clientName: updatedClient.name,
        clientPhone: updatedClient.phone,
        username: updatedClient.username,
        date: bookingForm.date,
        time: time24h,
        startTime: start12h,
        endTime: end12h,
        timeRange: timeRangeStr,
        duration: durStr,
        durationHours: durStr,
        serviceType: bookingForm.serviceType || 'حجز قاعة من تطبيق العميل',
        room: targetRoom,
        status: 'scheduled',
        bookedVia: 'mobile_app',
        isAutoDeducted: true,
        hoursDeducted: durStr,
        newBalanceAfterBooking: newBalStr,
        notes: bookingForm.notes || 'حجز آلي عبر التطبيق',
        createdAt: nowIso
      };

      // 3) إضافة كائن الحجز الجديد إلى مصفوفة/مجموعة الحجوزات السحابية
      await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${bookingId}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullBookingObj)
      });

      // (Optional) add attendance and notifications asynchronously without awaiting
      const attItem = {
        id: `att-mob-${Date.now()}`,
        clientId: updatedClient.id,
        clientName: updatedClient.name,
        clientPhone: updatedClient.phone,
        date: bookingForm.date,
        time: time24h,
        startTime: start12h,
        endTime: end12h,
        timeRange: timeRangeStr,
        hoursConsumed: durStr,
        oldBalance: String(oldBalNum),
        newBalance: newBalStr,
        serviceType: `حجز قاعة (${targetRoom})`,
        notes: `خصم فوري من التطبيق (${timeRangeStr}) - المدة: ${durStr}س`,
        source: 'mobile_app',
        createdAt: nowIso
      };
      fetch(`${FIREBASE_BASE_URL}/alkayan_db/attendance/${attItem.id}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(attItem)
      }).catch(() => {});
      const bookNotif = {
        id: `notif-book-${Date.now()}`,
        targetClientId: updatedClient.id,
        clientId: updatedClient.id,
        clientName: updatedClient.name,
        title: `✅ تم حجز القاعة (${targetRoom}) بنجاح`,
        message: `تم حجز القاعة (${targetRoom}) بتاريخ ${bookingForm.date} (${timeRangeStr}). تم خصم (${durStr}س) آلياً. الرصيد المتبقي: ${newBalStr}س.`,
        text: `تم حجز القاعة (${targetRoom}) بتاريخ ${bookingForm.date} (${timeRangeStr}). تم خصم (${durStr}س) آلياً. الرصيد المتبقي: ${newBalStr}س.`,
        type: 'booking',
        time: new Date().toLocaleTimeString('ar-SA', {
          hour: '2-digit',
          minute: '2-digit'
        }) + ' - ' + nowIso.split('T')[0],
        date: nowIso.split('T')[0],
        read: false,
        source: 'mobile_app',
        createdAt: nowIso
      };
      fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications/${bookNotif.id}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bookNotif)
      }).catch(() => {});
      const adminBookNotif = {
        ...bookNotif,
        id: `notif-admin-book-${Date.now()}`,
        targetClientId: 'admin_only',
        title: `✅ حجز من العميل (${updatedClient.name})`
      };
      fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications/${adminBookNotif.id}.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(adminBookNotif)
      }).catch(() => {});
      const bookingUpdateEntry = {
        action: 'book',
        bookingId: bookingId,
        room: targetRoom,
        date: bookingForm.date,
        clientId: updatedClient.id,
        booking: fullBookingObj,
        timestamp: Date.now()
      };
      fetch(`${FIREBASE_BASE_URL}/alkayan_db/latest_booking_update.json`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bookingUpdateEntry)
      }).catch(() => {});

      // 4) إرجاع حالة النجاح للواجهة فوراً دون انتظار أي رد محلي
      setClient(updatedClient);
      setMyBookings(prev => [fullBookingObj, ...prev.filter(b => b.id !== fullBookingObj.id)]);
      setAllBookings(prev => [fullBookingObj, ...prev.filter(b => b.id !== fullBookingObj.id)]);
      setMyAttendance(prev => [attItem, ...prev]);
      try {
        const sessionObj = {
          client: updatedClient,
          myBookings: [fullBookingObj, ...(myBookings || [])],
          myAttendance: [attItem, ...(myAttendance || [])],
          notifications: notifications || [],
          settings: settings || {},
          credentials: {
            username: updatedClient.username,
            password: updatedClient.password
          },
          savedAt: nowIso
        };
        localStorage.setItem('al_kayan_client_session', JSON.stringify(sessionObj));
      } catch (e) {}
      playNotificationSound('success');
      setBookingSuccessModal(fullBookingObj);
      triggerToast('تم الحجز وخصم الساعات بنجاح', `تم الحجز بقاعة ${targetRoom} وخصم ${durStr}س من رصيدك.`, 'success');
    } catch (err) {
      console.error(err);
      triggerToast('خطأ في الحجز', err.message || 'حدث خطأ أثناء الاتصال بالسحابة', 'error');
    } finally {
      setBookingSubmitting(false);
    }
  };
  const handleCancelBooking = bookingId => {
    const target = (myBookings || []).find(b => b.id === bookingId);
    if (target) {
      setCancelModalBooking(target);
    }
  };

  // Confirm Cancellation: Release Room Slot & Send Warning Notification
  const confirmCancelBooking = async () => {
    if (!cancelModalBooking) return;
    const bookingId = cancelModalBooking.id;
    const b = cancelModalBooking;
    const nowIso = new Date().toISOString();

    // ⚡ 0. ZERO-LATENCY INSTANT LOCAL RELEASE (<0.001s)
    // 0.1 Record in persistent localStorage (both per-client and global blacklist) so this booking can NEVER return as scheduled
    const cancelledKey = 'ALKAYAN_CANCELLED_BOOKINGS_' + (client?.id || client?.username || 'all');
    try {
      const cur = JSON.parse(localStorage.getItem(cancelledKey) || '[]');
      localStorage.setItem(cancelledKey, JSON.stringify(Array.from(new Set([...cur, bookingId]))));
    } catch (e) {}
    try {
      const curG = JSON.parse(localStorage.getItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL') || '[]');
      localStorage.setItem('ALKAYAN_CANCELLED_BOOKINGS_GLOBAL', JSON.stringify(Array.from(new Set([...curG, bookingId]))));
    } catch (e) {}

    // 0.2 Immediately update UI state & release room in zero milliseconds!
    setMyBookings(prev => (prev || []).map(item => item && item.id === bookingId ? {
      ...item,
      status: 'ملغي بواسطة العميل',
      is_active: false
    } : item));
    setAllBookings(prev => (prev || []).map(item => item && item.id === bookingId ? {
      ...item,
      status: 'ملغي بواسطة العميل',
      is_active: false
    } : item));

    // 0.3 Close modal and trigger sound/toast immediately
    setCancelModalBooking(null);
    playNotificationSound('warning');
    triggerToast('تم إلغاء الحجز وتحرير القاعة 🗑️', 'القاعة أصبحت فارغة ومتاحة فوراً. الساعات المخصومة غير مستردة.', 'warning');

    // ⚡ 1. CLOUD BROADCAST & SYNCHRONIZATION (Background Async)
    try {
      // 1.1 Direct Firebase Realtime Database update (vacates room for everyone)
      try {
        const fbRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings.json`, {
          cache: 'no-store'
        });
        if (fbRes.ok) {
          const rawBookings = await fbRes.json();
          if (Array.isArray(rawBookings)) {
            const updated = rawBookings.map(item => item && item.id === bookingId ? {
              ...item,
              status: 'ملغي بواسطة العميل',
              is_active: false
            } : item);
            await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings.json`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(updated)
            });
          } else if (rawBookings && typeof rawBookings === 'object') {
            for (const key of Object.keys(rawBookings)) {
              if (rawBookings[key] && rawBookings[key].id === bookingId) {
                await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${key}.json`, {
                  method: 'PATCH',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    status: 'ملغي بواسطة العميل',
                    is_active: false,
                    cancelled_at: new Date().toISOString()
                  })
                });
                break;
              }
            }
          }
        }

        // Also push status directly to bookingId key
        await fetch(`${FIREBASE_BASE_URL}/alkayan_db/bookings/${bookingId}.json`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            status: "ملغي بواسطة العميل",
            cancelled_at: new Date().toISOString(),
            is_active: false
          })
        });

        // Push cancellation warning notification to Firebase
        const cancelNotif = {
          id: `notif-cancel-${Date.now()}`,
          targetClientId: client.id,
          clientId: client.id,
          clientName: client.name,
          clientPhone: client.phone,
          clientUsername: client.username,
          title: `⚠️ تم إلغاء حجز قاعة (${b.room})`,
          message: `تم إلغاء حجزك بنجاح للقاعة (${b.room}) بتاريخ ${b.date} (${b.timeRange || b.time}). أصبحت القاعة محررة وفارغة ومتاحة للجميع. نلفت عنايتكم الكريمة إلى أن الساعات المخصومة لهذا الحجز (${b.duration || b.durationHours || '1'}س) لا يمكن استردادها مرة أخرى وفقاً لسياسة الحجز المعتمدة.`,
          text: `تم إلغاء حجزك بنجاح للقاعة (${b.room}) بتاريخ ${b.date} (${b.timeRange || b.time}). أصبحت القاعة محررة وفارغة ومتاحة للجميع. نلفت عنايتكم الكريمة إلى أن الساعات المخصومة لهذا الحجز (${b.duration || b.durationHours || '1'}س) لا يمكن استردادها مرة أخرى وفقاً لسياسة الحجز المعتمدة.`,
          type: 'warning',
          time: new Date().toLocaleTimeString('ar-SA', {
            hour: '2-digit',
            minute: '2-digit'
          }) + ' • ' + nowIso.split('T')[0],
          date: nowIso.split('T')[0],
          read: false,
          source: 'mobile_app_cancel',
          createdAt: nowIso
        };
        await fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications/${cancelNotif.id}.json`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(cancelNotif)
        });
        // Also push to notifications array so it appears in the client's notifications tab immediately
        try {
          const fbNRes = await fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications.json`, {
            cache: 'no-store'
          });
          let curN = [];
          if (fbNRes.ok) {
            const rawN = await fbNRes.json();
            if (Array.isArray(rawN)) curN = rawN;else if (rawN && typeof rawN === 'object') curN = Object.values(rawN);
          }
          await fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications.json`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify([cancelNotif, ...curN.filter(item => item && item.id !== cancelNotif.id)])
          });
        } catch (e) {}

        // Push Admin Cancellation Notification to Desktop App (via latest_admin_notification & notifications collection)
        try {
          const adminCancelNotif = {
            id: `notif-admin-cancel-${Date.now()}`,
            targetClientId: 'admin_only',
            clientId: client.id,
            clientName: client.name,
            clientPhone: client.phone,
            clientUsername: client.username,
            title: `⚠️ إلغاء حجز قاعة من الجوال (${client.name})`,
            message: `قام العميل "${client.name}" بإلغاء حجز قاعة (${b.room}) بتاريخ ${b.date} (${b.timeRange || b.time}).\nتم تحرير القاعة فورياً وإتاحتها للجميع. وفقاً للائحة الساعات، لا يتم استرداد الساعات المخصومة (${b.duration || b.durationHours || '1'}س).`,
            text: `قام العميل "${client.name}" بإلغاء حجز قاعة (${b.room}) بتاريخ ${b.date} (${b.timeRange || b.time}).\nتم تحرير القاعة فورياً وإتاحتها للجميع. وفقاً للائحة الساعات، لا يتم استرداد الساعات المخصومة (${b.duration || b.durationHours || '1'}س).`,
            type: 'warning',
            time: new Date().toLocaleTimeString('ar-SA', {
              hour: '2-digit',
              minute: '2-digit'
            }) + ' • ' + nowIso.split('T')[0],
            date: nowIso.split('T')[0],
            read: false,
            source: 'mobile_app_cancel',
            createdAt: nowIso
          };
          await fetch(`${FIREBASE_BASE_URL}/alkayan_db/notifications/${adminCancelNotif.id}.json`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(adminCancelNotif)
          });
          await fetch(`${FIREBASE_BASE_URL}/alkayan_db/latest_admin_notification.json`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(adminCancelNotif)
          });
        } catch (e) {}

        // Broadcast Instant Room Release Event (<0.02s Delivery to all devices)
        try {
          const bookingUpdateEntry = {
            action: 'cancel',
            status: 'ملغي بواسطة العميل',
            is_active: false,
            bookingId: bookingId,
            room: b.room,
            date: b.date,
            clientId: client.id,
            timestamp: Date.now()
          };
          await fetch(`${FIREBASE_BASE_URL}/alkayan_db/latest_booking_update.json`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(bookingUpdateEntry)
          });
        } catch (e) {}
      } catch (fbErr) {
        console.warn('Firebase cancel warning:', fbErr);
      }

      // 1.2 Secondary Local Server / Vercel API
      try {
        await fetch('/api/client/cancel', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            clientId: client.id,
            bookingId: bookingId
          })
        });
      } catch (apiErr) {}
      setTimeout(() => fetchClientData(), 1000);
    } catch (e) {
      console.warn('Background cancel sync note:', e);
    }
  };

  // Next Upcoming Booking
  const nextBooking = useMemo(() => {
    const upcomings = (myBookings || []).filter(b => b && getBookingDisplayCategory(b) === 'scheduled').sort((a, b) => (a.date + (a.time || a.startTime || '')).localeCompare(b.date + (b.time || b.startTime || '')));
    return upcomings.length > 0 ? upcomings[0] : null;
  }, [myBookings]);

  // ====================================================
  // 🔐 1. LOGIN SCREEN (إذا لم يكن العميل مسجل دخوله)
  // ====================================================
  if (!client) {
    return /*#__PURE__*/React.createElement("div", {
      className: "min-h-screen flex flex-col justify-between p-4 sm:p-6 max-w-md mx-auto"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pt-6 text-center space-y-2.5"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-16 h-16 sm:w-20 sm:h-20 mx-auto rounded-2xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 p-0.5 shadow-xl animate-pulse-gold flex items-center justify-center"
    }, /*#__PURE__*/React.createElement("img", {
      src: "app_icon.png",
      alt: "Al Kayan Logo",
      className: "w-full h-full object-cover rounded-[14px]",
      onError: e => {
        e.target.style.display = 'none';
      }
    })), /*#__PURE__*/React.createElement("h1", {
      className: "text-xl sm:text-2xl font-black text-white"
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
    className: "sticky top-0 z-40 bg-stone-950/95 backdrop-blur-2xl border-b border-amber-500/30 px-3 sm:px-4 py-3 shadow-2xl space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5 flex-1 min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative flex-shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 p-0.5 shadow-lg flex items-center justify-center overflow-hidden"
  }, settings.companyLogo || settings.logo ? /*#__PURE__*/React.createElement("img", {
    src: settings.companyLogo || settings.logo,
    alt: "Logo",
    className: "w-full h-full object-cover rounded-[14px]"
  }) : /*#__PURE__*/React.createElement("div", {
    className: "w-full h-full bg-stone-900 rounded-[14px] flex items-center justify-center text-amber-300 font-black text-sm"
  }, "\uD83C\uDFDB\uFE0F")), /*#__PURE__*/React.createElement("span", {
    className: "absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-stone-950 rounded-full shadow"
  })), /*#__PURE__*/React.createElement("div", {
    className: "min-w-0 flex-1"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "text-xs sm:text-sm font-black text-white truncate tracking-wide flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, settings.companyName || 'مجموعة الكيان | AL KAYAN GROUP')), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-300/85 font-bold truncate leading-tight mt-0.5"
  }, settings.companyTagline || settings.companyDescription || 'الكيان يبدأ من كيان له كيان'))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 flex-shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setActiveTab('notifications');
      setUnreadNotifCount(0);
    },
    className: "relative p-1.5 bg-stone-900/90 hover:bg-amber-950/80 border border-amber-500/25 rounded-xl text-amber-300 shadow active:scale-95 transition-all flex items-center justify-center",
    title: "\u0645\u0631\u0643\u0632 \u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0648\u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-sm"
  }, "\uD83D\uDD14"), unreadNotifCount > 0 && /*#__PURE__*/React.createElement("span", {
    className: "absolute -top-1.5 -right-1.5 min-w-[17px] h-4 px-1 bg-rose-500 text-white text-[8px] font-black rounded-full flex items-center justify-center border-2 border-stone-950 animate-bounce"
  }, unreadNotifCount > 9 ? '9+' : unreadNotifCount)), isSyncing && /*#__PURE__*/React.createElement("div", {
    className: "w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin",
    title: "\u062C\u0627\u0631\u064A \u0627\u0644\u062A\u0632\u0627\u0645\u0646 \u0627\u0644\u0644\u062D\u0638\u064A \u0628\u0627\u0644\u0633\u062D\u0627\u0628\u0629"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleLogout,
    className: "bg-stone-900/90 hover:bg-rose-950/80 text-stone-300 hover:text-rose-300 border border-amber-500/25 hover:border-rose-500/50 px-2.5 py-1.5 rounded-xl font-black text-[11px] shadow transition-all flex items-center gap-1 active:scale-95",
    title: "\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u062E\u0631\u0648\u062C \u0645\u0646 \u0627\u0644\u062D\u0633\u0627\u0628"
  }, /*#__PURE__*/React.createElement("span", null, "\u062E\u0631\u0648\u062C"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs"
  }, "\uD83D\uDEAA")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-gradient-to-r from-stone-900 via-amber-950/40 to-stone-900 border border-amber-500/30 rounded-2xl p-2 sm:p-2.5 flex items-center justify-between gap-2 shadow-inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-8 h-8 rounded-xl bg-gradient-to-br from-amber-500/30 to-amber-700/20 border border-amber-500/50 text-amber-300 flex items-center justify-center font-black text-xs shadow-sm flex-shrink-0"
  }, client.name ? client.name.charAt(0) : '👤'), /*#__PURE__*/React.createElement("div", {
    className: "min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black text-white truncate max-w-[120px] sm:max-w-[160px]"
  }, client.name), /*#__PURE__*/React.createElement("span", {
    className: "flex items-center gap-1 text-[8px] sm:text-[9px] bg-emerald-950/90 border border-emerald-500/40 text-emerald-300 px-1.5 py-0.5 rounded-full font-black whitespace-nowrap"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"
  }), /*#__PURE__*/React.createElement("span", null, "\u0627\u0644\u062A\u0637\u0628\u064A\u0642 \u064A\u0639\u0645\u0644 24/7"))), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-300/90 font-mono font-bold leading-none mt-0.5",
    dir: "ltr"
  }, client.phone))), /*#__PURE__*/React.createElement("div", {
    className: "flex-shrink-0 text-left"
  }, contractStatus.isFullTime ? /*#__PURE__*/React.createElement("div", {
    className: "bg-stone-950/90 border border-purple-500/40 rounded-xl px-2.5 py-1 text-center shadow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] text-purple-300 block font-bold leading-none"
  }, "\u0627\u0644\u0623\u064A\u0627\u0645 \u0627\u0644\u0645\u062A\u0628\u0642\u064A\u0629"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black text-amber-300 font-mono mt-0.5 block leading-none"
  }, contractStatus.daysLeft !== null && contractStatus.daysLeft >= 0 ? `${contractStatus.daysLeft} يوم` : 'منتهي')) : /*#__PURE__*/React.createElement("div", {
    className: "bg-stone-950/90 border border-amber-500/30 rounded-xl px-2.5 py-1 text-center shadow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] text-stone-400 block font-bold leading-none"
  }, "\u0631\u0635\u064A\u062F\u0643 \u0627\u0644\u0645\u062A\u0628\u0642\u064A"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black text-amber-400 font-mono mt-0.5 block leading-none"
  }, client.currentBalance, " ", /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] font-sans"
  }, "\u0633\u0627\u0639\u0629")))))), /*#__PURE__*/React.createElement("main", {
    className: "p-4 space-y-4 flex-1"
  }, activeTab === 'home' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, notifPermission !== 'granted' && /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-3.5 rounded-2xl border-2 border-amber-500/60 bg-gradient-to-r from-amber-950/70 via-stone-900 to-amber-950/70 flex items-center justify-between gap-2.5 shadow-xl animate-pulse"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "p-2 bg-amber-500/20 text-amber-300 rounded-xl text-xl border border-amber-500/40"
  }, "\uD83D\uDD14"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-black text-amber-300"
  }, "\u062A\u0641\u0639\u064A\u0644 \u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A \u0627\u0644\u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0647\u0627\u062A\u0641 \uD83D\uDCF1"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-stone-300 font-bold"
  }, "\u0644\u062A\u0635\u0644\u0643 \u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0641\u0648\u0631\u064A\u0627\u064B \u0628\u0635\u0648\u062A \u0648\u0631\u0646\u064A\u0646 \u062D\u062A\u0649 \u0623\u062B\u0646\u0627\u0621 \u0625\u063A\u0644\u0627\u0642 \u0627\u0644\u062A\u0637\u0628\u064A\u0642"))), /*#__PURE__*/React.createElement("button", {
    onClick: requestNotificationPermission,
    className: "gold-gradient-btn text-stone-950 font-black px-3.5 py-2 rounded-xl text-xs shadow-lg whitespace-nowrap active:scale-95 transition-all"
  }, "\u062A\u0641\u0639\u064A\u0644 \u0627\u0644\u0622\u0646 \u2726")), (() => {
    const isFT = contractStatus.isFullTime;
    const daysLeft = contractStatus.daysLeft;
    const curBal = parseFloat(client.currentBalance || 0);
    if (isFT && daysLeft !== null && daysLeft <= 7) {
      return /*#__PURE__*/React.createElement("div", {
        className: "p-4 sm:p-5 rounded-3xl border-2 border-rose-500 bg-gradient-to-r from-rose-950/95 via-stone-950 to-amber-950/90 shadow-2xl shadow-rose-950/60 space-y-3 ring-2 ring-rose-500/50"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-3"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-3xl p-2.5 bg-rose-500/20 rounded-2xl border border-rose-500/40 animate-pulse"
      }, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("div", {
        className: "flex-1 min-w-0"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] bg-rose-950 border border-rose-500/60 text-rose-300 px-2.5 py-0.5 rounded-full font-black"
      }, "\u062A\u0646\u0628\u064A\u0647 \u0639\u0627\u062C\u0644 \u0644\u062A\u062C\u062F\u064A\u062F \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643 \uD83D\uDEA8"), /*#__PURE__*/React.createElement("span", {
        className: "text-xs font-mono font-black text-amber-300"
      }, daysLeft <= 0 ? 'انتهت الصلاحية' : `متبقي ${daysLeft} أيام`)), /*#__PURE__*/React.createElement("h4", {
        className: "text-sm font-black text-white mt-1"
      }, daysLeft <= 0 ? 'انتهت فترة اشتراك الدوام الكامل!' : `متبقي ${daysLeft} أيام فقط على انتهاء اشتراكك!`))), /*#__PURE__*/React.createElement("p", {
        className: "text-xs text-stone-200 leading-relaxed font-bold bg-stone-900/80 p-3 rounded-2xl border border-rose-500/30"
      }, daysLeft <= 0 ? `انتهى اشتراك الدوام الكامل الخاص بك بتاريخ (${client.expiryDate}). يرجى تجديد الاشتراك فوراً لضمان استمرار حجز وتخصيص مكتبك الخاص (${client.dedicatedRoom || 'المكتب التنفيذي'}).` : `نود تذكيرك بأنه متبقي ${daysLeft} أيام فقط على انتهاء اشتراك الدوام الكامل بتاريخ (${client.expiryDate}). يرجى التواصل مع الإدارة لتأكيد التجديد والاستمرار في استخدام مكتبك الخاص دون انقطاع.`), /*#__PURE__*/React.createElement("div", {
        className: "pt-1"
      }, /*#__PURE__*/React.createElement("a", {
        href: `https://wa.me/${(settings.companyPhone || '+201500070655').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}) المشترك بنظام الدوام الكامل في (${client.dedicatedRoom || 'مكتبي'}). أود تأكيد تجديد اشتراكي حيث متبقي (${daysLeft}) أيام فقط على انتهائه.`)}`,
        target: "_blank",
        rel: "noopener noreferrer",
        className: "w-full bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 hover:from-emerald-500 hover:to-teal-500 text-white font-black py-3 px-4 rounded-2xl text-xs shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2 border border-emerald-400/40"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-base"
      }, "\uD83D\uDCAC"), /*#__PURE__*/React.createElement("span", null, "\u0627\u0644\u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0644\u062A\u062C\u062F\u064A\u062F \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643 \u0641\u0648\u0631\u0627\u064B \u0639\u0628\u0631 \u0648\u0627\u062A\u0633\u0627\u0628"))));
    }
    if (!isFT && curBal <= 5) {
      return /*#__PURE__*/React.createElement("div", {
        className: "p-4 sm:p-5 rounded-3xl border-2 border-amber-500 bg-gradient-to-r from-amber-950/95 via-stone-950 to-rose-950/90 shadow-2xl shadow-amber-950/60 space-y-3 ring-2 ring-amber-500/50"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-3"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-3xl p-2.5 bg-amber-500/20 rounded-2xl border border-amber-500/40 animate-pulse"
      }, "\u23F1\uFE0F"), /*#__PURE__*/React.createElement("div", {
        className: "flex-1 min-w-0"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] bg-amber-950 border border-amber-500/60 text-amber-300 px-2.5 py-0.5 rounded-full font-black"
      }, "\u062A\u0646\u0628\u064A\u0647 \u0631\u0635\u064A\u062F \u0627\u0644\u0633\u0627\u0639\u0627\u062A \u26A0\uFE0F"), /*#__PURE__*/React.createElement("span", {
        className: "text-xs font-mono font-black text-rose-300"
      }, curBal <= 0 ? 'الرصيد نفد' : `متبقي ${curBal} ساعة`)), /*#__PURE__*/React.createElement("h4", {
        className: "text-sm font-black text-white mt-1"
      }, curBal <= 0 ? 'نفد رصيد الساعات المخصص لك بالكامل!' : `تنبيه: متبقي لديك (${curBal} ساعة) فقط لتجديد الوقت!`))), /*#__PURE__*/React.createElement("p", {
        className: "text-xs text-stone-200 leading-relaxed font-bold bg-stone-900/80 p-3 rounded-2xl border border-amber-500/30"
      }, curBal <= 0 ? 'لقد استهلكت كامل ساعات باقتك. يرجى تجديد أو شحن الباقة الآن لتتمكن من حجز القاعات ومساحات العمل.' : `لقد وصل رصيدك لآخر 5 ساعات في باقتك المخصصة للحجز. يرجى شحن وتجديد الباقة الآن للاستمرار في حجز القاعات ومساحات العمل دون انقطاع.`), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: handleOpenInstaPay,
        className: "w-full bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-800 hover:from-purple-500 hover:to-indigo-500 text-white font-black py-3 px-3 rounded-2xl text-xs shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 border border-purple-300/40"
      }, /*#__PURE__*/React.createElement("span", null, "\u26A1 \u0634\u062D\u0646 \u0627\u0644\u0628\u0627\u0642\u0629 \u0641\u0648\u0631\u0627\u064B \u0639\u0628\u0631 InstaPay")), /*#__PURE__*/React.createElement("a", {
        href: `https://wa.me/${(settings.companyPhone || '+201500070655').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}). أود شحن وتجديد رصيد الساعات حيث متبقي في حسابي (${curBal}) ساعة فقط.`)}`,
        target: "_blank",
        rel: "noopener noreferrer",
        className: "w-full bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white font-black py-3 px-3 rounded-2xl text-xs shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 border border-emerald-400/40"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-base"
      }, "\uD83D\uDCAC"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0648\u0627\u0635\u0644 \u0639\u0628\u0631 \u0648\u0627\u062A\u0633\u0627\u0628"))));
    }
    return null;
  })(), /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-4 rounded-3xl border-2 border-amber-500/35 bg-gradient-to-br from-amber-950/50 via-stone-900 to-stone-950 relative overflow-hidden shadow-xl space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "absolute -left-6 -top-6 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl pointer-events-none"
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-2xl animate-bounce"
  }, "\uD83C\uDF1F"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-amber-300 font-bold block"
  }, new Date().getHours() < 12 ? 'صباح الخير والبركة ☀️' : 'مساء الخير والتميز 🌙'), /*#__PURE__*/React.createElement("h3", {
    className: "text-sm sm:text-base font-black text-white"
  }, "\u0623\u0647\u0644\u0627\u064B \u0628\u0643\u060C ", client.name, " \u0641\u064A ", settings.companyName || 'مجموعة الكيان', " \u2728")))), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-stone-300 leading-relaxed font-medium"
  }, "\u064A\u0633\u0639\u062F\u0646\u0627 \u062A\u0648\u0627\u062C\u062F\u0643 \u0645\u0639\u0646\u0627! \u0645\u0648\u0627\u0639\u064A\u062F \u0627\u0644\u0639\u0645\u0644 \u0627\u0644\u0631\u0633\u0645\u064A\u0629 12/6 (12 \u0633\u0627\u0639\u0629 \u064A\u0648\u0645\u064A\u0627\u064B \u0639\u062F\u0627 \u0627\u0644\u062C\u0645\u0639\u0629)\u060C \u064A\u0645\u0643\u0646\u0643 \u0625\u062F\u0627\u0631\u0629 \u062D\u062C\u0648\u0632\u0627\u062A\u0643 \u0648\u0645\u062A\u0627\u0628\u0639\u0629 \u0631\u0635\u064A\u062F\u0643 \u0628\u0643\u0644 \u0633\u0647\u0648\u0644\u0629 \u0648\u0633\u0631\u0639\u0629.")), sortedNotifications && sortedNotifications.length > 0 && /*#__PURE__*/React.createElement("div", {
    onClick: () => setActiveTab('notifications'),
    className: "glass-card p-3.5 rounded-2xl border border-amber-500/40 bg-gradient-to-r from-amber-950/30 via-stone-900 to-stone-950 cursor-pointer hover:border-amber-400 transition-all shadow-lg space-y-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "p-1.5 bg-amber-500/20 text-amber-300 rounded-xl text-sm border border-amber-500/30"
  }, "\uD83D\uDD14"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black text-white"
  }, sortedNotifications[0].title || 'إشعار من الإدارة'), !sortedNotifications[0].read && /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] font-black bg-amber-500 text-stone-950 px-1.5 py-0.5 rounded-full animate-pulse"
  }, "\u062C\u062F\u064A\u062F")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-amber-300 font-bold hover:underline"
  }, "\u0639\u0631\u0636 \u0627\u0644\u0643\u0644 (", sortedNotifications.length, ") \u2794")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-stone-300 line-clamp-2 leading-relaxed pr-8 font-medium"
  }, sortedNotifications[0].message || sortedNotifications[0].text || ''), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-[9px] text-stone-400 pr-8"
  }, /*#__PURE__*/React.createElement("span", null, sortedNotifications[0].time || sortedNotifications[0].date))), /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-3.5 rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-950/40 via-stone-900 to-amber-950/40 flex items-center justify-between gap-3 shadow-lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-2xl"
  }, "\uD83D\uDCF2"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-black text-white"
  }, "\u062A\u062B\u0628\u064A\u062A \u0627\u0644\u062A\u0637\u0628\u064A\u0642 \u0639\u0644\u0649 \u0647\u0627\u062A\u0641\u0643"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-200 mt-0.5"
  }, "\u0627\u0644\u062A\u0637\u0628\u064A\u0642 \u064A\u0639\u0645\u0644 \u0641\u0649 \u0627\u064A \u0648\u0642\u062A 24 \u0633\u0627\u0639\u0647 \u062E\u0644\u0627\u0644 \u062C\u0645\u064A\u0639 \u0627\u064A\u0627\u0645 \u0627\u0644\u0627\u0633\u0628\u0648\u0639"))), /*#__PURE__*/React.createElement("button", {
    onClick: handleInstallApp,
    className: "gold-gradient-btn text-stone-950 font-black text-[11px] px-3 py-1.5 rounded-xl whitespace-nowrap shadow active:scale-95 transition-all"
  }, "\u062A\u062B\u0628\u064A\u062A \u0627\u0644\u0622\u0646 \uD83D\uDCE5")), (() => {
    const finBal = typeof client.financialBalance === 'number' ? client.financialBalance : 0;
    const isDue = finBal < 0;
    const isPrepaid = finBal > 0;
    const latestTx = myFinancialTransactions && myFinancialTransactions.length > 0 ? myFinancialTransactions[0] : null;
    return /*#__PURE__*/React.createElement("div", {
      className: `glass-card p-5 rounded-3xl border-2 shadow-2xl space-y-3 transition-all ${isDue ? 'border-rose-500/60 bg-gradient-to-br from-rose-950/40 via-stone-950 to-stone-900 shadow-rose-950/30' : isPrepaid ? 'border-emerald-500/60 bg-gradient-to-br from-emerald-950/35 via-stone-950 to-stone-900 shadow-emerald-950/30' : 'border-amber-500/35 bg-gradient-to-br from-amber-950/30 via-stone-950 to-stone-900'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-start"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: `p-2.5 rounded-2xl text-xl border ${isDue ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : isPrepaid ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border-amber-500/40'}`
    }, "\u2615"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h4", {
      className: "text-sm font-black text-white flex items-center gap-1.5"
    }, /*#__PURE__*/React.createElement("span", null, "\u0645\u062D\u0641\u0638\u0629 \u0627\u0644\u062E\u062F\u0645\u0627\u062A \u0648\u0627\u0644\u0628\u0648\u0641\u064A\u0647 \u0648\u0627\u0644\u062A\u0635\u0648\u064A\u0631")), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-stone-400 block font-bold mt-0.5"
    }, "\u0637\u0644\u0628\u0627\u062A \u0627\u0644\u0645\u0634\u0631\u0648\u0628\u0627\u062A\u060C \u062A\u0635\u0648\u064A\u0631 \u0627\u0644\u0645\u0633\u062A\u0646\u062F\u0627\u062A\u060C \u0648\u0627\u0644\u0631\u0635\u064A\u062F \u0627\u0644\u0646\u0642\u062F\u064A"))), /*#__PURE__*/React.createElement("span", {
      className: `text-[10px] font-black px-2.5 py-1 rounded-xl border ${isDue ? 'bg-rose-950 text-rose-300 border-rose-500/50 animate-pulse' : isPrepaid ? 'bg-emerald-950 text-emerald-300 border-emerald-500/50' : 'bg-stone-900 text-stone-300 border-stone-700'}`
    }, isDue ? 'مبلغ مستحق ⚠️' : isPrepaid ? 'رصيد متاح 🟢' : 'متزن تماماً ✨')), /*#__PURE__*/React.createElement("div", {
      className: "p-3.5 rounded-2xl bg-stone-950/80 border border-white/5 flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-stone-400 font-bold block"
    }, isDue ? 'المبلغ المطلوب منك سداده:' : isPrepaid ? 'رصيدك المتاح حالياً:' : 'حالة الحساب المالي:'), /*#__PURE__*/React.createElement("div", {
      className: `text-2xl font-black font-mono tracking-tight mt-0.5 ${isDue ? 'text-rose-400' : isPrepaid ? 'text-emerald-400' : 'text-stone-300'}`
    }, isDue ? `${Math.abs(finBal).toLocaleString()} ج.م` : isPrepaid ? `${finBal.toLocaleString()} ج.م` : '0 ج.م')), latestTx && /*#__PURE__*/React.createElement("div", {
      className: "text-left text-[10px] text-stone-400 max-w-[150px] truncate"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-amber-300 font-bold block truncate"
    }, "\u0622\u062E\u0631 \u0637\u0644\u0628: ", latestTx.categoryName), /*#__PURE__*/React.createElement("span", {
      className: "font-mono block"
    }, latestTx.date, " (", latestTx.amount, " \u062C.\u0645)"))), /*#__PURE__*/React.createElement("div", {
      className: "space-y-2 pt-1"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: handleOpenInstaPay,
      className: "w-full group relative overflow-hidden p-3.5 rounded-2xl bg-gradient-to-r from-[#6A0E40] via-[#8E1758] to-[#B81B73] hover:from-[#7E124D] hover:via-[#A31A66] hover:to-[#CD1F81] border border-pink-400/50 shadow-xl shadow-pink-950/40 text-white transition-all duration-200 active:scale-[0.98] flex items-center justify-between"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-10 h-10 rounded-xl bg-white p-1 flex items-center justify-center shadow-md flex-shrink-0"
    }, /*#__PURE__*/React.createElement(InstaPayLogo, {
      className: "w-8 h-8"
    })), /*#__PURE__*/React.createElement("div", {
      className: "text-right"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5 flex-wrap"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-xs sm:text-sm font-black tracking-wide text-white"
    }, "\u0627\u0644\u062F\u0641\u0639 \u0627\u0644\u0641\u0648\u0631\u064A \u0639\u0628\u0631 InstaPay"), /*#__PURE__*/React.createElement("span", {
      className: "bg-amber-400 text-stone-950 text-[9px] font-black px-2 py-0.5 rounded-full shadow-sm"
    }, "\u0644\u062D\u0638\u064A \u26A1")), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-pink-200 block font-bold mt-0.5"
    }, "\u0633\u062F\u0627\u062F \u0627\u0644\u062D\u0633\u0627\u0628 \u0648\u0627\u0644\u062E\u062F\u0645\u0627\u062A \u0644\u062D\u0633\u0627\u0628 \u0627\u0644\u0643\u064A\u0627\u0646 (x.lance@instapay)"))), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1 text-pink-100 font-mono text-xs font-black bg-black/30 px-3 py-2 rounded-xl border border-white/15 flex-shrink-0 group-hover:bg-black/40 transition-colors"
    }, /*#__PURE__*/React.createElement("span", null, "\u0627\u062F\u0641\u0639 \u0627\u0644\u0622\u0646"), /*#__PURE__*/React.createElement("span", {
      className: "text-sm"
    }, "\u2190"))), /*#__PURE__*/React.createElement("div", {
      className: "flex items-start gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[10.5px] text-amber-200 font-bold leading-relaxed"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-base flex-shrink-0 mt-0.5"
    }, "\uD83D\uDCF8"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("b", {
      className: "text-amber-300 underline underline-offset-2"
    }, "\u062A\u0646\u0628\u064A\u0647 \u0625\u0644\u0632\u0627\u0645\u064A:"), " \u0628\u0639\u062F \u0625\u062A\u0645\u0627\u0645 \u0627\u0644\u062A\u062D\u0648\u064A\u0644 \u0639\u0628\u0631 InstaPay\u060C \u064A\u0631\u062C\u0649 \u0625\u0631\u0633\u0627\u0644 ", /*#__PURE__*/React.createElement("b", null, "\u0627\u0633\u0643\u0631\u064A\u0646 \u0634\u0648\u062A (Screenshot)"), " \u0644\u0639\u0645\u0644\u064A\u0629 \u0627\u0644\u062F\u0641\u0639 \u0625\u0644\u0649 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0639\u0628\u0631 \u0627\u0644\u0648\u0627\u062A\u0633\u0627\u0628 \u0644\u062A\u0633\u062F\u064A\u062F \u0648\u0642\u064A\u062F \u0627\u0644\u0645\u0628\u0644\u063A \u0641\u064A \u0645\u062D\u0641\u0638\u062A\u0643 \u0641\u0648\u0631\u0627\u064B."))), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 gap-2 pt-1"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setShowLedgerModal(true),
      className: "py-2.5 px-3 rounded-2xl bg-stone-900 hover:bg-stone-800 border border-amber-500/30 text-amber-200 text-xs font-black shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCDC"), /*#__PURE__*/React.createElement("span", null, "\u0643\u0634\u0641 \u0627\u0644\u062D\u0633\u0627\u0628 \u0627\u0644\u062A\u0641\u0635\u064A\u0644\u064A")), /*#__PURE__*/React.createElement("a", {
      href: `https://wa.me/${(settings.companyPhone || '966500000000').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}). أود الاستفسار بخصوص حساب الخدمات والبوفيه (الرصيد الحالي: ${finBal} ج.م).`)}`,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "py-2.5 px-3 rounded-2xl bg-emerald-950 hover:bg-emerald-900 border border-emerald-500/40 text-emerald-300 text-xs font-black shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCAC"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0648\u0627\u0635\u0644 \u0628\u062E\u0635\u0648\u0635 \u0627\u0644\u062D\u0633\u0627\u0628"))));
  })(), /*#__PURE__*/React.createElement("div", {
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
  }, contractStatus.daysLeft < 0 ? `منتهي منذ ${Math.abs(contractStatus.daysLeft)} يوم` : `${contractStatus.daysLeft} يوم متبقي`))), contractStatus.isFullTime ?
  /*#__PURE__*/
  /* 🏢 VIP Dedicated Room & Contract Renewal Cards for Full-Time Clients */
  React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-5 rounded-3xl border-2 border-amber-500/50 shadow-2xl bg-gradient-to-br from-amber-950/40 via-stone-950 to-stone-900 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black text-amber-300 flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-base"
  }, "\uD83C\uDFE2"), /*#__PURE__*/React.createElement("span", null, "\u0627\u0644\u063A\u0631\u0641\u0629 / \u0627\u0644\u0645\u0643\u062A\u0628 \u0627\u0644\u0645\u062E\u0635\u0635 \u0644\u0643:")), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-lg font-bold"
  }, "\u0645\u062E\u0635\u0635 \u0644\u0643 \u0637\u0648\u0627\u0644 \u0623\u0648\u0642\u0627\u062A \u0627\u0644\u0639\u0645\u0644 12/6 \uD83D\uDEE1\uFE0F")), /*#__PURE__*/React.createElement("div", {
    className: "text-center py-3 px-3 bg-stone-900/80 rounded-2xl border border-amber-500/30"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-2xl sm:text-3xl font-black text-white drop-shadow-md flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-amber-400"
  }, "\uD83D\uDEAA"), /*#__PURE__*/React.createElement("span", null, client.dedicatedRoom || client.room || client.roomName || 'المكتب التنفيذي المستقل')), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-amber-200/90 mt-2 font-bold"
  }, client.subscriptionType === 'shift' ? `مساحتك الخاصة والمستقلة جاهزة ومتاحة لك من الساعة ${client.shiftStartTime || '-'} إلى الساعة ${client.shiftEndTime || '-'}` : 'مساحتك الخاصة والمستقلة جاهزة ومتاحة لك دائماً طوال فترة التعاقد')), /*#__PURE__*/React.createElement("div", {
    className: "p-2.5 rounded-xl bg-stone-900/60 border border-amber-500/20 text-[11px] text-stone-300 text-center leading-relaxed font-bold"
  }, client.subscriptionType === 'shift' ? '✨ نظام شيفت معتمد على فترة محددة وغرفة خاصة دون الحاجة لجدولة مواعيد.' : '✨ نظام دوام كامل معتمد على فترة محددة وغرفة خاصة دون الحاجة لجدولة مواعيد.')), /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-5 rounded-3xl border-2 border-purple-500/50 shadow-xl bg-gradient-to-br from-purple-950/40 via-stone-950 to-indigo-950/30 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black text-purple-300 flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-base"
  }, "\uD83D\uDCC5"), /*#__PURE__*/React.createElement("span", null, "\u0645\u0648\u0639\u062F \u062A\u062C\u062F\u064A\u062F \u0627\u0644\u0628\u0627\u0642\u0629 \u0627\u0644\u0642\u0627\u062F\u0645:")), /*#__PURE__*/React.createElement("span", {
    className: `text-[10px] font-black px-2 py-0.5 rounded-lg border ${contractStatus.isExpired ? 'bg-rose-950 text-rose-300 border-rose-500/40' : 'bg-purple-900 text-purple-200 border-purple-400/30'}`
  }, contractStatus.isExpired ? 'انتهت الفترة ⛔' : client.subscriptionType === 'shift' ? 'الشيفت ساري 🔄' : 'اشتراك ساري 👑')), /*#__PURE__*/React.createElement("div", {
    className: "text-center py-4 bg-purple-950/40 rounded-2xl border border-purple-500/30"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-purple-300 font-bold block mb-1"
  }, "\uD83D\uDCC5 \u0627\u0644\u0623\u064A\u0627\u0645 \u0627\u0644\u0645\u062A\u0628\u0642\u064A\u0629 \u0641\u064A \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643:"), /*#__PURE__*/React.createElement("div", {
    className: "text-5xl font-black text-amber-300 font-mono tracking-tight drop-shadow-md"
  }, contractStatus.daysLeft !== null && contractStatus.daysLeft >= 0 ? contractStatus.daysLeft : 0, /*#__PURE__*/React.createElement("span", {
    className: "text-xl text-amber-200 mr-2"
  }, "\u064A\u0648\u0645")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-stone-300 mt-2 font-bold"
  }, contractStatus.daysLeft !== null ? contractStatus.daysLeft < 0 ? /*#__PURE__*/React.createElement("span", {
    className: "text-rose-400 font-black"
  }, "\u0627\u0646\u062A\u0647\u0649 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643 \u0645\u0646\u0630 ", Math.abs(contractStatus.daysLeft), " \u064A\u0648\u0645 - \u064A\u0631\u062C\u0649 \u0627\u0644\u062A\u062C\u062F\u064A\u062F") : contractStatus.daysLeft <= 7 ? /*#__PURE__*/React.createElement("span", {
    className: "text-rose-400 font-black animate-pulse"
  }, "\u26A0\uFE0F \u0623\u0646\u062A \u0627\u0644\u0622\u0646 \u0641\u064A \u0627\u0644\u0623\u0633\u0628\u0648\u0639 \u0627\u0644\u0623\u062E\u064A\u0631 \u0645\u0646 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643 (\u064A\u0646\u062A\u0647\u064A \u0641\u064A ", client.expiryDate, ")") : /*#__PURE__*/React.createElement("span", {
    className: "text-emerald-400 font-black"
  }, "\u0645\u062A\u0628\u0642\u064A ", contractStatus.daysLeft, " \u064A\u0648\u0645 \u062D\u062A\u0649 \u0645\u0648\u0639\u062F \u0627\u0644\u062A\u062C\u062F\u064A\u062F \u0627\u0644\u0642\u0627\u062F\u0645 (", client.expiryDate, ")") : 'ساري وفقاً لتواريخ التعاقد')), /*#__PURE__*/React.createElement("div", {
    className: "mt-3 p-3.5 rounded-2xl bg-stone-950/80 border border-purple-500/20 text-xs space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-stone-300"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] text-purple-300 font-bold"
  }, "\uD83C\uDFE2 \u0627\u0644\u0645\u0643\u062A\u0628 \u0627\u0644\u0645\u062E\u0635\u0635 \u0644\u0643:"), /*#__PURE__*/React.createElement("span", {
    className: "font-bold text-white text-[11px]"
  }, client.dedicatedRoom || client.room || 'المكتب التنفيذي الخاص')), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-stone-300"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] text-stone-400 font-bold"
  }, "\uD83D\uDCC5 \u0641\u062A\u0631\u0629 \u0627\u0644\u062A\u0639\u0627\u0642\u062F \u0627\u0644\u0631\u0633\u0645\u064A\u0629:"), /*#__PURE__*/React.createElement("span", {
    className: "font-mono font-bold text-amber-300 text-[11px]"
  }, client.startDate || '-', " \u2794 ", client.expiryDate || 'مستمر')), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-emerald-400 text-[10px] border-t border-purple-500/20 pt-2 font-bold"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDEE1\uFE0F \u0646\u0638\u0627\u0645 \u0627\u0644\u062D\u0633\u0627\u0628 \u0648\u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643:"), /*#__PURE__*/React.createElement("span", null, client.subscriptionType === 'shift' ? `نظام الشيفت (${client.shiftType === 'evening' ? 'مسائي 🌙' : 'صباحي ☀️'}) • استلام ${client.shiftStartTime || '-'} ➔ تسليم ${client.shiftEndTime || '-'} (دون احتساب ساعات)` : 'معتمد بالأيام والتاريخ فقط • مساحة مخصصة طوال ساعات العمل الرسمية دون احتساب ساعات')))), /*#__PURE__*/React.createElement("a", {
    href: `https://wa.me/${(settings.companyPhone || '966500000000').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}) المشترك بنظام ${client.subscriptionType === 'shift' ? 'الشيفت' : 'الدوام الكامل'} في (${client.dedicatedRoom || 'مكتبي'}). أود التواصل بشأن الاشتراك وتجديد الباقة.`)}`,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "w-full bg-gradient-to-r from-emerald-600 via-emerald-700 to-teal-800 text-white font-black py-4 rounded-3xl text-xs shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2 border border-emerald-400/40"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-base"
  }, "\uD83D\uDCAC"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0644\u062A\u062C\u062F\u064A\u062F \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643 \u0623\u0648 \u0623\u064A \u0627\u0633\u062A\u0641\u0633\u0627\u0631"))) :
  /*#__PURE__*/
  /* ⏱️ Hourly Package Cards (Balance + Quick Booking + Next Booking) */
  React.createElement(React.Fragment, null, (() => {
    const currentBalNum = client.currentBalance !== undefined && client.currentBalance !== null && !isNaN(parseFloat(client.currentBalance)) ? parseFloat(client.currentBalance) : client.initialHours !== undefined ? parseFloat(client.initialHours) : 0;
    const totalHrsNum = parseFloat(client.initialHours || client.totalHours || client.hours || currentBalNum);
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
  })(), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('book'),
    className: "w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-3xl text-sm shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\u2795"), /*#__PURE__*/React.createElement("span", null, "\u062D\u062C\u0632 \u0642\u0627\u0639\u0629 \u062C\u062F\u064A\u062F\u0629 \u0627\u0644\u0622\u0646 (\u0627\u0628\u062A\u062F\u0627\u0621\u064B \u0645\u0646 \u063A\u062F\u0627\u064B) \uD83D\uDCC5")), nextBooking && /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-4 rounded-3xl border border-amber-500/30 space-y-2.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-amber-300 flex items-center gap-1"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCC5 \u062D\u062C\u0632\u0643 \u0627\u0644\u0642\u0627\u062F\u0645:")), /*#__PURE__*/React.createElement("span", {
    className: "bg-emerald-950 text-emerald-300 border border-emerald-500/40 text-[10px] font-black px-2 py-0.5 rounded-lg"
  }, "\u0645\u0624\u0643\u062F \u0642\u0627\u062F\u0645 \uD83D\uDFE2")), /*#__PURE__*/React.createElement("div", {
    className: "p-3 bg-stone-900/90 rounded-2xl border border-amber-500/20 text-xs flex justify-between items-center gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "min-w-0"
  }, /*#__PURE__*/React.createElement("h4", {
    className: "font-black text-white truncate"
  }, nextBooking.room), /*#__PURE__*/React.createElement("p", {
    className: "text-stone-300 font-mono text-[11px] mt-0.5 font-bold"
  }, "\uD83D\uDCC5 ", nextBooking.date, " \u2022 \u23F0 ", nextBooking.time, " (", nextBooking.duration, "\u0633)")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 flex-shrink-0"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleCancelBooking(nextBooking.id),
    className: "bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-[10px] font-black px-2.5 py-1.5 rounded-xl shadow active:scale-95 transition-all flex items-center gap-1",
    title: "\u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u062C\u0632 \u0648\u062A\u062D\u0631\u064A\u0631 \u0627\u0644\u0642\u0627\u0639\u0629"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDDD1\uFE0F"), /*#__PURE__*/React.createElement("span", null, "\u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u062C\u0632")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('mybookings'),
    className: "text-[11px] text-amber-300 font-bold hover:underline px-1 py-1"
  }, "\u0627\u0644\u062A\u0641\u0627\u0635\u064A\u0644 \u2190"))))), notifications.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "glass-card p-4 rounded-3xl border-2 border-amber-500/40 bg-gradient-to-br from-stone-950/90 via-amber-950/20 to-stone-950/90 space-y-3 shadow-xl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-white flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-2 h-2 rounded-full bg-amber-400 animate-ping"
  }), /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD14 \u0645\u0631\u0643\u0632 \u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A \u0648\u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A:")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setActiveTab('notifications');
      setUnreadNotifCount(0);
    },
    className: "text-[10px] text-amber-300 font-black hover:underline flex items-center gap-0.5"
  }, /*#__PURE__*/React.createElement("span", null, "\u0639\u0631\u0636 \u0627\u0644\u0643\u0644 (", notifications.length, ")"), /*#__PURE__*/React.createElement("span", null, "\u2190"))), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2"
  }, notifications.slice(0, 3).map((n, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    onClick: () => {
      setActiveTab('notifications');
      setUnreadNotifCount(0);
    },
    className: "p-3 bg-stone-900/90 border border-amber-500/20 hover:border-amber-400/50 rounded-2xl text-xs space-y-1 shadow transition-all cursor-pointer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 font-black text-amber-300"
  }, /*#__PURE__*/React.createElement("span", null, n.type === 'alert' || n.type === 'warning' ? '⚠️' : n.type === 'package' ? '💳' : n.type === 'booking' ? '📅' : 'ℹ️'), /*#__PURE__*/React.createElement("span", {
    className: "text-xs"
  }, n.title || 'إشعار من الإدارة')), /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] text-stone-400 font-mono"
  }, n.time || '')), /*#__PURE__*/React.createElement("p", {
    className: "text-stone-200 text-[11px] font-bold leading-snug whitespace-pre-line"
  }, n.text || n.message)))))), activeTab === 'book' && /*#__PURE__*/React.createElement("div", {
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
    className: "p-3.5 bg-stone-900/90 border border-amber-500/25 rounded-2xl space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-amber-300 flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCCA \u062D\u0627\u0644\u0629 (", bookingForm.room, ") \u0644\u064A\u0648\u0645 (", bookingForm.date, "):")), dayOccupiedSlots.length === 0 ? /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-lg font-bold"
  }, "\u0645\u062A\u0627\u062D\u0629 \u0628\u0627\u0644\u0643\u0627\u0645\u0644 \uD83D\uDFE2") : /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] bg-amber-950 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-lg font-bold"
  }, dayOccupiedSlots.length, " \u062D\u062C\u0632 \u0645\u0633\u062C\u0644 \u26A0\uFE0F")), dayOccupiedSlots.length > 0 ? /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5 pt-1"
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-stone-400 font-bold"
  }, "\u0627\u0644\u0623\u0648\u0642\u0627\u062A \u0627\u0644\u0645\u0634\u063A\u0648\u0644\u0629 \u0628\u0627\u0644\u0642\u0627\u0639\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u064A\u0648\u0645 (\u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629):"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, dayOccupiedSlots.map(s => {
    const sStart = parseArabicTimeToDecimal(s.time || s.startTime);
    const sDur = parseFloat(s.duration || s.durationHours || 1);
    const sEnd = sStart + sDur;
    const range = s.timeRange || `من ${decimalToTimeStr(sStart)} إلى ${decimalToTimeStr(sEnd)}`;
    return /*#__PURE__*/React.createElement("span", {
      key: s.id,
      className: "text-[10px] bg-rose-950/80 border border-rose-500/40 text-rose-300 px-2.5 py-1 rounded-xl font-mono font-bold flex items-center gap-1"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD12"), /*#__PURE__*/React.createElement("span", null, range, " (", sDur, "\u0633)"));
  }))) : /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-emerald-300 font-bold"
  }, "\u0643\u0627\u0641\u0629 \u0627\u0644\u0623\u0648\u0642\u0627\u062A \u0645\u062A\u0627\u062D\u0629 \u0644\u0644\u062D\u062C\u0632 \u0641\u064A \u0647\u0630\u0647 \u0627\u0644\u0642\u0627\u0639\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u064A\u0648\u0645 \u062F\u0648\u0646 \u0623\u064A \u062A\u0639\u0627\u0631\u0636.")), /*#__PURE__*/React.createElement("div", {
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
  }, ['10:00 ص', '11:00 ص', '12:00 م', '01:00 م', '02:00 م', '03:00 م', '04:00 م', '05:00 م', '06:00 م', '07:00 م', '08:00 م', '09:00 م', '10:00 م'].map((t, idx) => /*#__PURE__*/React.createElement("option", {
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
  }, "8 \u0633\u0627\u0639\u0627\u062A (\u064A\u0648\u0645 \u0643\u0627\u0645\u0644)")))), workingHoursCheck.isOutside && /*#__PURE__*/React.createElement("div", {
    className: "p-3.5 bg-rose-950/90 border-2 border-rose-500/80 rounded-2xl text-rose-200 text-xs space-y-1.5 font-bold shadow-lg animate-pulse"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 font-black text-rose-300 text-sm"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-base"
  }, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0646\u0628\u064A\u0647: \u0627\u0644\u062A\u0648\u0642\u064A\u062A \u062E\u0627\u0631\u062C \u0645\u0648\u0627\u0639\u064A\u062F \u0627\u0644\u0639\u0645\u0644 \u0627\u0644\u0623\u0633\u0627\u0633\u064A\u0629!")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] leading-relaxed text-stone-200"
  }, "\u0645\u0648\u0627\u0639\u064A\u062F \u0627\u0644\u0639\u0645\u0644 \u0648\u0627\u0644\u062D\u062C\u0648\u0632\u0627\u062A \u0627\u0644\u0631\u0633\u0645\u064A\u0629 \u0641\u064A \u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646 \u062A\u0628\u062F\u0623 \u0645\u0646 \u0627\u0644\u0633\u0627\u0639\u0629 ", /*#__PURE__*/React.createElement("b", {
    className: "text-amber-300"
  }, "10:00 \u0635\u0628\u0627\u062D\u0627\u064B"), " \u0648\u062D\u062A\u0649 \u0627\u0644\u0633\u0627\u0639\u0629 ", /*#__PURE__*/React.createElement("b", {
    className: "text-amber-300"
  }, "10:00 \u0645\u0633\u0627\u0621\u064B"), " \u0641\u0642\u0637."), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] leading-relaxed text-amber-300 font-mono font-bold"
  }, "\u0627\u0644\u062D\u062C\u0632 \u0627\u0644\u0645\u062D\u062F\u062F \u064A\u0646\u062A\u0647\u064A \u0641\u064A \u0627\u0644\u0633\u0627\u0639\u0629 (", workingHoursCheck.endTimeFormatted, ") \u0648\u0647\u0648 \u062E\u0627\u0631\u062C \u0645\u0648\u0627\u0639\u064A\u062F \u0627\u0644\u0639\u0645\u0644. \u064A\u0631\u062C\u0649 \u0627\u062E\u062A\u064A\u0627\u0631 \u0648\u0642\u062A \u064A\u0646\u062A\u0647\u064A \u0642\u0628\u0644 \u0627\u0644\u0633\u0627\u0639\u0629 10:00 \u0645\u0633\u0627\u0621\u064B.")), conflictCheck.hasConflict ? /*#__PURE__*/React.createElement("div", {
    className: "p-3.5 bg-rose-950/90 border-2 border-rose-500/80 rounded-2xl text-rose-200 text-xs space-y-1.5 font-bold shadow-lg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 font-black text-rose-300 text-sm"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-base"
  }, "\u26D4"), /*#__PURE__*/React.createElement("span", null, "\u0627\u0644\u0642\u0627\u0639\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u062A\u0648\u0642\u064A\u062A!")), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] leading-relaxed text-stone-200"
  }, "\u0627\u0644\u0642\u0627\u0639\u0629 \u0645\u062D\u062C\u0648\u0632\u0629 \u0645\u0633\u0628\u0642\u0627\u064B \u0641\u064A \u0627\u0644\u0641\u062A\u0631\u0629 (", /*#__PURE__*/React.createElement("span", {
    className: "text-amber-300 font-mono font-black"
  }, conflictCheck.conflictTime), "). \u064A\u0631\u062C\u0649 \u0627\u062E\u062A\u064A\u0627\u0631 \u062A\u0648\u0642\u064A\u062A \u0622\u062E\u0631 \u0645\u062A\u0627\u062D \u0623\u0648 \u0642\u0627\u0639\u0629 \u0628\u062F\u064A\u0644\u0629.")) : !workingHoursCheck.isOutside && /*#__PURE__*/React.createElement("div", {
    className: "p-3 bg-emerald-950/60 border border-emerald-500/40 rounded-2xl text-emerald-300 text-xs flex items-center gap-2 font-bold"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDFE2"), /*#__PURE__*/React.createElement("span", null, "\u0627\u0644\u0642\u0627\u0639\u0629 \u0645\u062A\u0627\u062D\u0629 \u0648\u0636\u0645\u0646 \u0645\u0648\u0627\u0639\u064A\u062F \u0627\u0644\u0639\u0645\u0644 \u0627\u0644\u0631\u0633\u0645\u064A\u0629!")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "block text-xs font-black text-stone-300 mb-1"
  }, "\u0645\u0644\u0627\u062D\u0638\u0627\u062A / \u0637\u0628\u064A\u0639\u0629 \u0627\u0644\u0646\u0634\u0627\u0637 (\u0627\u062E\u062A\u064A\u0627\u0631\u064A):"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: bookingForm.notes,
    onChange: e => setBookingForm(b => ({
      ...b,
      notes: e.target.value
    })),
    placeholder: "\u0645\u062B\u0627\u0644: \u0627\u062C\u062A\u0645\u0627\u0639 \u0639\u0645\u0644\u060C \u0648\u0631\u0634\u0629 \u062A\u062F\u0631\u064A\u0628\u064A\u0629...",
    className: "w-full bg-stone-900 border border-amber-500/30 text-white rounded-2xl p-3 text-xs focus:ring-2 focus:ring-amber-400 focus:outline-none"
  })), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    disabled: bookingSubmitting || workingHoursCheck.isOutside || conflictCheck.hasConflict || contractStatus.isExpired,
    className: `w-full py-4 rounded-2xl text-sm font-black shadow-xl transition-all flex items-center justify-center gap-2 ${workingHoursCheck.isOutside || conflictCheck.hasConflict || contractStatus.isExpired ? 'bg-stone-800 text-stone-500 cursor-not-allowed border border-stone-700' : 'gold-gradient-btn text-stone-950 active:scale-95'}`
  }, bookingSubmitting ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "w-4 h-4 border-2 border-stone-950 border-t-transparent rounded-full animate-spin"
  }), /*#__PURE__*/React.createElement("span", null, "\u062C\u0627\u0631\u064A \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062D\u062C\u0632 \u0648\u062E\u0635\u0645 \u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0628\u0627\u0644\u0633\u062D\u0627\u0628\u0629...")) : workingHoursCheck.isOutside ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\u26D4 \u062E\u0627\u0631\u062C \u0645\u0648\u0627\u0639\u064A\u062F \u0627\u0644\u0639\u0645\u0644 \u0627\u0644\u0631\u0633\u0645\u064A\u0629 (10:00 \u0635 - 10:00 \u0645)")) : conflictCheck.hasConflict ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\u26D4 \u0627\u0644\u0642\u0627\u0639\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u062A\u0648\u0642\u064A\u062A")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\u26A1 \u062A\u0623\u0643\u064A\u062F \u0648\u062D\u0641\u0638 \u062D\u062C\u0632 \u0627\u0644\u0642\u0627\u0639\u0629 \u0641\u0648\u0631\u064A\u0627\u064B")))))), activeTab === 'mybookings' && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white"
  }, "\u062C\u062F\u0648\u0644 \u062D\u062C\u0648\u0632\u0627\u062A\u064A \uD83D\uDCC5"), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-300 font-bold mt-0.5"
  }, "\u0645\u062A\u0627\u0628\u0639\u0629 \u0627\u0644\u062D\u062C\u0648\u0632\u0627\u062A \u0627\u0644\u0642\u0627\u062F\u0645\u0629 \u0648\u0627\u0644\u0645\u0643\u062A\u0645\u0644\u0629 \u0648\u0627\u0644\u0645\u0644\u063A\u0627\u0629")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('book'),
    className: "gold-gradient-btn text-stone-950 text-xs font-black px-3.5 py-2 rounded-xl flex items-center gap-1 shadow active:scale-95 transition-all"
  }, /*#__PURE__*/React.createElement("span", null, "\u2795 \u062D\u062C\u0632 \u062C\u062F\u064A\u062F"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-1.5"
  }, [{
    id: 'all',
    label: 'كافة المواعيد',
    count: myBookingsStats.total
  }, {
    id: 'scheduled',
    label: 'المواعيد القادمة ⏳',
    count: myBookingsStats.scheduled
  }, {
    id: 'attended',
    label: 'المكتملة ✅',
    count: myBookingsStats.attended
  }, {
    id: 'cancelled',
    label: 'الملغاة ❌',
    count: myBookingsStats.cancelled
  }].map(f => /*#__PURE__*/React.createElement("button", {
    key: f.id,
    onClick: () => setBookingFilter(f.id),
    className: `p-2.5 rounded-2xl text-xs font-bold transition-all text-center flex flex-col items-center justify-center gap-0.5 ${bookingFilter === f.id ? 'bg-amber-500/20 text-amber-300 border-2 border-amber-500/60 font-black shadow-md' : 'bg-stone-900/90 text-stone-400 hover:text-white border border-amber-500/15'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[11px]"
  }, f.label), /*#__PURE__*/React.createElement("span", {
    className: `text-xs font-mono font-black ${bookingFilter === f.id ? 'text-amber-400' : 'text-stone-500'}`
  }, "(", f.count, ")")))), (() => {
    const uniqueBookings = deduplicateBookings(filteredMyBookings);
    if (uniqueBookings.length === 0) {
      return /*#__PURE__*/React.createElement("div", {
        id: "bookingsContainer",
        className: "text-center py-10 glass-card rounded-3xl border border-amber-500/20 space-y-3"
      }, /*#__PURE__*/React.createElement("div", {
        id: "bookingsList",
        className: "space-y-3"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-3xl"
      }, "\uD83D\uDCC5"), /*#__PURE__*/React.createElement("p", {
        className: "text-xs text-stone-400 font-bold"
      }, "\u0644\u0627 \u062A\u0648\u062C\u062F \u062D\u062C\u0648\u0632\u0627\u062A \u0645\u0633\u062C\u0644\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u0642\u0633\u0645 \u062D\u0627\u0644\u064A\u0627\u064B."), /*#__PURE__*/React.createElement("button", {
        onClick: () => setActiveTab('book'),
        className: "gold-gradient-btn text-stone-950 text-xs font-black px-4 py-2 rounded-2xl shadow"
      }, "\u062D\u062C\u0632 \u0642\u0627\u0639\u0629 \u0627\u0644\u0622\u0646")));
    }
    return /*#__PURE__*/React.createElement("div", {
      id: "bookingsContainer",
      className: "space-y-3"
    }, /*#__PURE__*/React.createElement("div", {
      id: "cardsContainer",
      className: "space-y-3"
    }, /*#__PURE__*/React.createElement("div", {
      id: "bookingsList",
      className: "space-y-3"
    }, uniqueBookings.map((b, idx) => {
      const bKey = b.id || b.key || `${b.date || ''}_${b.start_time || b.time || b.startTime || ''}_${b.room_name || b.room || ''}` || 'booking-' + idx;
      const category = getBookingDisplayCategory(b);
      const isUpcoming = category === 'scheduled';
      const isCompleted = category === 'attended';
      const isCancelled = category === 'cancelled';
      const startDec = parseArabicTimeToDecimal(b.time || b.startTime || b.start_time);
      const durNum = parseFloat(b.duration || b.durationHours || 1);
      const endDec = startDec + durNum;
      const timeRangeFormatted = b.timeRange || `من ${decimalToTimeStr(startDec)} إلى ${decimalToTimeStr(endDec)}`;
      return /*#__PURE__*/React.createElement("div", {
        key: bKey,
        "data-booking-id": bKey,
        className: `glass-card p-4 sm:p-5 rounded-3xl border space-y-3 shadow-xl transition-all ${isUpcoming ? 'border-amber-500/40 bg-stone-950/90 hover:border-amber-400/70' : isCompleted ? 'border-blue-500/30 bg-blue-950/20' : 'border-rose-500/30 bg-rose-950/20'}`
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-start gap-2"
      }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-1.5 flex-wrap"
      }, /*#__PURE__*/React.createElement("h4", {
        className: "text-base font-black text-white"
      }, b.room), /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] bg-stone-900 border border-amber-500/30 text-amber-300 px-2 py-0.5 rounded-lg font-bold"
      }, durNum, " ", durNum === 1 ? 'ساعة' : durNum === 2 ? 'ساعتان' : 'ساعات')), /*#__PURE__*/React.createElement("p", {
        className: "text-xs text-amber-300 font-mono font-bold mt-1 flex items-center gap-1"
      }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCC5 ", b.date), /*#__PURE__*/React.createElement("span", null, "\u2022"), /*#__PURE__*/React.createElement("span", null, "\u23F0 ", timeRangeFormatted))), /*#__PURE__*/React.createElement("span", {
        className: `text-[10px] font-black px-3 py-1 rounded-xl border shadow whitespace-nowrap ${isUpcoming ? 'bg-emerald-950 border-emerald-500/50 text-emerald-300 animate-pulse-gold' : isCompleted ? 'bg-blue-950 border-blue-500/50 text-blue-300' : 'bg-rose-950 border-rose-500/50 text-rose-300'}`
      }, isUpcoming ? 'مؤكد قادم ⏳' : isCompleted ? 'جلسة مكتملة ✅' : 'ملغي ❌')), b.notes && /*#__PURE__*/React.createElement("p", {
        className: "text-[11px] text-stone-300 font-bold bg-stone-900/80 border border-amber-500/15 p-2 rounded-xl"
      }, "\uD83D\uDCDD ", b.notes), /*#__PURE__*/React.createElement("div", {
        className: "pt-2.5 border-t border-amber-500/15 flex items-center justify-between text-[11px] flex-wrap gap-2"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-emerald-300 font-black flex items-center gap-1 text-[10px]"
      }, /*#__PURE__*/React.createElement("span", null, "\u2713"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0645 \u062E\u0635\u0645 (", durNum, "\u0633) \u0641\u0648\u0631\u064A\u0627\u064B \u0645\u0646 \u0627\u0644\u0631\u0635\u064A\u062F")), isUpcoming ? /*#__PURE__*/React.createElement("button", {
        onClick: () => handleCancelBooking(b.id),
        className: "bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-[10px] font-black px-3 py-1 rounded-xl shadow active:scale-95 transition-all flex items-center gap-1"
      }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDDD1\uFE0F"), /*#__PURE__*/React.createElement("span", null, "\u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u062C\u0632")) : isCompleted ? /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] text-blue-300 font-bold bg-blue-950/60 px-2.5 py-0.5 rounded-lg border border-blue-500/20"
      }, "\u062C\u0644\u0633\u0629 \u0645\u0646\u062A\u0647\u064A\u0629 \u2705") : /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] text-rose-300 font-bold bg-rose-950/60 px-2.5 py-0.5 rounded-lg border border-rose-500/20"
      }, "\u0627\u0644\u0642\u0627\u0639\u0629 \u0645\u062D\u0631\u0631\u0629 \uD83D\uDD13")));
    }))));
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
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white flex items-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD14 \u0645\u0631\u0643\u0632 \u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0648\u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A")), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-amber-300 font-bold mt-0.5"
  }, "\u0643\u0627\u0641\u0629 \u0627\u0644\u0631\u0633\u0627\u0626\u0644 \u0648\u0627\u0644\u062A\u0646\u0628\u064A\u0647\u0627\u062A \u0627\u0644\u0645\u0631\u0633\u0644\u0629 \u0645\u0646 \u0625\u062F\u0627\u0631\u0629 \u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646")), notifications.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: handleMarkAllNotifsRead,
    className: "bg-stone-900/90 hover:bg-amber-950/80 border border-amber-500/30 text-amber-300 text-[10px] font-black px-3 py-1.5 rounded-xl shadow active:scale-95 transition-all"
  }, "\u062A\u062D\u062F\u064A\u062F \u0627\u0644\u0643\u0644 \u0643\u0645\u0642\u0631\u0648\u0621 \u2713\u2713")), sortedNotifications.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "text-center py-12 glass-card rounded-3xl border border-amber-500/20 space-y-3 shadow-lg"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-4xl block"
  }, "\uD83D\uDD14"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-stone-300 font-black"
  }, "\u0644\u0627 \u062A\u0648\u062C\u062F \u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0623\u0648 \u062A\u0646\u0628\u064A\u0647\u0627\u062A \u0645\u0633\u062C\u0644\u0629 \u062D\u0627\u0644\u064A\u0627\u064B."), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-stone-400 font-bold"
  }, "\u0623\u064A \u0631\u0633\u0627\u0644\u0629 \u0623\u0648 \u062A\u0646\u0628\u064A\u0647 \u0645\u0646 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0633\u062A\u0638\u0647\u0631 \u0647\u0646\u0627 \u0641\u0648\u0631\u064A\u0627\u064B \u0637\u0648\u0627\u0644 \u0623\u0648\u0642\u0627\u062A \u0627\u0644\u0639\u0645\u0644 \u0627\u0644\u0631\u0633\u0645\u064A\u0629 (12/6).")) : /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, sortedNotifications.map((n, idx) => {
    const isAlert = n.type === 'alert' || n.type === 'warning';
    const isPackage = n.type === 'package' || n.type === 'balance';
    const isBooking = n.type === 'booking';
    const isUnread = !n.read;
    return /*#__PURE__*/React.createElement("div", {
      key: n.id || idx,
      onClick: () => handleMarkSingleNotifRead(n.id),
      className: `glass-card p-4 sm:p-5 rounded-3xl border space-y-2.5 shadow-xl transition-all relative cursor-pointer ${isUnread ? 'border-amber-500/80 bg-stone-950/95 ring-1 ring-amber-500/40 shadow-amber-500/10' : isAlert ? 'border-rose-500/40 bg-rose-950/20' : isPackage ? 'border-emerald-500/30 bg-emerald-950/15' : isBooking ? 'border-blue-500/30 bg-blue-950/15' : 'border-stone-800/80 bg-stone-950/70'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-start gap-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "p-2 rounded-2xl bg-stone-900 border border-amber-500/20 text-base shadow-sm relative"
    }, isAlert ? '⚠️' : isPackage ? '💳' : isBooking ? '📅' : 'ℹ️', isUnread && /*#__PURE__*/React.createElement("span", {
      className: "absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border border-stone-950 animate-ping"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5"
    }, /*#__PURE__*/React.createElement("h4", {
      className: "text-xs sm:text-sm font-black text-white"
    }, n.title || 'إشعار من الإدارة'), isUnread && /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] font-black px-1.5 py-0.2 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30"
    }, "\u062C\u062F\u064A\u062F")), /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] text-amber-300/80 font-mono font-bold"
    }, n.time || n.date || ''))), /*#__PURE__*/React.createElement("span", {
      className: `text-[9px] font-black px-2.5 py-0.5 rounded-full border shadow whitespace-nowrap ${isAlert ? 'bg-rose-950 text-rose-300 border-rose-500/40' : isPackage ? 'bg-emerald-950 text-emerald-300 border-emerald-500/40' : isBooking ? 'bg-blue-950 text-blue-300 border-blue-500/40' : 'bg-amber-950 text-amber-300 border-amber-500/40'}`
    }, isAlert ? 'تنبيه هام ⚠️' : isPackage ? 'رصيد وباقة 💎' : isBooking ? 'مواعيد 📅' : 'إشعار عام 📢')), /*#__PURE__*/React.createElement("div", {
      className: "bg-stone-900/80 p-3.5 rounded-2xl border border-amber-500/15"
    }, /*#__PURE__*/React.createElement("p", {
      className: "text-xs font-bold text-stone-100 leading-relaxed whitespace-pre-line"
    }, n.text || n.message)), /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-center pt-1 text-[9px] font-bold"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-stone-400 font-mono"
    }, n.date || ''), /*#__PURE__*/React.createElement("span", {
      className: isUnread ? 'text-amber-400 font-black flex items-center gap-1' : 'text-stone-500 flex items-center gap-1'
    }, isUnread ? 'غير مقروء ✦' : 'تمت القراءة ✓✓')));
  })))), bookingSuccessModal && /*#__PURE__*/React.createElement("div", {
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
    className: "pt-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setBookingSuccessModal(null);
      setActiveTab('mybookings');
    },
    className: "w-full gold-gradient-btn text-stone-950 font-black py-4 rounded-2xl text-xs shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u0639\u0631\u0636 \u062C\u062F\u0648\u0644 \u062D\u062C\u0648\u0632\u0627\u062A\u064A \uD83D\uDCC5"))))), activeNotifModal && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-50 bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card bg-stone-950/95 max-w-sm w-full p-6 rounded-3xl border-2 border-amber-500/80 text-center space-y-4 shadow-2xl animate-in zoom-in-95 duration-150"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-16 h-16 mx-auto rounded-full bg-amber-500/20 text-amber-400 border-2 border-amber-500/50 flex items-center justify-center text-3xl animate-bounce"
  }, "\uD83D\uDD14"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] text-amber-300 font-bold font-mono block"
  }, "\u0625\u0634\u0639\u0627\u0631 \u062C\u062F\u064A\u062F \u0645\u0646 \u0625\u062F\u0627\u0631\u0629 \u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646"), /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white mt-1"
  }, activeNotifModal.title || 'تنبيه من الإدارة'), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-stone-400 font-mono mt-0.5"
  }, activeNotifModal.time || '')), /*#__PURE__*/React.createElement("div", {
    className: "p-3.5 bg-stone-900/90 rounded-2xl border border-amber-500/20 text-xs text-right space-y-1"
  }, /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-stone-100 font-bold leading-relaxed whitespace-pre-line"
  }, activeNotifModal.text || activeNotifModal.message)), /*#__PURE__*/React.createElement("div", {
    className: "pt-2 flex gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (activeNotifModal && activeNotifModal.id) {
        const userKey = client ? client.id || client.username || 'user' : 'user';
        const readStorageKey = 'ALKAYAN_READ_NOTIFS_' + userKey;
        try {
          const existing = JSON.parse(localStorage.getItem(readStorageKey) || '[]');
          localStorage.setItem(readStorageKey, JSON.stringify(Array.from(new Set([...existing, activeNotifModal.id]))));
          localStorage.setItem('KAYAN_SEEN_POPUP_' + activeNotifModal.id, 'true');
        } catch (e) {}
        setNotifications(prev => prev.map(n => n.id === activeNotifModal.id ? {
          ...n,
          read: true
        } : n));
        setUnreadNotifCount(prev => Math.max(0, prev - 1));
      }
      setActiveNotifModal(null);
      setActiveTab('notifications');
    },
    className: "flex-1 gold-gradient-btn text-stone-950 font-black py-3 rounded-2xl text-xs shadow-xl active:scale-95 transition-all"
  }, "\u0639\u0631\u0636 \u0643\u0644 \u0627\u0644\u0625\u0634\u0639\u0627\u0631\u0627\u062A \uD83D\uDD14"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (activeNotifModal && activeNotifModal.id) {
        const userKey = client ? client.id || client.username || 'user' : 'user';
        const readStorageKey = 'ALKAYAN_READ_NOTIFS_' + userKey;
        try {
          const existing = JSON.parse(localStorage.getItem(readStorageKey) || '[]');
          localStorage.setItem(readStorageKey, JSON.stringify(Array.from(new Set([...existing, activeNotifModal.id]))));
          localStorage.setItem('KAYAN_SEEN_POPUP_' + activeNotifModal.id, 'true');
        } catch (e) {}
        setNotifications(prev => prev.map(n => n.id === activeNotifModal.id ? {
          ...n,
          read: true
        } : n));
        setUnreadNotifCount(prev => Math.max(0, prev - 1));
      }
      setActiveNotifModal(null);
    },
    className: "px-4 bg-stone-900 border border-stone-700 text-stone-300 font-bold py-3 rounded-2xl text-xs"
  }, "\u0625\u063A\u0644\u0627\u0642")))), cancelModalBooking && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[60] bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card bg-stone-950/98 max-w-sm w-full p-6 rounded-3xl border-2 border-rose-500/80 text-center space-y-4 shadow-2xl animate-in zoom-in-95 duration-150"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-16 h-16 mx-auto rounded-full bg-rose-500/20 text-rose-400 border-2 border-rose-500/50 flex items-center justify-center text-3xl animate-pulse"
  }, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-black text-white"
  }, "\u062A\u0623\u0643\u064A\u062F \u0625\u0644\u063A\u0627\u0621 \u062D\u062C\u0632 \u0627\u0644\u0642\u0627\u0639\u0629"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-rose-300 font-bold mt-1"
  }, "\u062A\u062D\u0630\u064A\u0631 \u0633\u064A\u0627\u0633\u0629 \u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0627\u0644\u0645\u062E\u0635\u0648\u0645\u0629")), /*#__PURE__*/React.createElement("div", {
    className: "p-3.5 bg-stone-900/90 rounded-2xl border border-rose-500/30 text-xs text-right space-y-1.5 font-mono"
  }, /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("span", {
    className: "text-stone-400 font-sans"
  }, "\u0627\u0644\u0642\u0627\u0639\u0629:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-white"
  }, cancelModalBooking.room)), /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("span", {
    className: "text-stone-400 font-sans"
  }, "\u0627\u0644\u0645\u0648\u0639\u062F:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-white"
  }, cancelModalBooking.date), " (", cancelModalBooking.timeRange || cancelModalBooking.time, ")"), /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("span", {
    className: "text-stone-400 font-sans"
  }, "\u0627\u0644\u0645\u062F\u0629:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-white"
  }, cancelModalBooking.duration, " \u0633\u0627\u0639\u0629"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-rose-950/70 p-4 rounded-2xl border-2 border-rose-500/60 text-xs text-right space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 text-rose-300 font-black text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-base"
  }, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("span", null, "\u062A\u062D\u0630\u064A\u0631 \u0633\u064A\u0627\u0633\u0629 \u0627\u0644\u0633\u0627\u0639\u0627\u062A:")), /*#__PURE__*/React.createElement("p", {
    className: "text-stone-100 font-bold leading-relaxed text-[11.5px]"
  }, "\u0639\u0646\u062F \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u0625\u0644\u063A\u0627\u0621\u060C \u0633\u064A\u062A\u0645 ", /*#__PURE__*/React.createElement("b", null, "\u062A\u062D\u0631\u064A\u0631 \u0627\u0644\u0642\u0627\u0639\u0629 \u0641\u0648\u0631\u0627\u064B \u0648\u0625\u062A\u0627\u062D\u062A\u0647\u0627 \u0644\u0644\u0622\u062E\u0631\u064A\u0646"), ". \u0646\u0624\u0643\u062F \u0644\u0643 \u0623\u0646\u0647 \u0648\u0641\u0642\u0627\u064B \u0644\u0644\u0627\u0626\u062D\u0629 \u0627\u0644\u062D\u062C\u0648\u0632\u0627\u062A \u0627\u0644\u0645\u0639\u062A\u0645\u062F\u0629\u060C ", /*#__PURE__*/React.createElement("b", null, "\u0644\u0627 \u064A\u0645\u0643\u0646 \u0627\u0633\u062A\u0631\u062F\u0627\u062F \u0627\u0644\u0633\u0627\u0639\u0627\u062A \u0627\u0644\u0645\u062E\u0635\u0648\u0645\u0629 \u0645\u0631\u0629 \u0623\u062E\u0631\u0649"), ".")), /*#__PURE__*/React.createElement("div", {
    className: "pt-2 flex flex-col gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: confirmCancelBooking,
    className: "w-full bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-black py-3.5 rounded-2xl text-xs shadow-xl active:scale-95 transition-all"
  }, "\u062A\u0623\u0643\u064A\u062F \u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u062C\u0632 \u0648\u062A\u062D\u0631\u064A\u0631 \u0627\u0644\u0642\u0627\u0639\u0629 \uD83D\uDDD1\uFE0F"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setCancelModalBooking(null),
    className: "w-full bg-stone-900 border border-stone-700 text-stone-300 font-bold py-3 rounded-2xl text-xs hover:text-white"
  }, "\u062A\u0631\u0627\u062C\u0639 \u0648\u0627\u0644\u0627\u062D\u062A\u0641\u0627\u0638 \u0628\u0627\u0644\u062D\u062C\u0632 \u21A9\uFE0F")))), showLedgerModal && (() => {
    const finBal = typeof client.financialBalance === 'number' ? client.financialBalance : 0;
    const totalCharges = (myFinancialTransactions || []).reduce((acc, t) => t.type === 'charge' ? acc + (parseFloat(t.amount) || 0) : acc, 0);
    const totalPaid = (myFinancialTransactions || []).reduce((acc, t) => t.type === 'payment' ? acc + (parseFloat(t.amount) || 0) : acc, 0);
    return /*#__PURE__*/React.createElement("div", {
      className: "fixed inset-0 z-[60] bg-stone-950/90 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-150"
    }, /*#__PURE__*/React.createElement("div", {
      className: "glass-card bg-stone-950/98 w-full max-w-md p-5 sm:p-6 rounded-t-3xl sm:rounded-3xl border-2 border-amber-500/50 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom duration-200 text-white"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-start border-b border-amber-500/20 pb-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: "p-2 bg-amber-500/20 text-amber-300 rounded-2xl text-xl border border-amber-500/30"
    }, "\u2615"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h3", {
      className: "text-sm sm:text-base font-black text-white"
    }, "\u0643\u0634\u0641 \u062D\u0633\u0627\u0628 \u0627\u0644\u062E\u062F\u0645\u0627\u062A \u0648\u0627\u0644\u0628\u0648\u0641\u064A\u0647 \u0648\u0627\u0644\u062A\u0635\u0648\u064A\u0631"), /*#__PURE__*/React.createElement("p", {
      className: "text-[10px] text-stone-400 font-bold mt-0.5"
    }, "\u0633\u062C\u0644 \u0643\u0627\u0645\u0644 \u0628\u062C\u0645\u064A\u0639 \u0627\u0644\u0637\u0644\u0628\u0627\u062A \u0648\u0627\u0644\u062F\u0641\u0639\u0627\u062A \u0627\u0644\u0645\u0627\u0644\u064A\u0629"))), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setShowLedgerModal(false),
      className: "p-1.5 rounded-xl bg-stone-900 text-stone-400 hover:text-white text-xl font-bold"
    }, "\xD7")), /*#__PURE__*/React.createElement("div", {
      className: `p-4 rounded-2xl border text-center space-y-1 ${finBal < 0 ? 'bg-rose-950/40 border-rose-500/50 text-rose-300' : finBal > 0 ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300' : 'bg-stone-900 border-stone-700 text-stone-300'}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] font-bold block"
    }, finBal < 0 ? 'إجمالي المبلغ المستحق عليك للدفع:' : finBal > 0 ? 'رصيد الخدمات المتاح في حسابك:' : 'حالة الحساب الحالي:'), /*#__PURE__*/React.createElement("div", {
      className: "text-3xl font-black font-mono tracking-tight"
    }, finBal < 0 ? `${Math.abs(finBal).toLocaleString()} ج.م` : finBal > 0 ? `${finBal.toLocaleString()} ج.م` : '0 ج.م'), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-stone-300 block font-bold"
    }, finBal < 0 ? 'يرجى سداد المبلغ لدى الاستقبال أو التحويل' : finBal > 0 ? 'رصيد متاح للاستخدام في البوفيه والطباعة' : 'الحساب متزن تماماً')), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: handleOpenInstaPay,
      className: "w-full py-3 px-3.5 rounded-2xl bg-gradient-to-r from-[#6A0E40] via-[#8E1758] to-[#B81B73] hover:from-[#7E124D] hover:to-[#CD1F81] text-white font-black text-xs shadow-lg border border-pink-400/40 flex items-center justify-between active:scale-95 transition-all"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-8 h-8 rounded-xl bg-white p-1 flex items-center justify-center shadow-xs flex-shrink-0"
    }, /*#__PURE__*/React.createElement(InstaPayLogo, {
      className: "w-6 h-6"
    })), /*#__PURE__*/React.createElement("div", {
      className: "text-right"
    }, /*#__PURE__*/React.createElement("span", {
      className: "block font-black text-white text-xs"
    }, "\u0633\u062F\u0627\u062F \u0627\u0644\u0645\u0628\u0644\u063A \u0639\u0628\u0631 InstaPay \u26A1"), /*#__PURE__*/React.createElement("span", {
      className: "block text-[9.5px] text-pink-200 font-bold"
    }, "\u062A\u062D\u0648\u064A\u0644 \u0641\u0648\u0631\u064A \u0644\u062D\u0633\u0627\u0628 \u0627\u0644\u0643\u064A\u0627\u0646 (x.lance@instapay)"))), /*#__PURE__*/React.createElement("span", {
      className: "bg-black/30 px-2.5 py-1 rounded-xl text-[11px] font-mono text-pink-100 border border-white/15"
    }, "\u0627\u062F\u0641\u0639 \u0627\u0644\u0622\u0646 \u2190")), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 gap-2 text-center text-xs"
    }, /*#__PURE__*/React.createElement("div", {
      className: "p-2.5 rounded-2xl bg-rose-950/20 border border-rose-500/20"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-rose-300 font-bold block"
    }, "\u0625\u062C\u0645\u0627\u0644\u064A \u0627\u0644\u0645\u0633\u062D\u0648\u0628\u0627\u062A (\u0637\u0644\u0628\u0627\u062A):"), /*#__PURE__*/React.createElement("span", {
      className: "font-mono font-black text-rose-400 text-sm mt-0.5 block"
    }, totalCharges.toLocaleString(), " \u062C.\u0645")), /*#__PURE__*/React.createElement("div", {
      className: "p-2.5 rounded-2xl bg-emerald-950/20 border border-emerald-500/20"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] text-emerald-300 font-bold block"
    }, "\u0625\u062C\u0645\u0627\u0644\u064A \u0627\u0644\u0633\u062F\u0627\u062F (\u062F\u0641\u0639\u0627\u062A):"), /*#__PURE__*/React.createElement("span", {
      className: "font-mono font-black text-emerald-400 text-sm mt-0.5 block"
    }, totalPaid.toLocaleString(), " \u062C.\u0645"))), /*#__PURE__*/React.createElement("div", {
      className: "space-y-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-[11px] font-black text-amber-300 block"
    }, "\u0633\u062C\u0644 \u0627\u0644\u062D\u0631\u0643\u0627\u062A \u0627\u0644\u062A\u0641\u0635\u064A\u0644\u064A (\u0645\u0631\u062A\u0628\u0629 \u0645\u0646 \u0627\u0644\u0623\u062D\u062F\u062B):"), !myFinancialTransactions || myFinancialTransactions.length === 0 ? /*#__PURE__*/React.createElement("div", {
      className: "text-center py-8 glass-card-subtle rounded-2xl border border-amber-500/15 text-stone-400 text-xs"
    }, "\u0644\u0645 \u064A\u062A\u0645 \u062A\u0633\u062C\u064A\u0644 \u0623\u064A \u0637\u0644\u0628\u0627\u062A \u0628\u0648\u0641\u064A\u0647 \u0623\u0648 \u0637\u0628\u0627\u0639\u0629 \u0641\u064A \u062D\u0633\u0627\u0628\u0643 \u062D\u062A\u0649 \u0627\u0644\u0622\u0646.") : /*#__PURE__*/React.createElement("div", {
      className: "space-y-2 max-h-[250px] overflow-y-auto pr-1"
    }, myFinancialTransactions.map(tx => {
      const isCharge = tx.type === 'charge';
      return /*#__PURE__*/React.createElement("div", {
        key: tx.id,
        className: "p-3 rounded-2xl glass-card-subtle border border-amber-500/15 flex items-center justify-between text-xs"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-2 min-w-0"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-base flex-shrink-0"
      }, tx.category === 'buffet' ? '☕' : tx.category === 'printing' ? '📄' : isCharge ? '🏷️' : '💵'), /*#__PURE__*/React.createElement("div", {
        className: "truncate"
      }, /*#__PURE__*/React.createElement("span", {
        className: "font-black text-white block truncate"
      }, tx.categoryName), tx.description && /*#__PURE__*/React.createElement("span", {
        className: "text-[10px] text-stone-300 block truncate font-bold"
      }, "\uD83D\uDCDD ", tx.description), /*#__PURE__*/React.createElement("span", {
        className: "text-[9px] text-stone-400 font-mono block"
      }, tx.date, " (", tx.time, ")"))), /*#__PURE__*/React.createElement("div", {
        className: "text-left flex-shrink-0 mr-2"
      }, /*#__PURE__*/React.createElement("span", {
        className: `font-mono font-black text-sm block ${isCharge ? 'text-rose-400' : 'text-emerald-400'}`
      }, isCharge ? `-${tx.amount}` : `+${tx.amount}`, " \u062C.\u0645"), /*#__PURE__*/React.createElement("span", {
        className: "text-[9px] text-stone-400 font-bold block"
      }, isCharge ? 'مطلوب' : 'سداد')));
    }))), /*#__PURE__*/React.createElement("div", {
      className: "pt-2 flex flex-col gap-2"
    }, /*#__PURE__*/React.createElement("a", {
      href: `https://wa.me/${(settings.companyPhone || '966500000000').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}). أود التواصل معكم بخصوص كشف حساب الخدمات والبوفيه (الرصيد: ${finBal} ج.م).`)}`,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "w-full bg-gradient-to-r from-emerald-600 via-emerald-700 to-teal-800 hover:from-emerald-500 text-white font-black py-3 rounded-2xl text-xs shadow-xl active:scale-95 transition-all text-center flex items-center justify-center gap-2 border border-emerald-400/40"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCAC"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0639\u0628\u0631 WhatsApp \u0628\u062E\u0635\u0648\u0635 \u0627\u0644\u062D\u0633\u0627\u0628")), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => setShowLedgerModal(false),
      className: "w-full bg-stone-900 border border-stone-700 text-stone-300 font-bold py-2.5 rounded-2xl text-xs hover:text-white"
    }, "\u0625\u063A\u0644\u0627\u0642"))));
  })(), showInstaPayModal && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[80] bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card bg-stone-950/98 max-w-md w-full p-6 rounded-3xl border-2 border-pink-500/70 text-center space-y-5 shadow-2xl animate-in zoom-in-95 duration-150 text-white"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col items-center gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-16 h-16 rounded-2xl bg-white p-2 flex items-center justify-center shadow-xl border-2 border-pink-500/40"
  }, /*#__PURE__*/React.createElement(InstaPayLogo, {
    className: "w-12 h-12"
  })), /*#__PURE__*/React.createElement("h3", {
    className: "text-base sm:text-lg font-black text-white"
  }, "\u062A\u0645 \u0641\u062A\u062D \u0635\u0641\u062D\u0629 \u0627\u0644\u062F\u0641\u0639 \u0639\u0628\u0631 InstaPay \u26A1"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs text-pink-300 font-mono bg-pink-950/60 px-3 py-1 rounded-xl border border-pink-500/30"
  }, "\u062D\u0633\u0627\u0628 \u0627\u0644\u0627\u0633\u062A\u0642\u0628\u0627\u0644: x.lance@instapay")), /*#__PURE__*/React.createElement("div", {
    className: "p-4 rounded-2xl bg-gradient-to-br from-amber-950/90 via-stone-900 to-amber-950/90 border-2 border-amber-500/80 text-right space-y-2 shadow-inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 text-amber-300 font-black text-xs sm:text-sm"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg animate-bounce"
  }, "\uD83D\uDCF8"), /*#__PURE__*/React.createElement("span", null, "\u062A\u0646\u0628\u064A\u0647 \u0647\u0627\u0645 \u0648\u0625\u0644\u0632\u0627\u0645\u064A \u0644\u0627\u0639\u062A\u0645\u0627\u062F \u0627\u0644\u062A\u062D\u0648\u064A\u0644:")), /*#__PURE__*/React.createElement("p", {
    className: "text-stone-100 font-bold leading-relaxed text-xs"
  }, "\u0628\u0639\u062F \u0625\u062A\u0645\u0627\u0645 \u0639\u0645\u0644\u064A\u0629 \u0627\u0644\u062F\u0641\u0639 \u0639\u0628\u0631 \u062A\u0637\u0628\u064A\u0642 ", /*#__PURE__*/React.createElement("span", {
    className: "text-pink-300 font-black"
  }, "InstaPay"), "\u060C \u064A\u062C\u0628 ", /*#__PURE__*/React.createElement("b", null, "\u0627\u0644\u062A\u0642\u0627\u0637 \u0633\u0643\u0631\u064A\u0646 \u0634\u0648\u062A (Screenshot)"), " \u0644\u0625\u0634\u0639\u0627\u0631 \u0627\u0644\u062A\u062D\u0648\u064A\u0644\u060C \u062B\u0645 ", /*#__PURE__*/React.createElement("b", null, "\u0625\u0631\u0633\u0627\u0644\u0647\u0627 \u0645\u0628\u0627\u0634\u0631\u0629 \u0625\u0644\u0649 \u0625\u062F\u0627\u0631\u0629 \u0645\u062C\u0645\u0648\u0639\u0629 \u0627\u0644\u0643\u064A\u0627\u0646 \u0639\u0628\u0631 \u0627\u0644\u0648\u0627\u062A\u0633\u0627\u0628"), " \u0644\u064A\u062A\u0645 \u0627\u0644\u062A\u062D\u0642\u0642 \u0627\u0644\u0641\u0648\u0631\u064A \u0648\u0642\u064A\u062F \u0648\u062A\u0633\u062F\u064A\u062F \u0627\u0644\u0645\u0628\u0644\u063A \u0641\u064A \u0645\u062D\u0641\u0638\u062A\u0643.")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5 pt-1"
  }, /*#__PURE__*/React.createElement("a", {
    href: `https://wa.me/${(settings.companyPhone || '+201500070655').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client?.name || ''}). قمت بالتحويل عبر InstaPay لحساب الكيان (x.lance). مرفق سكرين شوت إشعار التحويل لتسديد وقيد المبلغ في حسابي بمحفظة الخدمات.`)}`,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 text-white font-black text-xs sm:text-sm shadow-xl shadow-emerald-950/50 transition-all active:scale-95 flex items-center justify-center gap-2 border border-emerald-400/40"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83D\uDCF2"), /*#__PURE__*/React.createElement("span", null, "\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0627\u0633\u0643\u0631\u064A\u0646 \u0634\u0648\u062A \u0639\u0628\u0631 \u0648\u0627\u062A\u0633\u0627\u0628 \u0627\u0644\u0625\u062F\u0627\u0631\u0629")), /*#__PURE__*/React.createElement("a", {
    href: INSTAPAY_PAYMENT_URL,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "w-full py-2.5 px-4 rounded-2xl bg-gradient-to-r from-[#8E1758] to-[#B81B73] hover:from-[#9E1A63] hover:to-[#C91E7F] text-white font-bold text-xs shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD17"), /*#__PURE__*/React.createElement("span", null, "\u0625\u0639\u0627\u062F\u0629 \u0641\u062A\u062D \u0631\u0627\u0628\u0637 \u0627\u0644\u062F\u0641\u0639 (InstaPay)")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setShowInstaPayModal(false),
    className: "w-full py-2.5 rounded-2xl bg-stone-900 hover:bg-stone-800 text-stone-300 font-bold text-xs border border-stone-700 hover:text-white transition-all"
  }, "\u0625\u063A\u0644\u0627\u0642 \u0627\u0644\u0646\u0627\u0641\u0630\u0629")))), showStrictAlertModal && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[85] bg-stone-950/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glass-card bg-stone-950/98 max-w-md w-full p-6 rounded-3xl border-2 border-rose-500/80 text-center space-y-4 shadow-2xl animate-in zoom-in-95 duration-150 text-white"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-16 h-16 rounded-full bg-rose-500/20 border-2 border-rose-500/50 flex items-center justify-center mx-auto text-3xl animate-bounce"
  }, contractStatus.isFullTime ? '👑' : '⏱️'), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-black uppercase tracking-wider bg-rose-950/80 text-rose-300 px-3 py-1 rounded-full border border-rose-500/40"
  }, contractStatus.isFullTime ? 'تنبيه تجديد اشتراك الدوام الكامل 🚨' : 'تنبيه رصيد الساعات (آخر 5 ساعات) ⚠️'), /*#__PURE__*/React.createElement("h3", {
    className: "text-lg font-black text-white mt-2"
  }, contractStatus.isFullTime ? contractStatus.daysLeft <= 0 ? 'انتهى اشتراك الدوام الكامل!' : `متبقي ${contractStatus.daysLeft} أيام فقط على انتهاء اشتراكك!` : parseFloat(client.currentBalance || 0) <= 0 ? 'نفد رصيد الساعات المخصص لك!' : `متبقي لديك (${client.currentBalance} ساعة) فقط لتجديد الوقت!`)), /*#__PURE__*/React.createElement("div", {
    className: "p-4 rounded-2xl bg-stone-900/90 border border-amber-500/30 text-right text-xs leading-relaxed font-bold text-stone-200"
  }, contractStatus.isFullTime ? /*#__PURE__*/React.createElement("span", null, "\u0639\u0632\u064A\u0632\u064A \u0627\u0644\u0639\u0645\u064A\u0644 ", /*#__PURE__*/React.createElement("b", null, client.name), "\u060C \u0646\u0648\u062F \u0625\u062D\u0627\u0637\u062A\u0643\u0645 \u0639\u0644\u0645\u0627\u064B \u0628\u0627\u0642\u062A\u0631\u0627\u0628 \u0645\u0648\u0639\u062F \u0627\u0646\u062A\u0647\u0627\u0621 \u0648\u062A\u062C\u062F\u064A\u062F \u0627\u0634\u062A\u0631\u0627\u0643\u0643\u0645 \u0628\u0646\u0638\u0627\u0645 \u0627\u0644\u062F\u0648\u0627\u0645 \u0627\u0644\u0643\u0627\u0645\u0644 \u0628\u062A\u0627\u0631\u064A\u062E (", /*#__PURE__*/React.createElement("b", null, client.expiryDate), "). \u064A\u0631\u062C\u0649 \u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062A\u062C\u062F\u064A\u062F \u0644\u0636\u0645\u0627\u0646 \u0627\u0633\u062A\u0645\u0631\u0627\u0631 \u062A\u062E\u0635\u064A\u0635 \u0645\u0643\u062A\u0628\u0643\u0645 \u0648\u0645\u0633\u0627\u062D\u062A\u0643\u0645 \u0627\u0644\u062E\u0627\u0635\u0629 (", /*#__PURE__*/React.createElement("b", null, client.dedicatedRoom || 'المكتب التنفيذي'), ") \u062F\u0648\u0646 \u0627\u0646\u0642\u0637\u0627\u0639.") : /*#__PURE__*/React.createElement("span", null, "\u0639\u0632\u064A\u0632\u064A \u0627\u0644\u0639\u0645\u064A\u0644 ", /*#__PURE__*/React.createElement("b", null, client.name), "\u060C \u0648\u0635\u0644 \u0631\u0635\u064A\u062F\u0643 \u0627\u0644\u062D\u0627\u0644\u064A \u0625\u0644\u0649 (", /*#__PURE__*/React.createElement("b", null, client.currentBalance, " \u0633\u0627\u0639\u0629"), ")\u060C \u0648\u0647\u0648 \u0627\u0644\u062D\u062F \u0627\u0644\u0623\u062F\u0646\u0649 \u0627\u0644\u0645\u062A\u0628\u0642\u064A (\u0622\u062E\u0631 5 \u0633\u0627\u0639\u0627\u062A). \u064A\u0631\u062C\u0649 \u0634\u062D\u0646 \u0623\u0648 \u062A\u062C\u062F\u064A\u062F \u0627\u0644\u0628\u0627\u0642\u0629 \u0627\u0644\u0622\u0646 \u0639\u0628\u0631 InstaPay \u0623\u0648 \u0627\u0644\u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0644\u0644\u0627\u0633\u062A\u0645\u0631\u0627\u0631 \u0641\u064A \u062D\u062C\u0632 \u0627\u0644\u0642\u0627\u0639\u0627\u062A \u0648\u0645\u0633\u0627\u062D\u0627\u062A \u0627\u0644\u0639\u0645\u0644.")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2 pt-2"
  }, !contractStatus.isFullTime && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setShowStrictAlertModal(false);
      handleOpenInstaPay();
    },
    className: "w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-800 text-white font-black text-xs shadow-lg flex items-center justify-center gap-2 active:scale-95 border border-purple-300/40"
  }, /*#__PURE__*/React.createElement("span", null, "\u26A1 \u0634\u062D\u0646 \u0627\u0644\u0628\u0627\u0642\u0629 \u0641\u0648\u0631\u0627\u064B \u0639\u0628\u0631 InstaPay")), /*#__PURE__*/React.createElement("a", {
    href: `https://wa.me/${(settings.companyPhone || '+201500070655').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(contractStatus.isFullTime ? `السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}) المشترك بنظام الدوام الكامل في (${client.dedicatedRoom || 'مكتبي'}). أود تأكيد تجديد اشتراكي حيث متبقي (${contractStatus.daysLeft}) أيام فقط على انتهائه.` : `السلام عليكم إدارة مجموعة الكيان، أنا العميل (${client.name}). أود شحن وتجديد رصيد الساعات حيث متبقي في حسابي (${client.currentBalance}) ساعة فقط.`)}`,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: () => setShowStrictAlertModal(false),
    className: "w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-700 text-white font-black text-xs shadow-lg flex items-center justify-center gap-2 active:scale-95 border border-emerald-400/40"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCAC \u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0625\u062F\u0627\u0631\u0629 \u0644\u062A\u0623\u0643\u064A\u062F \u0627\u0644\u062A\u062C\u062F\u064A\u062F \u0648\u0627\u0644\u0634\u062D\u0646 \u0639\u0628\u0631 \u0648\u0627\u062A\u0633\u0627\u0628")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setShowStrictAlertModal(false),
    className: "w-full py-2.5 px-4 rounded-2xl bg-stone-900 hover:bg-stone-800 text-stone-300 font-bold text-xs active:scale-95 transition-all border border-stone-700"
  }, "\u0645\u062A\u0627\u0628\u0639\u0629 \u0625\u0644\u0649 \u062D\u0633\u0627\u0628\u064A \u2794")))), /*#__PURE__*/React.createElement("nav", {
    className: "fixed bottom-0 inset-x-0 z-40 max-w-md mx-auto mobile-bottom-nav px-3 py-2 flex items-center justify-around shadow-2xl"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('home'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${activeTab === 'home' ? 'text-amber-300 scale-105' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83C\uDFE0"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-black"
  }, "\u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629")), !contractStatus.isFullTime && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
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
  }, "\u062D\u062C\u0648\u0632\u0627\u062A\u064A"))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setActiveTab('history'),
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all ${activeTab === 'history' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83D\uDCCB"), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold"
  }, "\u0627\u0644\u0633\u062C\u0644")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setActiveTab('notifications');
      setUnreadNotifCount(0);
    },
    className: `flex flex-col items-center gap-1 py-1 px-3 rounded-2xl transition-all relative ${activeTab === 'notifications' ? 'text-amber-300 scale-105 font-black' : 'text-stone-400 hover:text-white'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-lg"
  }, "\uD83D\uDD14"), unreadNotifCount > 0 && /*#__PURE__*/React.createElement("span", {
    className: "absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 bg-rose-500 text-white text-[8px] font-black rounded-full flex items-center justify-center border-2 border-stone-950 animate-pulse"
  }, unreadNotifCount > 9 ? '9+' : unreadNotifCount)), /*#__PURE__*/React.createElement("span", {
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

// trigger build