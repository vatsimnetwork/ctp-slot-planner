const BASE = import.meta.env.BASE_URL;

export async function apiFetch(url, options = {}) {
  const res = await fetch(BASE + url.replace(/^\//, ''), { ...options, credentials: 'include' });
  if (res.status === 401) {
    window.location.href = BASE + 'login/?return_to=' + encodeURIComponent(window.location.pathname + window.location.search);
    throw new Error('Unauthorized');
  }
  return res;
}

export const API = {
  loadSetup:            () => apiFetch('/setup/'),
  loadSlots:            () => apiFetch('/slotgroups/'),
  save:                 (p) => apiFetch('/slotgroups/save/',      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  submit:               (p) => apiFetch('/slotgroups/submit/',    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  syncTime:             (v) => apiFetch('/synctime/',             { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) }),
  loadThroughputLimits: () => apiFetch('/throughput-limits/'),
  saveThroughputLimits: (p) => apiFetch('/throughput-limits/',    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
};
