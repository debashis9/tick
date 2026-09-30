// Reminders. A reminder is a notification, sent by the Tick Worker as an empty push at the
// chosen time. The Worker only keeps this device's push address, the reminder times with their
// weekdays, and the time zone. It never learns which habit a reminder is for or whether it
// was ticked: the service worker (sw.js) reads that from this device when the push arrives.

import { store, active, onLocalChange, saveSettings } from './store.js';
import { markPushTest } from './db.js';

// The public half of the Worker's VAPID key pair (the private half is a Worker secret).
const VAPID_PUBLIC_KEY = 'BIr5JHH9LOaCaVCLkj-IzHgvPsWXBfAxy6QLVNQFcW4cqMHtPCJeSw2a1kTJPjEQs8_NhZ82cksDgqAQmZ52HRU';

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const supported = () => 'serviceWorker' in navigator && 'PushManager' in self && 'Notification' in self;

// Why reminders can't work in this browser, or null if they can.
export function pushProblem() {
  if (supported()) return null;
  return isIOS ? 'On iPhone and iPad, reminders work once Tick is on your Home Screen: in Safari tap Share, then Add to Home Screen.'
    : "This browser can't show reminders.";
}

export const permission = () => supported() ? Notification.permission : 'unsupported';

const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// The service worker registration, or an error if it isn't running (ready would wait forever).
const registration = () => Promise.race([
  navigator.serviceWorker.ready,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker not ready')), 10_000)),
]);

async function subscription(create) {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (sub || !create) return sub;
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC_KEY) });
}

// Call straight from a tap: browsers only show the permission prompt in response to one.
// Returns a message to show if reminders can't be turned on, or null.
export async function enableReminders() {
  const problem = pushProblem();
  if (problem) return problem;
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') return 'Notifications are blocked for Tick. Allow them in your browser or phone settings, then try again.';
  try {
    await subscription(true);
  } catch (e) {
    console.warn(e);
    return navigator.onLine ? "This browser wouldn't turn on notifications." : 'Connect to the internet to turn on reminders.';
  }
  return null;
}

// One entry per reminder time: the weekdays that time is used on.
function slots() {
  const m = new Map();
  for (const h of active()) {
    if (!h.reminder) continue;
    const days = h.schedule.type === 'days' ? h.schedule.days : [0, 1, 2, 3, 4, 5, 6];
    m.set(h.reminder, new Set([...(m.get(h.reminder) || []), ...days]));
  }
  return [...m].sort(([a], [b]) => a < b ? -1 : 1).map(([t, d]) => ({ t, days: [...d].sort() }));
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}

// Tells the Worker the current reminder times, but only when they changed since the last
// successful call. Runs after every local change, at start-up (time zones change when
// travelling) and when the device comes back online.
async function sync() {
  if (!supported()) return;
  const want = slots();
  if (!want.length) {
    if (!store.settings.pushSynced) return;
    const sub = await subscription(false);
    if (sub) {
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    return saveSettings({ pushSynced: null });
  }
  if (Notification.permission !== 'granted') return;
  const sub = await subscription(true);
  const body = { endpoint: sub.endpoint, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, slots: want };
  const sig = JSON.stringify(body);
  if (sig === store.settings.pushSynced) return;
  await post('/api/push/subscribe', body);
  await saveSettings({ pushSynced: sig });
}

let queue = Promise.resolve();
export function syncReminders() {
  queue = queue.then(sync).catch(e => console.warn('Reminders not synced:', e));
  return queue;
}

export function startReminderSync() {
  onLocalChange(syncReminders);
  addEventListener('online', syncReminders);
  syncReminders();
}

// Sends a push to this device right now. The service worker sees the marker and says
// "Reminders are working" instead of listing habits.
export async function sendTest() {
  const sub = await subscription(false);
  if (!sub) throw new Error('No push subscription');
  await syncReminders();
  await markPushTest();
  await post('/api/push/test', { endpoint: sub.endpoint });
}

export const hasReminders = () => active().some(h => h.reminder);
