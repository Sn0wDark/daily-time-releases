// Pay-period math for Daily Time. No DOM and no "now": pass todayIso in.
// Biweekly matches the original anchor / 14-day grid. Twice a month is
// 1st–(split-1) and split–end of month (split defaults to 16).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PayPeriod = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoDate(d); };
  const dayDiff = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 864e5);
  const validIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const parts = iso => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  function daysInMonth(y, m) {
    if (m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }
  function eachDay(start, end) {
    const out = [];
    for (let iso = start; iso <= end; iso = addDays(iso, 1)) out.push(iso);
    return out;
  }
  function isSemi(s) { return !!(s && s.ppType === 'semimonthly'); }

  // Blank, null, and NaN stay on the 16th preset. Real numbers clamp to 2–28
  // so every month still has two non-empty periods (0 and 1 become 2).
  function splitDay(s) {
    const raw = s && s.ppSplit;
    if (raw == null || raw === '') return 16;
    const n = Math.round(+raw);
    if (!isFinite(n)) return 16;
    if (n < 2) return 2;
    if (n > 28) return 28;
    return n;
  }
  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }
  function splitHint(s) {
    const S = splitDay(s);
    return `Periods: 1st–${ordinal(S - 1)} and ${ordinal(S)}–end of month`;
  }
  function splitOption(s) {
    const S = splitDay(s);
    return `Twice a month (1st–${ordinal(S - 1)}, ${ordinal(S)}–end)`;
  }

  function anchorOf(s, todayIso) {
    if (s && validIso(s.ppStart)) return s.ppStart;
    const d = parseIso(todayIso);
    d.setDate(d.getDate() - d.getDay());
    return isoDate(d);
  }
  function biweeklyFromStart(start) {
    const end = addDays(start, 13);
    return { start, end, days: eachDay(start, end), type: 'biweekly' };
  }
  function biweeklyPeriod(iso, s, todayIso) {
    const a = anchorOf(s, todayIso);
    const k = Math.floor(dayDiff(a, iso) / 14);
    return biweeklyFromStart(addDays(a, k * 14));
  }
  function semiPeriod(iso, s) {
    const { y, m, d } = parts(iso);
    const dim = daysInMonth(y, m);
    const split = Math.min(splitDay(s), dim);
    const start = d < split ? ymd(y, m, 1) : ymd(y, m, split);
    const end = d < split ? ymd(y, m, split - 1) : ymd(y, m, dim);
    return { start, end, days: eachDay(start, end), type: 'semimonthly' };
  }
  function payPeriodFor(iso, s, todayIso) {
    if (!validIso(iso)) throw new Error('bad date');
    s = s || {};
    if (isSemi(s)) return semiPeriod(iso, s);
    return biweeklyPeriod(iso, s, todayIso || iso);
  }
  function nextPeriod(period, s, todayIso) {
    return payPeriodFor(addDays(period.end, 1), s, todayIso);
  }
  function prevPeriod(period, s, todayIso) {
    return payPeriodFor(addDays(period.start, -1), s, todayIso);
  }

  // Sunday of the Sun–Sat week that contains iso (same Sunday the app already uses).
  function weekStart(iso) {
    const d = parseIso(iso);
    d.setDate(d.getDate() - d.getDay());
    return isoDate(d);
  }
  function workweeksIn(period) {
    const groups = [];
    let cur = null;
    for (const iso of period.days) {
      const sun = weekStart(iso);
      if (!cur || cur.weekStart !== sun) {
        cur = { weekStart: sun, weekEnd: addDays(sun, 6), days: [] };
        groups.push(cur);
      }
      cur.days.push(iso);
    }
    return groups;
  }

  // Overtime minutes per day inside this period.
  // Biweekly: each 7-day half of the period, this period only (unchanged).
  // Twice a month: the Sun–Sat week, including days in the neighbouring period.
  // Hours fill the week in order; overtime belongs to the day (and period) it was worked.
  function overtimeByDay(period, s, workedMin) {
    const limit = (+(s && s.otWeek) || 0) * 60;
    const byDay = {};
    period.days.forEach(iso => { byDay[iso] = 0; });
    const take = iso => +workedMin(iso) || 0;
    const fill = days => {
      let cum = 0;
      days.forEach(iso => {
        const before = cum;
        cum += take(iso);
        if (Object.prototype.hasOwnProperty.call(byDay, iso)) {
          byDay[iso] = limit ? Math.max(0, cum - limit) - Math.max(0, before - limit) : 0;
        }
      });
    };
    if (!limit) return { byDay, total: 0 };
    if (!isSemi(s)) {
      fill(period.days.slice(0, 7));
      fill(period.days.slice(7, 14));
    } else {
      const seen = {};
      period.days.forEach(iso => { seen[weekStart(iso)] = true; });
      Object.keys(seen).sort().forEach(sun => {
        const days = [];
        for (let i = 0; i < 7; i++) days.push(addDays(sun, i));
        fill(days);
      });
    }
    const total = period.days.reduce((t, iso) => t + byDay[iso], 0);
    return { byDay, total };
  }

  function periodGoalHours(period, s) {
    s = s || {};
    if (!isSemi(s)) return +s.ppHours || 0;
    if (s.ppHoursSemi !== '' && s.ppHoursSemi != null && isFinite(+s.ppHoursSemi)) return +s.ppHoursSemi;
    const target = +s.target || 0;
    const wd = Array.isArray(s.workDays) ? s.workDays : [1, 2, 3, 4, 5];
    let n = 0;
    for (const iso of period.days) if (wd.includes(parseIso(iso).getDay())) n++;
    return n * target;
  }
  // Goal for "left this week" on a twice-a-month period: your normal work days
  // in that Sun–Sat week times your normal day length (Mon–Thu at 9.75 is 39,
  // 6 h × 5 days is 30). The overtime line (otWeek) is only a fallback for when
  // that comes to 0 (no day length or no work days set). Every 2 weeks doesn't
  // use this: its week goal stays half the pay-period goal.
  function weekGoalHours(sun, s) {
    s = s || {};
    const target = +s.target || 0;
    const wd = Array.isArray(s.workDays) ? s.workDays : [1, 2, 3, 4, 5];
    let n = 0;
    for (let i = 0; i < 7; i++) if (wd.includes(parseIso(addDays(sun, i)).getDay())) n++;
    const normal = n * target;
    if (normal > 0) return normal;
    const ot = +s.otWeek;
    if (s.otWeek !== '' && s.otWeek != null && isFinite(ot) && ot > 0) return ot;
    return 0;
  }

  // Index of the twice-a-month period that contains iso: two per month, counted
  // from year 0, so the difference of two indexes is how many periods apart they are.
  function semiIndex(iso, s) {
    const { y, m, d } = parts(iso);
    const split = Math.min(splitDay(s), daysInMonth(y, m));
    return (y * 12 + (m - 1)) * 2 + (d < split ? 0 : 1);
  }

  // How many pay periods start after the one that contains asOf, through today.
  // That is how many times "accrues per pay period" is added (24 a year twice a
  // month, 26 or 27 every 2 weeks). Worked out directly, so there is no cap and
  // an old or mistyped "as of" date doesn't slow anything down.
  function accrualCount(asOf, today, s) {
    if (!validIso(asOf) || !validIso(today)) return 0;
    s = s || {};
    if (isSemi(s)) return Math.max(0, semiIndex(today, s) - semiIndex(asOf, s));
    const first = nextPeriod(payPeriodFor(asOf, s, today), s, today).start;
    if (first > today) return 0;
    return Math.floor(dayDiff(first, today) / 14) + 1;
  }

  // The start dates themselves (same count as accrualCount, no cap).
  function accrualStarts(asOf, today, s) {
    const n = accrualCount(asOf, today, s);
    const starts = [];
    if (!n) return starts;
    let p = nextPeriod(payPeriodFor(asOf, s, today), s, today);
    for (let i = 0; i < n; i++) {
      starts.push(p.start);
      p = nextPeriod(p, s, today);
    }
    return starts;
  }

  // What the home-screen widget needs to know about the current pay period.
  // periodEnd lets the widget tell when the period it was last told about is over.
  function widgetPeriod(s, todayIso) {
    const period = payPeriodFor(todayIso, s, todayIso);
    const goal = isSemi(s) ? periodGoalHours(period, s) : (+(s && s.ppHours) || 0);
    return { start: period.start, periodEnd: period.end, goalHours: goal, days: period.days };
  }
  // Same rule as WidgetProvider.periodLine on the phone: once today is past the
  // period end in the snapshot, the "hrs left" number is from an old period.
  function widgetPeriodStale(snap, todayIso) {
    return !!(snap && validIso(snap.periodEnd) && validIso(todayIso) && todayIso > snap.periodEnd);
  }

  return {
    payPeriodFor, nextPeriod, prevPeriod, biweeklyFromStart,
    workweeksIn, weekStart, overtimeByDay, periodGoalHours, weekGoalHours,
    accrualStarts, accrualCount, widgetPeriod, widgetPeriodStale, splitDay, splitHint, splitOption, isSemi,
    eachDay, addDays, dayDiff, validIso, daysInMonth,
    periodDefaults: { ppType: 'biweekly', ppSplit: 16, ppHoursSemi: '' },
  };
});
