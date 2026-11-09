// Shared with the worker (worker/src/reminders.js): does a notification link carry a place?
// The client side (push reminders, routines, `#/notif` links) was removed in TEL-270; the worker still drops any
// `url` with `to/from/name/lat/lng` from older clients. No DOM, no imports.

// Coordinates or a place name anywhere in the URL (absolute or a bare hash): `to`, `from`, `name`, `lat`, `lng`.
const PRIVATE = /[?&](?:to|from|name|lat|lng)=/;
export const isPrivateUrl = (url) => typeof url === 'string' && PRIVATE.test(url);
