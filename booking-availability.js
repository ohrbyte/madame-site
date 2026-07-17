(function (global) {
  const BUSINESS_TIME_ZONE = "America/New_York";
  const SLOT_START_HOUR = 9;
  const SLOT_END_HOUR = 18;
  const SLOT_INTERVAL_MINUTES = 15;
  const SAME_DAY_CUTOFF_MINUTES = 30;

  function zonedParts(date = new Date(), timeZone = BUSINESS_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
    };
  }

  function toDateKey(parts) {
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  function todayKey(now = new Date(), timeZone = BUSINESS_TIME_ZONE) {
    return toDateKey(zonedParts(now, timeZone));
  }

  function addDays(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days, 12));
    return toDateKey({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    });
  }

  function compareDateKeys(a, b) {
    return a.localeCompare(b);
  }

  function generateAvailableDates(options = {}) {
    const now = options.now || new Date();
    const timeZone = options.timeZone || BUSINESS_TIME_ZONE;
    const count = options.count || 21;
    const start = todayKey(now, timeZone);
    return Array.from({ length: count }, (_, index) => addDays(start, index));
  }

  function generateCalendarMonth(options = {}) {
    const now = options.now || new Date();
    const timeZone = options.timeZone || BUSINESS_TIME_ZONE;
    const today = todayKey(now, timeZone);
    const parts = zonedParts(now, timeZone);
    const year = options.year || parts.year;
    const month = options.month || parts.month;
    const firstDay = new Date(Date.UTC(year, month - 1, 1, 12));
    const daysInMonth = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
    const leadingBlanks = firstDay.getUTCDay();
    const cells = Array.from({ length: leadingBlanks }, () => ({ blank: true }));

    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = toDateKey({ year, month, day });
      cells.push({
        blank: false,
        dateKey,
        day,
        isPast: compareDateKeys(dateKey, today) < 0,
        isToday: dateKey === today,
      });
    }

    return {
      cells,
      monthLabel: formatMonthLabel(toDateKey({ year, month, day: 1 })),
      today,
    };
  }

  function minutesToLabel(minutes) {
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const period = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
  }

  function labelToMinutes(label) {
    const match = label.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return NaN;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = match[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }

  function allSlotMinutes() {
    const slots = [];
    for (let minutes = SLOT_START_HOUR * 60; minutes <= SLOT_END_HOUR * 60; minutes += SLOT_INTERVAL_MINUTES) {
      slots.push(minutes);
    }
    return slots;
  }

  function generateAvailableTimes(dateKey, options = {}) {
    const now = options.now || new Date();
    const timeZone = options.timeZone || BUSINESS_TIME_ZONE;
    const current = zonedParts(now, timeZone);
    const currentDateKey = toDateKey(current);
    const cutoff = current.hour * 60 + current.minute + SAME_DAY_CUTOFF_MINUTES;

    if (compareDateKeys(dateKey, currentDateKey) < 0) return [];

    return allSlotMinutes()
      .filter((minutes) => dateKey !== currentDateKey || minutes >= cutoff)
      .map((minutes) => ({ label: minutesToLabel(minutes), minutes }));
  }

  function formatDateLabel(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  }

  function formatMonthLabel(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  }

  function validateAppointment(dateKey, timeLabel, options = {}) {
    const allowed = generateAvailableTimes(dateKey, options).some((slot) => slot.label === timeLabel);
    return {
      ok: allowed,
      error: allowed ? "" : "Selected appointment time is no longer available. Please choose a future time.",
    };
  }

  const api = {
    BUSINESS_TIME_ZONE,
    SAME_DAY_CUTOFF_MINUTES,
    formatDateLabel,
    formatMonthLabel,
    generateAvailableDates,
    generateCalendarMonth,
    generateAvailableTimes,
    labelToMinutes,
    todayKey,
    validateAppointment,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.MadameAvailability = api;
})(typeof window !== "undefined" ? window : globalThis);
