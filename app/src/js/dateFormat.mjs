// The one date format the app shows: YYYY-MM-DD HH:MM, 24-hour, local time.
// Unambiguous in every locale and sorts as text — a session list read by a
// Swede, an American and a Brit must not show three different orders of the
// same three numbers.

const pad = n => String(n).padStart(2, '0');

function at(ms) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(ms) {
    const d = at(ms);
    return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
}

export function formatTime(ms) {
    const d = at(ms);
    return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

export function formatDateTime(ms) {
    const d = at(ms);
    return d ? `${formatDate(ms)} ${formatTime(ms)}` : '';
}
